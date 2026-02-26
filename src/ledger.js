'use strict';

const { createLedgerEntry } = require('./schema');

const LEDGER_CAP = 500;

// ─── Expense Routing ─────────────────────────────────────────────────────────

/**
 * Add an expense to the appropriate channel in incomeStatement.currentPeriod.expenses
 * and append a ledger entry.
 *
 * @param {object} state
 * @param {object} identity
 * @param {object} opts
 * @param {string}  opts.channel    - top-level channel: 'inference'|'runtime'|'faculty'|'skill'|'agent'|'custom'
 * @param {string}  [opts.subKey]   - sub-key within channel (e.g. model name for inference, 'compute' for runtime)
 * @param {number}  opts.amount     - USD amount (positive)
 * @param {string}  [opts.model]    - LLM model (for inference channel)
 * @param {string}  [opts.note]
 * @param {'agent'|'runner'|'provider_sync'} [opts.source='agent']
 */
function addToExpenseAccount(state, identity, opts) {
  const { channel, subKey, amount, model, note, source } = opts;
  if (!amount || amount <= 0) return;

  const expenses = state.incomeStatement.currentPeriod.expenses;

  if (channel === 'inference') {
    // inference.llm.<model>.{input, output, thinking}
    const modelKey = model || 'unknown';
    if (!expenses.inference.llm[modelKey]) {
      expenses.inference.llm[modelKey] = { input: 0, output: 0, thinking: 0 };
    }
    const costType = subKey || 'input'; // 'input' | 'output' | 'thinking'
    expenses.inference.llm[modelKey][costType] =
      parseFloat(((expenses.inference.llm[modelKey][costType] || 0) + amount).toFixed(6));
  } else if (expenses[channel] !== undefined) {
    if (subKey) {
      if (!expenses[channel][subKey]) expenses[channel][subKey] = 0;
      expenses[channel][subKey] = parseFloat(((expenses[channel][subKey] || 0) + amount).toFixed(6));
    } else {
      // flat channel (e.g. custom)
      if (typeof expenses[channel] === 'object') {
        const key = note || 'misc';
        expenses[channel][key] = parseFloat(((expenses[channel][key] || 0) + amount).toFixed(6));
      }
    }
  }

  recalcExpensesTotal(state);
  state.incomeStatement.currentPeriod.netIncome =
    parseFloat((state.incomeStatement.currentPeriod.revenue -
                state.incomeStatement.currentPeriod.expenses.total).toFixed(6));

  // Append ledger entry
  appendLedger(state, createLedgerEntry('cost', channel, amount, { model, note, source: source || 'agent' }));
}

/**
 * Recalculate expenses.total by summing all channels.
 */
function recalcExpensesTotal(state) {
  const e = state.incomeStatement.currentPeriod.expenses;
  let total = 0;

  // inference.llm.<model>.{input, output, thinking}
  for (const model of Object.keys(e.inference.llm || {})) {
    const m = e.inference.llm[model];
    total += (m.input || 0) + (m.output || 0) + (m.thinking || 0);
  }

  // runtime
  for (const v of Object.values(e.runtime || {})) total += (v || 0);

  // faculty, skill, agent, custom — sum all leaf values recursively
  for (const ch of ['faculty', 'skill', 'agent', 'custom']) {
    total += sumObject(e[ch] || {});
  }

  e.total = parseFloat(total.toFixed(6));
}

/**
 * Recursively sum all numeric values in an object.
 */
function sumObject(obj) {
  let s = 0;
  for (const v of Object.values(obj)) {
    s += typeof v === 'number' ? v : sumObject(v);
  }
  return s;
}

// ─── Ledger Append ───────────────────────────────────────────────────────────

function appendLedger(state, entry) {
  state.ledger.push(entry);
  if (state.ledger.length > LEDGER_CAP) {
    state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
  }
}

module.exports = {
  addToExpenseAccount,
  recalcExpensesTotal,
  sumObject,
  appendLedger,
};
