#!/usr/bin/env node
'use strict';

/**
 * economy.js — full AgentBooks management CLI
 *
 * All commands are available to Agents (no access tiering).
 * Agents are economic principals of their own accounts.
 * Code-level idempotency protects against accidental misuse.
 *
 * Commands:
 *   wallet-init                    Generate deterministic EVM address (idempotent)
 *   wallet-connect --provider <n>  Enable a real provider (switches to production mode)
 *   set-primary    --provider <n>  Set primary provider
 *   sync           [--provider <n>]  Sync balance from provider
 *   record-cost    --channel <c> --amount <a> [--note <n>]
 *   record-income  --amount <a> --quality <q> --confirmed [--note <n>]
 *   balance                        Asset balance sheet
 *   status                         Full financial report (includes cash flow check)
 *   pl                             Current period income statement
 *   financial-health               FHS tier (real-time, no TTL cache)
 *   ledger         [--limit <n>]   Transaction ledger
 */

const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const {
  createInitialState,
  createIdentityInitialState,
  createLedgerEntry,
} = require('../src/schema');
const { addToExpenseAccount }  = require('../src/ledger');
const { calcFinancialHealth }  = require('../src/financial-health');
const {
  syncProvider, setProviderBalance, getProviderBalance, calcTotalUSDEquivalent,
} = require('../src/providers');
const { appendLedger }         = require('../src/ledger');
const { JsonFileAdapter }      = require('../adapters/json-file');

// ─── Config ───────────────────────────────────────────────────────────────────

function resolveConfig() {
  const agentId  = process.env.AGENTBOOKS_AGENT_ID || 'default';
  const dataPath = process.env.AGENTBOOKS_DATA_PATH
    || path.join(os.homedir(), '.agentbooks', agentId);
  return { agentId, dataPath };
}

// ─── Arg helpers ─────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1]) ? args[i + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdWalletInit(adapter, agentId) {
  let identity = adapter.readIdentitySync(agentId);
  if (identity && identity.walletAddress) {
    console.log(`Wallet already initialized: ${identity.walletAddress}`);
    return;
  }
  if (!identity) identity = createIdentityInitialState(agentId);

  // Deterministic EVM address derived from agentId via SHA-256
  const hash = crypto.createHash('sha256').update(agentId).digest('hex');
  identity.walletAddress = '0x' + hash.slice(0, 40);
  adapter.writeIdentitySync(agentId, identity);

  // Ensure state file exists
  const state = adapter.readSync(agentId);
  adapter.writeSync(agentId, state);

  console.log(`Wallet initialized: ${identity.walletAddress}`);
}

function cmdWalletConnect(adapter, agentId, args) {
  const providerName = getArg(args, '--provider');
  if (!providerName) { console.error('Usage: wallet-connect --provider <name>'); process.exit(1); }

  let identity = adapter.readIdentitySync(agentId);
  if (!identity) { console.error('Run wallet-init first'); process.exit(1); }

  const prov = identity.providers[providerName];
  if (!prov) { console.error(`Unknown provider: ${providerName}`); process.exit(1); }

  // Mark as enabled (real SDK authentication would happen here)
  prov.enabled       = true;
  prov.authenticated = true;

  // Auto-switch to production mode on first real provider connection
  if (identity.mode === 'development') {
    identity.mode = 'production';
    console.log('Mode switched to production — financial health scoring now active.');
  }

  adapter.writeIdentitySync(agentId, identity);
  console.log(`Connected provider: ${providerName}`);
}

function cmdSetPrimary(adapter, agentId, args) {
  const providerName = getArg(args, '--provider');
  if (!providerName) { console.error('Usage: set-primary --provider <name>'); process.exit(1); }

  let identity = adapter.readIdentitySync(agentId);
  if (!identity) { console.error('Run wallet-init first'); process.exit(1); }

  identity.primaryProvider = providerName;
  adapter.writeIdentitySync(agentId, identity);

  const state = adapter.readSync(agentId); // readSync mirrors primaryProvider
  adapter.writeSync(agentId, state);
  console.log(`Primary provider set to: ${providerName}`);
}

