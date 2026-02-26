'use strict';

/**
 * Financial Health Score (FHS) calculator.
 *
 * Returns ONLY the financial dimension — not the full Vitality score.
 * Vitality aggregation (financial + future dimensions) is handled by the
 * host framework (e.g. OpenPersona lib/vitality.js).
 *
 * Four dimensions (weights):
 *   Liquidity     0.40  — days of runway based on primary provider balance
 *   Profitability 0.30  — net income rate relative to expenses
 *   Efficiency    0.15  — revenue-to-expense ratio
 *   Trend         0.15  — recent burn rate direction
 *
 * Returns:
 *   { fhs, tier, diagnosis, prescriptions, daysToDepletion, dominantCost, trend }
 *
 * fhs is the internal name; callers map it to state.financialHealth.score.
 */

const WEIGHTS = { liquidity: 0.40, profitability: 0.30, efficiency: 0.15, trend: 0.15 };

function calcFinancialHealth(state, identity) {
  const mode = (identity && identity.mode) || 'development';

  // Development mode or no provider → uninitialized
  if (mode === 'development' || !state.balanceSheet.primaryProvider) {
    return {
      fhs:             0.0,
      tier:            'uninitialized',
      diagnosis:       'no_real_provider',
      prescriptions:   ['connect_real_provider'],
      daysToDepletion: null,
      dominantCost:    null,
      trend:           'stable',
    };
  }

  const balance  = state.balanceSheet.operationalBalance || 0;
  const cp       = state.incomeStatement.currentPeriod;
  const revenue  = cp.revenue  || 0;
  const expenses = cp.expenses ? (cp.expenses.total || 0) : 0;
  const netIncome = revenue - expenses;

  // ── Liquidity ──────────────────────────────────────────────────────────────
  const dailyBurn = _avgDailyBurnRate(state);
  const daysToDepletion = (dailyBurn > 0 && balance > 0)
    ? parseFloat((balance / dailyBurn).toFixed(1))
    : null;

  let liquidityScore;
  if (balance <= 0) {
    liquidityScore = 0;
  } else if (daysToDepletion === null) {
    liquidityScore = 1.0; // no burn history — assume healthy
  } else {
    // sigmoid centred at 30 days; 90 days → ~0.95; 7 days → ~0.37
    liquidityScore = 1.0 / (1 + Math.exp(-(daysToDepletion - 30) / 15));
  }

  // ── Profitability ──────────────────────────────────────────────────────────
  let profitabilityScore;
  if (expenses === 0) {
    profitabilityScore = revenue > 0 ? 1.0 : 0.5;
  } else {
    const netIncomeRate = netIncome / expenses;
    profitabilityScore = 1.0 / (1 + Math.exp(-netIncomeRate));
  }

  // ── Efficiency ─────────────────────────────────────────────────────────────
  // sigmoid without 1.0 cap — rewards very high revenue/expense ratios
  let efficiencyScore;
  if (revenue > 0 && expenses > 0) {
    efficiencyScore = 1.0 / (1 + Math.exp(-(revenue / expenses - 1)));
  } else {
    efficiencyScore = revenue > 0 ? 1.0 : 0.5;
  }

  // ── Trend ──────────────────────────────────────────────────────────────────
  const { trendLabel, trendScore } = _calcTrend(state);

  // ── Composite FHS ─────────────────────────────────────────────────────────
  const fhs = parseFloat((
    liquidityScore     * WEIGHTS.liquidity     +
    profitabilityScore * WEIGHTS.profitability +
    efficiencyScore    * WEIGHTS.efficiency    +
    trendScore         * WEIGHTS.trend
  ).toFixed(4));

  // ── Tier & Diagnosis ──────────────────────────────────────────────────────
  const { tier, diagnosis, prescriptions } = _diagnose(fhs, daysToDepletion, balance);

  // ── Dominant Cost ─────────────────────────────────────────────────────────
  const dominantCost = _dominantCostChannel(cp.expenses);

  return { fhs, tier, diagnosis, prescriptions, daysToDepletion, dominantCost, trend: trendLabel };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _avgDailyBurnRate(state) {
  const history = state.burnRateHistory;
  if (!history || history.length === 0) return 0;
  const recent = history.slice(-14); // last 14 sessions
  const sum = recent.reduce((acc, e) => acc + (e.dailyRateEstimate || 0), 0);
  return sum / recent.length;
}

function _calcTrend(state) {
  const history = state.burnRateHistory;
  if (!history || history.length < 4) return { trendLabel: 'stable', trendScore: 0.6 };

  const recent = history.slice(-7).map(e => e.dailyRateEstimate || 0);
  const older  = history.slice(-14, -7).map(e => e.dailyRateEstimate || 0);

  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder  = older.length
    ? older.reduce((a, b) => a + b, 0) / older.length
    : avgRecent;

  if (avgOlder === 0) return { trendLabel: 'stable', trendScore: 0.6 };

  const changeRatio = (avgRecent - avgOlder) / avgOlder;

  if (changeRatio > 0.2)  return { trendLabel: 'increasing', trendScore: 0.3 };
  if (changeRatio < -0.1) return { trendLabel: 'decreasing', trendScore: 0.9 };
  return                         { trendLabel: 'stable',     trendScore: 0.6 };
}

function _diagnose(fhs, daysToDepletion, balance) {
  if (balance <= 0) {
    return {
      tier:          'suspended',
      diagnosis:     'balance_depleted',
      prescriptions: ['add_funds', 'reduce_costs'],
    };
  }
  if (fhs < 0.20 || (daysToDepletion !== null && daysToDepletion < 3)) {
    return {
      tier:          'critical',
      diagnosis:     'critically_low_runway',
      prescriptions: ['add_funds_immediately', 'pause_non_essential'],
    };
  }
  if (fhs < 0.50 || (daysToDepletion !== null && daysToDepletion < 14)) {
    return {
      tier:          'optimizing',
      diagnosis:     'low_runway',
      prescriptions: ['optimize_costs', 'increase_revenue'],
    };
  }
  return {
    tier:          'normal',
    diagnosis:     'healthy',
    prescriptions: ['operate_normally'],
  };
}

function _dominantCostChannel(expenses) {
  if (!expenses) return null;
  const channels = {
    inference: _sumInference(expenses.inference),
    runtime:   _sumFlat(expenses.runtime),
    faculty:   _sumFlat(expenses.faculty),
    skill:     _sumFlat(expenses.skill),
    agent:     _sumFlat(expenses.agent),
    custom:    _sumFlat(expenses.custom),
  };
  let max = 0, dominant = null;
  for (const [k, v] of Object.entries(channels)) {
    if (v > max) { max = v; dominant = k; }
  }
  return dominant;
}

function _sumInference(inference) {
  if (!inference || !inference.llm) return 0;
  let s = 0;
  for (const m of Object.values(inference.llm)) {
    s += (m.input || 0) + (m.output || 0) + (m.thinking || 0);
  }
  return s;
}

function _sumFlat(obj) {
  if (!obj) return 0;
  let s = 0;
  for (const v of Object.values(obj)) s += typeof v === 'number' ? v : 0;
  return s;
}

module.exports = { calcFinancialHealth };
