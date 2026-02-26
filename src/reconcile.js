'use strict';

const { calcTotalUSDEquivalent } = require('./providers');

const CASH_FLOW_TOLERANCE = 0.01; // $0.01

/**
 * Validate and recompute derived fields before writing state.
 *
 * Responsibilities:
 * 1. Recalculate assets.totalUSDEquivalent
 * 2. Recalculate equity.value = assets.total - liabilities.total
 * 3. In production mode: cash flow integrity check
 *    openingBalance + revenue - expenses ≈ operationalBalance
 *    Discrepancy > $0.01 → append to integrityWarnings (never blocks write)
 * 4. In production mode: warn if operationalBalance < 0
 *
 * @param {object}      state
 * @param {object|null} identity
 */
function validateState(state, identity) {
  const mode = (identity && identity.mode) || 'development';

  // 1. Recalculate totalUSDEquivalent
  state.balanceSheet.assets.totalUSDEquivalent = calcTotalUSDEquivalent(state, identity);

  // 2. Recalculate equity
  const liabTotal = state.balanceSheet.liabilities
    ? (state.balanceSheet.liabilities.total || 0)
    : 0;
  state.balanceSheet.equity.value =
    parseFloat((state.balanceSheet.assets.totalUSDEquivalent - liabTotal).toFixed(6));

  if (mode !== 'production') return; // skip integrity checks in development mode

  // 3. Cash flow integrity check (production only)
  const cp = state.incomeStatement.currentPeriod;
  if (cp.openingBalance !== null && cp.openingBalance !== undefined) {
    const expected = parseFloat(
      (cp.openingBalance + cp.revenue - cp.expenses.total).toFixed(6)
    );
    const actual = state.balanceSheet.operationalBalance;
    const delta  = Math.abs(expected - actual);

    if (delta > CASH_FLOW_TOLERANCE) {
      state.integrityWarnings.push({
        type:      'cash_flow_mismatch',
        expected:  expected.toFixed(4),
        actual:    actual.toFixed(4),
        delta:     delta.toFixed(4),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 4. Negative balance warning (production only)
  if (state.balanceSheet.operationalBalance < 0) {
    state.integrityWarnings.push({
      type:      'negative_balance',
      balance:   state.balanceSheet.operationalBalance.toFixed(4),
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = { validateState };