function cmdSync(adapter, agentId, args) {
  const providerName = getArg(args, '--provider');
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);
  const target   = providerName || state.balanceSheet.primaryProvider;

  if (!target) { console.error('No primary provider set. Use set-primary first.'); process.exit(1); }

  const balance = syncProvider(state, identity, target);
  state.balanceSheet.operationalBalance = balance;
  adapter.writeSync(agentId, state);
  console.log(`Synced ${target}: ${balance.toFixed(4)} USD`);
}

function cmdRecordCost(adapter, agentId, args) {
  const channel = getArg(args, '--channel') || 'custom';
  const amount  = parseFloat(getArg(args, '--amount') || '0');
  const note    = getArg(args, '--note')    || '';

  if (amount <= 0) { console.error('--amount must be a positive number'); process.exit(1); }

  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);

  addToExpenseAccount(state, identity, { channel, amount, note, source: 'agent' });
  adapter.writeSync(agentId, state);
  console.log(`Recorded cost: ${amount.toFixed(4)} USD  channel=${channel}`);
}

function cmdRecordIncome(adapter, agentId, args) {
  const amount    = parseFloat(getArg(args, '--amount')  || '0');
  const quality   = getArg(args, '--quality')             || 'medium';
  const confirmed = hasFlag(args, '--confirmed');
  const note      = getArg(args, '--note')               || '';

  if (amount <= 0) { console.error('--amount must be a positive number'); process.exit(1); }

  // --confirmed is required to record revenue (prevents accidental entries)
  if (!confirmed) {
    console.error('Error: --confirmed flag required to record income. Use --confirmed to confirm this income is real.');
    process.exit(1);
  }

  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);

  state.incomeStatement.currentPeriod.revenue =
    parseFloat((state.incomeStatement.currentPeriod.revenue + amount).toFixed(6));
  state.incomeStatement.currentPeriod.netIncome =
    parseFloat((state.incomeStatement.currentPeriod.revenue -
                state.incomeStatement.currentPeriod.expenses.total).toFixed(6));

  const entry = createLedgerEntry('income', null, amount, { quality, note, source: 'agent' });
  state.ledger.push(entry);
  if (state.ledger.length > 500) state.ledger.splice(0, state.ledger.length - 500);

  adapter.writeSync(agentId, state);
  console.log(`Recorded income: ${amount.toFixed(4)} USD  quality=${quality}`);
}

function cmdBalance(adapter, agentId) {
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);
  const bs       = state.balanceSheet;

  console.log('=== BALANCE SHEET ===');
  console.log(`Agent: ${agentId}`);
  console.log('');
  console.log('--- Assets ---');
  const providers = bs.assets.providers;
  for (const [name, p] of Object.entries(providers)) {
    const bal = getProviderBalance(state, identity, name);
    if (p.USDC !== undefined) {
      console.log(`  ${name.padEnd(14)} USDC=${p.USDC.toFixed(4)}  ETH=${(p.ETH||0).toFixed(6)}  (~${bal.toFixed(4)} USD)`);
    } else if (p.credits !== undefined) {
      console.log(`  ${name.padEnd(14)} credits=${p.credits.toFixed(2)}  (~${bal.toFixed(4)} USD)`);
    }
  }
  console.log(`  Total Assets:    ${bs.assets.totalUSDEquivalent.toFixed(4)} USD`);
  console.log('');
  console.log('--- Liabilities ---');
  console.log(`  Total:           ${(bs.liabilities && bs.liabilities.total || 0).toFixed(4)} USD`);
  console.log('');
  console.log('--- Equity ---');
  console.log(`  Value:           ${bs.equity.value.toFixed(4)} USD`);
  console.log('=====================');
}

