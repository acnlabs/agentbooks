'use strict';

const fs   = require('fs');
const path = require('path');
const { createInitialState, createIdentityInitialState } = require('../src/schema');
const { validateState } = require('../src/reconcile');

const STATE_FILE    = 'economic-state.json';
const IDENTITY_FILE = 'economic-identity.json';

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate economic-state from v2.x (old OpenPersona economy format) to v1.0.0.
 * Called lazily during readSync when schema version is not '1.0.0'.
 */
function migrateState(old, agentId) {
  const fresh = createInitialState(agentId);

  // Copy balance sheet assets (skip 'local' provider)
  if (old.balanceSheet && old.balanceSheet.assets && old.balanceSheet.assets.providers) {
    const providers = old.balanceSheet.assets.providers;
    for (const name of ['coinbase-cdp', 'acn', 'onchain']) {
      if (providers[name]) {
        fresh.balanceSheet.assets.providers[name] = providers[name];
      }
    }
    // If old state had a 'local' provider with budget > 0, record integrity warning
    if (providers.local && providers.local.budget > 0) {
      fresh.integrityWarnings.push({
        type:      'migration_local_budget_discarded',
        amount:    providers.local.budget,
        message:   'local.budget was discarded during migration to v1.0.0 (fabricated balance not trustworthy)',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Copy primaryProvider
  if (old.balanceSheet && old.balanceSheet.primaryProvider) {
    fresh.balanceSheet.primaryProvider = old.balanceSheet.primaryProvider;
  }
  if (old.balanceSheet && old.balanceSheet.operationalBalance !== undefined) {
    fresh.balanceSheet.operationalBalance = old.balanceSheet.operationalBalance;
  }

  // Copy liabilities if present
  if (old.balanceSheet && old.balanceSheet.liabilities) {
    fresh.balanceSheet.liabilities = old.balanceSheet.liabilities;
  }

  // Copy income statement
  if (old.incomeStatement) {
    if (old.incomeStatement.currentPeriod) {
      const cp = old.incomeStatement.currentPeriod;
      fresh.incomeStatement.currentPeriod.periodStart = cp.periodStart || fresh.incomeStatement.currentPeriod.periodStart;
      fresh.incomeStatement.currentPeriod.revenue     = cp.revenue     || 0;
      fresh.incomeStatement.currentPeriod.expenses    = cp.expenses    || fresh.incomeStatement.currentPeriod.expenses;
      fresh.incomeStatement.currentPeriod.netIncome   = cp.netIncome   || 0;
      // openingBalance not available in old format — leave as 0 (cash flow check will skip until next rollover)
    }
    if (old.incomeStatement.periodHistory) {
      fresh.incomeStatement.periodHistory = old.incomeStatement.periodHistory.slice(-12);
    }
    if (old.incomeStatement.allTime) {
      fresh.incomeStatement.allTime = old.incomeStatement.allTime;
    }
  }

  // Migrate burnRateHistory — rename {dailyBurnRate, periodExpenses} → {dailyRateEstimate, sessionCost}
  if (Array.isArray(old.burnRateHistory)) {
    fresh.burnRateHistory = old.burnRateHistory.slice(-90).map((entry) => {
      if (entry.dailyRateEstimate !== undefined) return entry; // already new format
      return {
        timestamp:         entry.timestamp || new Date().toISOString(),
        sessionCost:       entry.periodExpenses   || 0,
        dailyRateEstimate: entry.dailyBurnRate     || 0,
        model:             null,
      };
    });
  }

  // Copy ledger
  if (Array.isArray(old.ledger)) {
    fresh.ledger = old.ledger.slice(-500);
  }

  // Copy existing integrityWarnings
  if (Array.isArray(old.integrityWarnings)) {
    fresh.integrityWarnings.push(...old.integrityWarnings);
  }

  fresh.createdAt     = old.createdAt     || fresh.createdAt;
  fresh.lastUpdatedAt = old.lastUpdatedAt || fresh.lastUpdatedAt;

  return fresh;
}

// ─── JsonFileAdapter ─────────────────────────────────────────────────────────

class JsonFileAdapter {
  /**
   * @param {string} dataPath - directory where state/identity files are stored
   *   Standalone default: ~/.agentbooks/<agentId>/
   *   OpenPersona override: ~/.openclaw/economy/persona-<slug>/  (via AGENTBOOKS_DATA_PATH)
   */
  constructor(dataPath) {
    this.dataPath = dataPath;
  }

  _statePath()    { return path.join(this.dataPath, STATE_FILE); }
  _identityPath() { return path.join(this.dataPath, IDENTITY_FILE); }

  _ensureDir() {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  readIdentitySync(agentId) {
    const p = this._identityPath();
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  writeIdentitySync(agentId, identity) {
    this._ensureDir();
    fs.writeFileSync(this._identityPath(), JSON.stringify(identity, null, 2), 'utf8');
  }

  // ── State ─────────────────────────────────────────────────────────────────

  readSync(agentId) {
    const p = this._statePath();
    let state;

    if (!fs.existsSync(p)) {
      state = createInitialState(agentId);
    } else {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Migrate if not v1.0.0
        state = (raw.version === '1.0.0') ? raw : migrateState(raw, agentId);
      } catch {
        state = createInitialState(agentId);
      }
    }

    // Sync primaryProvider mirror from identity (identity is authoritative)
    const identity = this.readIdentitySync(agentId);
    if (identity && identity.primaryProvider) {
      state.balanceSheet.primaryProvider = identity.primaryProvider;
    }

    return state;
  }

  writeSync(agentId, state) {
    this._ensureDir();
    // Read identity first (validateState needs mode)
    const identity = this.readIdentitySync(agentId);
    // Recompute equity, totalUSDEquivalent, cash flow check
    validateState(state, identity);
    state.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(this._statePath(), JSON.stringify(state, null, 2), 'utf8');
  }
}

module.exports = { JsonFileAdapter };
