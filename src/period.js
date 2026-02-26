'use strict';

const { todayUTC } = require('./schema');

const PERIOD_HISTORY_CAP  = 12;
const BURN_RATE_HISTORY_CAP = 90;

// ─── Rollover Check ──────────────────────────────────────────────────────────

/**
 * Returns true if the current period should be rolled over.
 * Trigger: periodStart is not today (calendar day, UTC).
 */
function shouldRollover(state) {
  const periodStart = state.incomeStatement.currentPeriod.periodStart;
  return periodStart !== todayUTC();
}

// ─── Period Rollover ─────────────────────────────────────────────────────────

/**
 * Archive the current period and start a fresh one.
 *
 * Responsibilities:
 * 1. Set periodEnd = yesterday on the current period
 * 2. Push currentPeriod into periodHistory (cap at PERIOD_HISTORY_CAP)
 * 3. Accumulate allTime totals (netIncome is recalculated, not additively summed)
 * 4. Reset currentPeriod:
 *    - periodStart = today
 *    - openingBalance = state.balanceSheet.operationalBalance  ← cash flow anchor
 *    - revenue / expenses / netIncome = 0
 */
function rolloverPeriod(state) {
  const cp    = state.incomeStatement.currentPeriod;
  const today = todayUTC();

  // Calculate yesterday (periodStart's next-day-minus-one is safest; use today-1 day)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  cp.periodEnd = yesterday;

  // Archive
  state.incomeStatement.periodHistory.push(JSON.parse(JSON.stringify(cp)));
  if (state.incomeStatement.periodHistory.length > PERIOD_HISTORY_CAP) {
    state.incomeStatement.periodHistory.splice(0,
      state.incomeStatement.periodHistory.length - PERIOD_HISTORY_CAP);
  }

  // Accumulate allTime
  const at = state.incomeStatement.allTime;
  at.totalRevenue  = parseFloat((at.totalRevenue  + cp.revenue).toFixed(6));
  at.totalExpenses = parseFloat((at.totalExpenses + cp.expenses.total).toFixed(6));
  at.netIncome     = parseFloat((at.totalRevenue  - at.totalExpenses).toFixed(6)); // recalculate

  // Reset currentPeriod
  state.incomeStatement.currentPeriod = {
    periodStart:    today,
    periodEnd:      null,
    openingBalance: state.balanceSheet.operationalBalance, // cash flow anchor for new period
    revenue:        0.0,
    expenses: {
      inference: { llm: {} },
      runtime:   { compute: 0.0, storage: 0.0, bandwidth: 0.0 },
      faculty:   {},
      skill:     {},
      agent:     { acn: 0.0, a2a: 0.0 },
      custom:    {},
      total:     0.0,
    },
    netIncome: 0.0,
  };
}

// ─── Burn Rate ───────────────────────────────────────────────────────────────

/**
 * Convert a single-session cost into a daily rate estimate.
 *
 * @param {number} sessionCost    - actual cost of this conversation (USD)
 * @param {number} durationMs     - conversation duration in milliseconds
 * @returns {number}              - estimated daily burn rate (USD/day)
 */
function toSessionBurnRate(sessionCost, durationMs) {
  const durationDays = Math.max(durationMs / 86400000, 1 / 24); // floor at 1 hour
  return parseFloat((sessionCost / durationDays).toFixed(6));
}

/**
 * Append a burn rate entry and cap the array.
 */
function appendBurnRate(state, sessionCost, durationMs, model) {
  state.burnRateHistory.push({
    timestamp:         new Date().toISOString(),
    sessionCost:       parseFloat(sessionCost.toFixed(6)),
    dailyRateEstimate: toSessionBurnRate(sessionCost, durationMs),
    model:             model || 'default',
  });
  if (state.burnRateHistory.length > BURN_RATE_HISTORY_CAP) {
    state.burnRateHistory.splice(0, state.burnRateHistory.length - BURN_RATE_HISTORY_CAP);
  }
}

module.exports = {
  shouldRollover,
  rolloverPeriod,
  toSessionBurnRate,
  appendBurnRate,
};