function cmdStatus(adapter, agentId) {
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);
  // Write initial state file if it doesn't exist yet
  adapter.writeSync(agentId, state);
  const fh       = state.financialHealth;
  const bs       = state.balanceSheet;
  const cp       = state.incomeStatement.currentPeriod;
  const at       = state.incomeStatement.allTime;

  const mode = (identity && identity.mode) || 'development';

  console.log('=== FINANCIAL STATUS ===');
  console.log(`Agent:            ${agentId}`);

  if (mode === 'development') {
    console.log('Financial Health: UNINITIALIZED  (development mode — connect a real provider)');
  } else {
    console.log(`Financial Health: ${fh.tier.toUpperCase()}  score=${(fh.score * 100).toFixed(1)}%`);
    console.log(`Diagnosis:        ${fh.diagnosis}`);
    console.log(`Prescriptions:    ${(fh.prescriptions || []).join(', ')}`);
  }

  if (bs.primaryProvider) {
    const wallet = (identity && identity.walletAddress) || 'not initialized';
    console.log(`Address:          ${wallet}  (${bs.primaryProvider})`);
  }
  console.log('');

  // Balance sheet
  console.log('--- Balance Sheet ---');
  console.log(`  Operational:    ${bs.operationalBalance.toFixed(4)} ${bs.operationalCurrency}  (${bs.primaryProvider || 'no provider'})`);
  if (fh.daysToDepletion !== null && fh.daysToDepletion !== undefined) {
    console.log(`  Days Remaining: ${fh.daysToDepletion}`);
  }
  console.log(`  Total Assets:   ${bs.assets.totalUSDEquivalent.toFixed(4)} USD`);
  console.log(`  Liabilities:    ${(bs.liabilities && bs.liabilities.total || 0).toFixed(4)} USD`);
  console.log(`  Equity:         ${bs.equity.value.toFixed(4)} USD`);
  console.log('');

  // Income statement
  console.log(`--- Income Statement (period: ${cp.periodStart}) ---`);
  console.log(`  Revenue:        ${cp.revenue.toFixed(4)}`);
  console.log(`  Expenses:       ${cp.expenses.total.toFixed(4)}`);
  console.log(`  Net Income:     ${cp.netIncome.toFixed(4)}`);
  console.log('');

  // Cash Flow Check (production only)
  if (mode === 'production' && cp.openingBalance !== null && cp.openingBalance !== undefined) {
    const expected = cp.openingBalance + cp.revenue - cp.expenses.total;
    const actual   = bs.operationalBalance;
    const delta    = Math.abs(expected - actual);
    const check    = delta <= 0.01 ? '✓' : '✗';
    console.log('--- Cash Flow Check ---');
    console.log(`  Opening Balance: ${cp.openingBalance.toFixed(4)} USD`);
    console.log(`  + Revenue:        ${cp.revenue.toFixed(4)}`);
    console.log(`  - Expenses:       ${cp.expenses.total.toFixed(4)}`);
    console.log(`  = Expected:      ${expected.toFixed(4)}`);
    console.log(`  Actual Balance:  ${actual.toFixed(4)}  ${check} (Δ ${delta.toFixed(4)})`);
    console.log('');
  }

  // Cost breakdown
  const exp = cp.expenses;
  if (exp.total > 0) {
    console.log('--- Cost Breakdown ---');
    let inferenceTotal = 0;
    for (const [model, costs] of Object.entries(exp.inference.llm || {})) {
      const modelTotal = (costs.input || 0) + (costs.output || 0) + (costs.thinking || 0);
      inferenceTotal += modelTotal;
    }
    if (inferenceTotal > 0) {
      const pct = (inferenceTotal / exp.total * 100).toFixed(1);
      console.log(`  inference: ${inferenceTotal.toFixed(4)}  (${pct}%)`);
      for (const [model, costs] of Object.entries(exp.inference.llm || {})) {
        if (costs.input)    console.log(`    ${model}.input:    ${costs.input.toFixed(4)}`);
        if (costs.output)   console.log(`    ${model}.output:   ${costs.output.toFixed(4)}`);
        if (costs.thinking) console.log(`    ${model}.thinking: ${costs.thinking.toFixed(4)}`);
      }
    }
    const runtimeTotal = Object.values(exp.runtime || {}).reduce((a, b) => a + b, 0);
    if (runtimeTotal > 0) {
      console.log(`  runtime:   ${runtimeTotal.toFixed(4)}  (${(runtimeTotal / exp.total * 100).toFixed(1)}%)`);
    }
    console.log('');
  }

  // All time
  console.log('--- All Time ---');
  console.log(`  Revenue:    ${at.totalRevenue.toFixed(4)}`);
  console.log(`  Expenses:   ${at.totalExpenses.toFixed(4)}`);
  console.log(`  Net Income: ${at.netIncome.toFixed(4)}`);
  console.log('========================');
}

