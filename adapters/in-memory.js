'use strict';

const { createInitialState, createIdentityInitialState } = require('../src/schema');
const { validateState } = require('../src/reconcile');

/**
 * In-memory adapter for testing.
 * Implements the same interface as JsonFileAdapter — same readSync/writeSync behaviour.
 */
class InMemoryAdapter {
  constructor() {
    this._states     = new Map(); // agentId → state object (deep-cloned on read/write)
    this._identities = new Map(); // agentId → identity object
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  readIdentitySync(agentId) {
    const id = this._identities.get(agentId);
    return id ? JSON.parse(JSON.stringify(id)) : null;
  }

  writeIdentitySync(agentId, identity) {
    this._identities.set(agentId, JSON.parse(JSON.stringify(identity)));
  }

  // ── State ─────────────────────────────────────────────────────────────────

  readSync(agentId) {
    let state = this._states.has(agentId)
      ? JSON.parse(JSON.stringify(this._states.get(agentId)))
      : createInitialState(agentId);

    // Sync primaryProvider mirror from identity (same as JsonFileAdapter)
    const identity = this.readIdentitySync(agentId);
    if (identity && identity.primaryProvider) {
      state.balanceSheet.primaryProvider = identity.primaryProvider;
    }

    return state;
  }

  writeSync(agentId, state) {
    const identity = this.readIdentitySync(agentId);
    validateState(state, identity);
    state.lastUpdatedAt = new Date().toISOString();
    this._states.set(agentId, JSON.parse(JSON.stringify(state)));
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  clear() {
    this._states.clear();
    this._identities.clear();
  }
}

module.exports = { InMemoryAdapter };
