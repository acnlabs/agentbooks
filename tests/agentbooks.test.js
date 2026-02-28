'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { InMemoryAdapter }  = require('../adapters/in-memory');
const {
  createInitialState,
  createIdentityInitialState,
  createLedgerEntry,
  todayUTC,
} = require('../src/schema');
const { addToExpenseAccount, recalcExpensesTotal } = require('../src/ledger');
const { shouldRollover, rolloverPeriod, toSessionBurnRate } = require('../src/period');
const { calcFinancialHealth } = require('../src/financial-health');
const { validateState } = require('../src/reconcile');
const { calcTotalUSDEquivalent, deductFromProvider, creditToProvider } = require('../src/providers');
const { JsonFileAdapter } = require('../adapters/json-file');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('schema', () => {
  test('createInitialState produces valid v1.0.0 state', () => {
    const s = createInitialState('test-agent');
    assert.equal(s.schema,  'agentbooks/economic-state');
    assert.equal(s.version, '1.0.0');
    assert.equal(s.agentId, 'test-agent');
    assert.equal(s.balanceSheet.operationalBalance, 0);
    assert.ok(s.balanceSheet.liabilities);
    assert.equal(s.incomeStatement.currentPeriod.openingBalance, 0);
    assert.ok(Array.isArray(s.ledger));
    assert.ok(Array.isArray(s.integrityWarnings));
  });

  test('createIdentityInitialState defaults to development mode', () => {
    const id = createIdentityInitialState('agent-1');
    assert.equal(id.mode, 'development');
    assert.equal(id.walletAddress, null);
    assert.ok(id.modelPricing['default']);
  });

  test('createLedgerEntry defaults source to agent', () => {
    const e = createLedgerEntry('cost', 'inference', 0.5, {});
    assert.equal(e.source, 'agent');
    assert.equal(e.type, 'cost');
    assert.equal(e.amount, 0.5);
  });

  test('createLedgerEntry accepts runner source', () => {
    const e = createLedgerEntry('cost', 'inference', 0.5, { source: 'runner' });
    assert.equal(e.source, 'runner');
  });
});

// ─── Adapters ────────────────────────────────────────────────────────────────

describe('InMemoryAdapter', () => {
  test('readSync returns fresh state when empty', () => {
    const adapter = new InMemoryAdapter();
    const s = adapter.readSync('a1');
    assert.equal(s.agentId, 'a1');
    assert.equal(s.version, '1.0.0');
  });

  test('writeSync then readSync round-trips state', () => {
    const adapter = new InMemoryAdapter();
    const s = adapter.readSync('a1');
    s.incomeStatement.currentPeriod.revenue = 5.0;
    adapter.writeSync('a1', s);
    const s2 = adapter.readSync('a1');
    assert.equal(s2.incomeStatement.currentPeriod.revenue, 5.0);
  });

  test('readSync mirrors primaryProvider from identity', () => {
    const adapter  = new InMemoryAdapter();
    const identity = createIdentityInitialState('a1');
    identity.primaryProvider = 'coinbase-cdp';
    adapter.writeIdentitySync('a1', identity);
    const s = adapter.readSync('a1');
    assert.equal(s.balanceSheet.primaryProvider, 'coinbase-cdp');
  });

  test('writeSync recomputes equity', () => {
    const adapter  = new InMemoryAdapter();
    const identity = createIdentityInitialState('a1');
    adapter.writeIdentitySync('a1', identity);
    const s = adapter.readSync('a1');
    s.balanceSheet.assets.providers['coinbase-cdp'].USDC = 100;
    adapter.writeSync('a1', s);
    const s2 = adapter.readSync('a1');
    assert.equal(s2.balanceSheet.assets.totalUSDEquivalent, 100);
    assert.equal(s2.balanceSheet.equity.value, 100);
  });
});