function cmdPL(adapter, agentId) {
  const state = adapter.readSync(agentId);
  const cp    = state.incomeStatement.currentPeriod;
  const exp   = cp.expenses;

  console.log(`=== P&L (period: ${cp.periodStart}) ===`);
  console.log(`  Revenue:    ${cp.revenue.toFixed(4)} USD`);
  console.log(`  Expenses:   ${exp.total.toFixed(4)} USD`);
  console.log(`  Net Income: ${cp.netIncome.toFixed(4)} USD`);
  console.log('');
  console.log('  Cost Breakdown:');
  for (const [model, costs] of Object.entries(exp.inference.llm || {})) {
    const t = (costs.input || 0) + (costs.output || 0) + (costs.thinking || 0);
    if (t > 0) console.log(`    inference/${model}: ${t.toFixed(4)}`);
  }
  for (const [k, v] of Object.entries(exp.runtime || {})) {
    if (v > 0) console.log(`    runtime/${k}: ${v.toFixed(4)}`);
  }
  for (const ch of ['faculty', 'skill', 'agent', 'custom']) {
    for (const [k, v] of Object.entries(exp[ch] || {})) {
      if (typeof v === 'number' && v > 0) console.log(`    ${ch}/${k}: ${v.toFixed(4)}`);
    }
  }
  console.log('===========================');
}

function cmdFinancialHealth(adapter, agentId) {
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);
  const result   = calcFinancialHealth(state, identity);
  console.log(`tier=${result.tier}  score=${(result.fhs * 100).toFixed(1)}%`);
  console.log(`diagnosis=${result.diagnosis}`);
  console.log(`prescriptions=${result.prescriptions.join(', ')}`);
  if (result.daysToDepletion !== null) console.log(`daysToDepletion=${result.daysToDepletion}`);
  console.log(`trend=${result.trend}`);
}

function cmdLedger(adapter, agentId, args) {
  const limit  = parseInt(getArg(args, '--limit') || '20', 10);
  const state  = adapter.readSync(agentId);
  const entries = state.ledger.slice(-limit);
  console.log(`=== LEDGER (last ${entries.length}) ===`);
  for (const e of entries) {
    const src = e.source ? `[${e.source}]` : '';
    console.log(`  ${e.timestamp.slice(0, 19)}  ${e.type.padEnd(10)} ${String(e.amount.toFixed(4)).padStart(10)} USD  ${(e.channel || '').padEnd(12)} ${src}  ${e.note || ''}`);
  }
  console.log('===========================');
}

// ─── Router ───────────────────────────────────────────────────────────────────

function main() {
  const { agentId, dataPath } = resolveConfig();
  const adapter = new JsonFileAdapter(dataPath);
  const args    = process.argv.slice(2);
  const cmd     = args[0];

  switch (cmd) {
    case 'wallet-init':      cmdWalletInit(adapter, agentId);            break;
    case 'wallet-connect':   cmdWalletConnect(adapter, agentId, args);   break;
    case 'set-primary':      cmdSetPrimary(adapter, agentId, args);      break;
    case 'sync':             cmdSync(adapter, agentId, args);            break;
    case 'record-cost':      cmdRecordCost(adapter, agentId, args);      break;
    case 'record-income':    cmdRecordIncome(adapter, agentId, args);    break;
    case 'balance':          cmdBalance(adapter, agentId);               break;
    case 'status':           cmdStatus(adapter, agentId);                break;
    case 'pl':               cmdPL(adapter, agentId);                    break;
    case 'financial-health': cmdFinancialHealth(adapter, agentId);       break;
    case 'ledger':           cmdLedger(adapter, agentId, args);          break;
    default:
      console.error(`Unknown command: ${cmd || '(none)'}`);
      console.error('Available: wallet-init wallet-connect set-primary sync record-cost record-income balance status pl financial-health ledger');
      process.exit(1);
  }
}

main();
