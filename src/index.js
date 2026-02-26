'use strict';

/**
 * AgentBooks public API
 *
 * Framework-agnostic financial management for AI agents.
 * Only exports the financial dimension — Vitality aggregation is the
 * responsibility of the host framework (e.g. OpenPersona lib/vitality.js).
 */

const { calcFinancialHealth }       = require('./financial-health');
const { createInitialState,
        createIdentityInitialState,
        createLedgerEntry }         = require('./schema');
const { addToExpenseAccount,
        recalcExpensesTotal }       = require('./ledger');
const { shouldRollover,
        rolloverPeriod,
        toSessionBurnRate,
        appendBurnRate }            = require('./period');
const { validateState }             = require('./reconcile');
const { calcTotalUSDEquivalent,
        getProviderBalance,
        syncProvider,
        setProviderBalance,
        deductFromProvider,
        creditToProvider }          = require('./providers');

module.exports = {
  // Core calculation
  calcFinancialHealth,

  // Schema factories
  createInitialState,
  createIdentityInitialState,
  createLedgerEntry,

  // Ledger
  addToExpenseAccount,
  recalcExpensesTotal,

  // Period
  shouldRollover,
  rolloverPeriod,
  toSessionBurnRate,
  appendBurnRate,

  // Reconciliation
  validateState,

  // Providers
  calcTotalUSDEquivalent,
  getProviderBalance,
  syncProvider,
  setProviderBalance,
  deductFromProvider,
  creditToProvider,
};