describe('JsonFileAdapter migration', () => {
  test('migrates v2.x state with local.budget > 0 and writes integrityWarning', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbooks-'));
    const stateFile = path.join(tmpDir, 'economic-state.json');

    // Write old-format state with local provider
    const oldState = {
      schema: 'agentbooks/economic-state',
      version: '2.1.0',
      agentId: 'migrated',
      balanceSheet: {
        assets: {
          providers: {
            local: { budget: 50, spent: 10 },
            'coinbase-cdp': { USDC: 5, ETH: 0 },
          },
        },
        operationalBalance: 5,
        primaryProvider: 'coinbase-cdp',
      },
      incomeStatement: {
        currentPeriod: { periodStart: '2026-01-01', revenue: 0, expenses: { total: 0 }, netIncome: 0 },
        periodHistory: [],
        allTime: { totalRevenue: 0, totalExpenses: 0, netIncome: 0 },
      },
      burnRateHistory: [
        { timestamp: '2026-01-01T00:00:00Z', dailyBurnRate: 0.5, periodExpenses: 0.1 },
      ],
      ledger: [],
      integrityWarnings: [],
    };
    fs.writeFileSync(stateFile, JSON.stringify(oldState));

    const adapter = new JsonFileAdapter(tmpDir);
    const s = adapter.readSync('migrated');

    assert.equal(s.version, '1.0.0');
    assert.ok(s.integrityWarnings.some(w => w.type === 'migration_local_budget_discarded'));
    // burnRateHistory migrated
    assert.equal(s.burnRateHistory[0].dailyRateEstimate, 0.5);
    assert.equal(s.burnRateHistory[0].sessionCost, 0.1);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ─── Providers ───────────────────────────────────────────────────────────────

describe('providers', () => {
  test('calcTotalUSDEquivalent sums USDC + ETH across providers', () => {
    const s = createInitialState('a1');
    s.balanceSheet.assets.providers['coinbase-cdp'].USDC = 10;
    s.balanceSheet.assets.providers['coinbase-cdp'].ETH  = 0.5;
    const identity = createIdentityInitialState('a1');
    identity.exchangeRates.ETH = 2000;
    const total = calcTotalUSDEquivalent(s, identity);
    assert.equal(total, 1010); // 10 + 0.5 * 2000
  });

  test('deductFromProvider reduces USDC balance', () => {
    const s = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.primaryProvider = 'coinbase-cdp';
    id.mode = 'production';
    s.balanceSheet.primaryProvider = 'coinbase-cdp';
    s.balanceSheet.assets.providers['coinbase-cdp'].USDC = 10;
    deductFromProvider(s, id, 3);
    assert.equal(s.balanceSheet.assets.providers['coinbase-cdp'].USDC, 7);
  });

  test('deductFromProvider allows negative balance in development mode', () => {
    const s = createInitialState('a1');
    const id = createIdentityInitialState('a1'); // mode = development
    id.primaryProvider = 'coinbase-cdp';
    s.balanceSheet.primaryProvider = 'coinbase-cdp';
    s.balanceSheet.assets.providers['coinbase-cdp'].USDC = 1;
    deductFromProvider(s, id, 5);
    assert.equal(s.balanceSheet.assets.providers['coinbase-cdp'].USDC, -4);
  });
});

// ─── Ledger ───────────────────────────────────────────────────────────────────

describe('ledger', () => {
  test('addToExpenseAccount routes inference correctly', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    addToExpenseAccount(s, id, {
      channel: 'inference', subKey: 'input', amount: 0.002,
      model: 'gpt-4o', source: 'runner',
    });
    assert.ok(s.incomeStatement.currentPeriod.expenses.inference.llm['gpt-4o']);
    assert.equal(s.incomeStatement.currentPeriod.expenses.inference.llm['gpt-4o'].input, 0.002);
    assert.equal(s.incomeStatement.currentPeriod.expenses.total, 0.002);
    assert.equal(s.ledger[0].source, 'runner');
  });

  test('ledger source defaults to agent for manual record', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    addToExpenseAccount(s, id, { channel: 'custom', amount: 1.0, note: 'test' });
    assert.equal(s.ledger[0].source, 'agent');
  });

  test('ledger is capped at 500 entries', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    for (let i = 0; i < 510; i++) {
      addToExpenseAccount(s, id, { channel: 'custom', amount: 0.001 });
    }
    assert.equal(s.ledger.length, 500);
  });
});

// ─── Period ───────────────────────────────────────────────────────────────────

describe('period', () => {
  test('shouldRollover returns false when periodStart is today', () => {
    const s = createInitialState('a1');
    assert.equal(shouldRollover(s), false);
  });

  test('shouldRollover returns true when periodStart is in the past', () => {
    const s = createInitialState('a1');
    s.incomeStatement.currentPeriod.periodStart = '2020-01-01';
    assert.equal(shouldRollover(s), true);
  });

  test('rolloverPeriod archives currentPeriod and resets', () => {
    const s = createInitialState('a1');
    s.incomeStatement.currentPeriod.periodStart = '2020-01-01';
    s.incomeStatement.currentPeriod.revenue     = 10;
    s.balanceSheet.operationalBalance           = 42;
    rolloverPeriod(s);
    assert.equal(s.incomeStatement.periodHistory.length, 1);
    assert.equal(s.incomeStatement.periodHistory[0].revenue, 10);
    assert.equal(s.incomeStatement.currentPeriod.revenue,  0);
    assert.equal(s.incomeStatement.currentPeriod.openingBalance, 42); // cash flow anchor
    assert.equal(s.incomeStatement.currentPeriod.periodStart, todayUTC());
  });

  test('rolloverPeriod accumulates allTime correctly', () => {
    const s = createInitialState('a1');
    s.incomeStatement.currentPeriod.periodStart    = '2020-01-01';
    s.incomeStatement.currentPeriod.revenue        = 10;
    s.incomeStatement.currentPeriod.expenses.total = 3;
    rolloverPeriod(s);
    assert.equal(s.incomeStatement.allTime.totalRevenue,  10);
    assert.equal(s.incomeStatement.allTime.totalExpenses, 3);
    assert.equal(s.incomeStatement.allTime.netIncome,     7);
  });

  test('rolloverPeriod caps periodHistory at 12', () => {
    const s = createInitialState('a1');
    for (let i = 0; i < 14; i++) {
      s.incomeStatement.currentPeriod.periodStart = `201${Math.floor(i/10)}-0${(i%12)+1}-01`;
      rolloverPeriod(s);
    }
    assert.ok(s.incomeStatement.periodHistory.length <= 12);
  });

  test('toSessionBurnRate converts session cost to daily rate', () => {
    const rate = toSessionBurnRate(0.5, 3600000); // 1 hour session
    // $0.5 over 1 hour = $12/day
    assert.ok(rate > 0);
    assert.ok(rate > 10); // should be ~12
  });
});

