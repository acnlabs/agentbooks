'use strict';

const crypto = require('crypto');

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function nowISO() {
  return new Date().toISOString();
}

// ─── Ledger Entry ────────────────────────────────────────────────────────────

/**
 * Create a standardised ledger entry.
 *
 * @param {'cost'|'income'|'deposit'|'transfer'|'adjustment'} type
 * @param {string|null} channel  - expense channel (e.g. 'inference', 'runtime')
 * @param {number}      amount   - positive value in USD
 * @param {object}      opts
 * @param {string}      [opts.id]
 * @param {string}      [opts.currency='USD']
 * @param {string|null} [opts.model]      - LLM model name, for inference costs
 * @param {string|null} [opts.quality]    - 'low'|'medium'|'high', for income entries
 * @param {string}      [opts.note='']
 * @param {'agent'|'runner'|'provider_sync'} [opts.source='agent']
 *   - 'runner'        : written by economy-hook (Runner injected token counts)
 *   - 'provider_sync' : written by syncProvider (external provider balance change)
 *   - 'agent'         : written by Agent via manual record-cost / record-income
 * @param {string}      [opts.timestamp]
 */
function createLedgerEntry(type, channel, amount, opts = {}) {
  return {
    id:        opts.id        || crypto.randomUUID(),
    type,
    channel:   channel        || null,
    amount,
    currency:  opts.currency  || 'USD',
    model:     opts.model     || null,
    quality:   opts.quality   || null,
    note:      opts.note      || '',
    source:    opts.source    || 'agent',
    timestamp: opts.timestamp || nowISO(),
  };
}

// ─── Economic Identity ───────────────────────────────────────────────────────

/**
 * Initial identity config for an agent.
 * Stored in: economic-identity.json
 * Mode starts as 'development' — switches to 'production' on first wallet-connect.
 */
function createIdentityInitialState(agentId) {
  const now = nowISO();
  return {
    schema:    'agentbooks/economic-identity',
    version:   '1.0.0',
    agentId,
    mode:      'development',   // 'development' | 'production'
    walletAddress:   null,      // set by wallet-init (deterministic EVM address)
    primaryProvider: null,      // set by set-primary command
    modelPricing: {
      'claude-opus-4':         { input: 15.00, output: 75.00, thinking: 75.00 },
      'claude-sonnet-4':       { input:  3.00, output: 15.00, thinking: 15.00 },
      'claude-3-5-sonnet':     { input:  3.00, output: 15.00, thinking: 15.00 },
      'claude-3-5-haiku':      { input:  0.80, output:  4.00, thinking:  4.00 },
      'gpt-4o':                { input:  2.50, output: 10.00, thinking: 10.00 },
      'gpt-4o-mini':           { input:  0.15, output:  0.60, thinking:  0.60 },
      'gemini-2.0-flash':      { input:  0.10, output:  0.40, thinking:  0.40 },
      'gemini-2.5-pro':        { input:  1.25, output: 10.00, thinking: 10.00 },
      'default':               { input:  3.00, output: 15.00, thinking: 15.00 },
    },
    exchangeRates: {
      ETH:     2500,  // 1 ETH = 2500 USD (override as needed)
      credits: 0.01,  // 1 ACN credit = 0.01 USD
    },
    financialHealthCacheTTLMinutes: 60,
    providers: {
      'coinbase-cdp': { enabled: false, authenticated: false },
      acn:            { enabled: false, acnAgentId: null },
      onchain:        { enabled: false, rpc: null, network: 'base' },
    },
    createdAt: now,
  };
}

// ─── Economic State ──────────────────────────────────────────────────────────

/**
 * Initial financial state for an agent.
 * Stored in: economic-state.json
 *
 * Key design decisions:
 * - No 'local' provider (removed — fabricated data not allowed)
 * - openingBalance in currentPeriod enables cash flow reconciliation
 * - financialHealth is a TTL-cached computed field, not source of truth
 * - integrityWarnings is append-only (never cleared by CLI)
 */
function createInitialState(agentId) {
  const now   = nowISO();
  const today = todayUTC();
  return {
    schema:  'agentbooks/economic-state',
    version: '1.0.0',
    agentId,

    balanceSheet: {
      assets: {
        providers: {
          'coinbase-cdp': { USDC: 0.0, ETH: 0.0, network: 'base', lastSynced: null },
          acn:            { credits: 0.0, lastSynced: null },
          onchain:        { USDC: 0.0, ETH: 0.0, network: 'base', lastSynced: null },
        },
        totalUSDEquivalent: 0.0,   // recalculated by reconcile.validateState()
      },
      primaryProvider:     null,
      operationalBalance:  0.0,    // mirror of primary provider balance; dev mode allows negative
      operationalCurrency: 'USD',
      liabilities: {
        accountsPayable: [],       // [{id, creditor, amount, currency, dueAt, status}]
        total:           0.0,
      },
      equity: {
        value: 0.0,                // recalculated by validateState: assets.total - liabilities.total
      },
    },

    incomeStatement: {
      currentPeriod: {
        periodStart:    today,
        periodEnd:      null,
        openingBalance: 0.0,       // snapshot of operationalBalance at period start (for cash flow check)
        revenue:        0.0,
        expenses: {
          inference: { llm: {} }, // dynamic: inference.llm.<model>.{input,output,thinking}
          runtime:   { compute: 0.0, storage: 0.0, bandwidth: 0.0 },
          faculty:   {},
          skill:     {},
          agent:     { acn: 0.0, a2a: 0.0 },
          custom:    {},
          total:     0.0,
        },
        netIncome: 0.0,
      },
      periodHistory: [],           // capped at 12; oldest removed on rollover
      allTime: {
        totalRevenue:  0.0,
        totalExpenses: 0.0,
        netIncome:     0.0,        // recalculated on rollover (not cumulative add)
      },
    },

    burnRateHistory: [],           // [{timestamp, sessionCost, dailyRateEstimate, model}]; capped at 90

    financialHealth: {             // TTL-cached; updated by economy-hook and economy-guard
      tier:           'uninitialized',
      score:          0.0,
      diagnosis:      'no_real_provider',
      prescriptions:  ['connect_real_provider'],
      daysToDepletion: null,
      dominantCost:   null,
      trend:          'stable',
      computedAt:     null,
    },

    ledger:           [],          // capped at 500
    integrityWarnings: [],         // append-only; never cleared by CLI

    createdAt:     now,
    lastUpdatedAt: now,
  };
}

module.exports = {
  createInitialState,
  createIdentityInitialState,
  createLedgerEntry,
  todayUTC,
  nowISO,
};