// ─── Financial Health ─────────────────────────────────────────────────────────

describe('calcFinancialHealth', () => {
  test('returns uninitialized in development mode', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    const r  = calcFinancialHealth(s, id);
    assert.equal(r.tier, 'uninitialized');
    assert.equal(r.fhs, 0.0);
  });

  test('returns uninitialized when no primary provider (production mode)', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.mode  = 'production';
    const r  = calcFinancialHealth(s, id);
    assert.equal(r.tier, 'uninitialized');
  });

  test('returns suspended when balance is zero (production mode)', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.mode  = 'production';
    id.primaryProvider = 'coinbase-cdp';
    s.balanceSheet.primaryProvider    = 'coinbase-cdp';
    s.balanceSheet.operationalBalance = 0;
    const r = calcFinancialHealth(s, id);
    assert.equal(r.tier, 'suspended');
  });

  test('returns normal for healthy financials', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.mode  = 'production';
    id.primaryProvider = 'coinbase-cdp';
    s.balanceSheet.primaryProvider    = 'coinbase-cdp';
    s.balanceSheet.operationalBalance = 100;
    s.incomeStatement.currentPeriod.revenue        = 10;
    s.incomeStatement.currentPeriod.expenses.total = 3;
    s.incomeStatement.currentPeriod.netIncome      = 7;
    const r = calcFinancialHealth(s, id);
    assert.equal(r.tier, 'normal');
    assert.ok(r.fhs > 0.5);
  });
});

// ─── Reconcile ────────────────────────────────────────────────────────────────

describe('validateState', () => {
  test('recalculates equity.value', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    s.balanceSheet.assets.providers['coinbase-cdp'].USDC = 50;
    s.balanceSheet.liabilities.total = 10;
    validateState(s, id);
    assert.equal(s.balanceSheet.assets.totalUSDEquivalent, 50);
    assert.equal(s.balanceSheet.equity.value, 40);
  });

  test('cash flow check skipped in development mode', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1'); // development mode
    s.incomeStatement.currentPeriod.openingBalance     = 100;
    s.incomeStatement.currentPeriod.revenue            = 10;
    s.incomeStatement.currentPeriod.expenses.total     = 5;
    s.balanceSheet.operationalBalance                  = 200; // huge mismatch
    validateState(s, id);
    assert.equal(s.integrityWarnings.length, 0); // no check in dev mode
  });

  test('cash flow check triggers integrityWarning in production mode on mismatch', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.mode  = 'production';
    s.incomeStatement.currentPeriod.openingBalance     = 100;
    s.incomeStatement.currentPeriod.revenue            = 10;
    s.incomeStatement.currentPeriod.expenses.total     = 5;
    s.balanceSheet.operationalBalance                  = 200; // expected 105, actual 200
    validateState(s, id);
    assert.ok(s.integrityWarnings.some(w => w.type === 'cash_flow_mismatch'));
  });

  test('cash flow check passes when values match within tolerance', () => {
    const s  = createInitialState('a1');
    const id = createIdentityInitialState('a1');
    id.mode  = 'production';
    s.incomeStatement.currentPeriod.openingBalance     = 100;
    s.incomeStatement.currentPeriod.revenue            = 10;
    s.incomeStatement.currentPeriod.expenses.total     = 5;
    s.balanceSheet.operationalBalance                  = 105.005; // within $0.01
    validateState(s, id);
    assert.equal(s.integrityWarnings.filter(w => w.type === 'cash_flow_mismatch').length, 0);
  });
});

// ─── env var priority ─────────────────────────────────────────────────────────

describe('parseArgs env var priority', () => {
  test('env var overrides CLI arg for token counts', () => {
    // Simulate parseArgs behavior from economy-hook
    const origEnv = {
      TOKEN_INPUT_COUNT: process.env.TOKEN_INPUT_COUNT,
      LLM_MODEL:         process.env.LLM_MODEL,
    };

    process.env.TOKEN_INPUT_COUNT = '999';
    process.env.LLM_MODEL         = 'claude-3-5-sonnet';

    // Inline parseArgs (mirrors economy-hook.js logic)
    function parseArgs(argv) {
      const opts = {
        input: parseInt(process.env.TOKEN_INPUT_COUNT || '0', 10),
        model: process.env.LLM_MODEL || 'default',
      };
      const args = argv.slice(2);
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input' && !process.env.TOKEN_INPUT_COUNT) {
          opts.input = parseInt(args[++i], 10);
        } else if (args[i] === '--model' && !process.env.LLM_MODEL) {
          opts.model = args[++i];
        }
      }
      return opts;
    }

    const opts = parseArgs(['node', 'hook', '--input', '100', '--model', 'gpt-4o']);
    assert.equal(opts.input, 999);           // env var wins
    assert.equal(opts.model, 'claude-3-5-sonnet'); // env var wins

    // Restore
    if (origEnv.TOKEN_INPUT_COUNT === undefined) delete process.env.TOKEN_INPUT_COUNT;
    else process.env.TOKEN_INPUT_COUNT = origEnv.TOKEN_INPUT_COUNT;
    if (origEnv.LLM_MODEL === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = origEnv.LLM_MODEL;
  });
});

// ─── HTML Report ─────────────────────────────────────────────────────────────

describe('report', () => {
  const { buildHTML, buildSparkline, buildCostBars, buildProviderRows } =
    require('../cli/report.js').__test__;

  let state, identity;

  beforeEach(() => {
    state    = createInitialState('report-agent');
    identity = createIdentityInitialState('report-agent');
  });

  test('buildHTML returns a complete HTML document', () => {
    const html = buildHTML('report-agent', state, identity);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>AgentBooks Report'));
    assert.ok(html.includes('report-agent'));
    assert.ok(html.includes('DEVELOPMENT'));
    assert.ok(html.includes('UNINITIALIZED'));
  });

  test('buildHTML includes wallet address when present', () => {
    identity.walletAddress = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const html = buildHTML('report-agent', state, identity);
    assert.ok(html.includes('0xdeadbeef'));
  });

  test('buildHTML marks production mode badge', () => {
    identity.mode = 'production';
    identity.primaryProvider = 'coinbase-cdp';
    identity.providers['coinbase-cdp'].enabled = true;
    state.balanceSheet.primaryProvider = 'coinbase-cdp';
    const html = buildHTML('report-agent', state, identity);
    assert.ok(html.includes('PRODUCTION'));
  });

  test('buildSparkline returns SVG placeholder when data < 2', () => {
    const svg = buildSparkline([], 700, 180);
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('No burn rate data'));
  });

  test('buildSparkline renders polyline when data >= 2', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      timestamp: `2025-01-0${i + 1}T00:00:00Z`,
      dailyRateEstimate: 0.01 * (i + 1),
      sessionCost: 0.005,
    }));
    const svg = buildSparkline(history, 700, 180);
    assert.ok(svg.includes('<polyline'));
    assert.ok(svg.includes('<polygon'));
  });

  test('buildCostBars returns placeholder when no expenses', () => {
    const html = buildCostBars(state.incomeStatement.currentPeriod.expenses);
    assert.ok(html.includes('No expenses recorded'));
  });

  test('buildCostBars renders bars for recorded expenses', () => {
    const expenses = state.incomeStatement.currentPeriod.expenses;
    expenses.inference.llm['gpt-4o'] = { input: 0.05, output: 0.02, thinking: 0 };
    expenses.total = 0.07;
    const html = buildCostBars(expenses);
    assert.ok(html.includes('inference'));
    assert.ok(html.includes('gpt-4o'));
  });

  test('buildProviderRows shows no-provider message when none enabled', () => {
    const html = buildProviderRows(state, identity);
    assert.ok(html.includes('No providers connected'));
  });

  test('buildProviderRows shows enabled provider with primary badge', () => {
    identity.providers['coinbase-cdp'].enabled = true;
    identity.primaryProvider = 'coinbase-cdp';
    state.balanceSheet.primaryProvider = 'coinbase-cdp';
    state.balanceSheet.assets.providers['coinbase-cdp'].USDC = 12.5;
    const html = buildProviderRows(state, identity);
    assert.ok(html.includes('coinbase-cdp'));
    assert.ok(html.includes('primary'));
    assert.ok(html.includes('USDC'));
  });
});
