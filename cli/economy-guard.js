#!/usr/bin/env node
'use strict';

/**
 * economy-guard.js — pre-conversation financial health check
 *
 * Outputs FINANCIAL_HEALTH_REPORT (not VITALITY_REPORT).
 * Vitality aggregation is handled by the host framework.
 *
 * Flow:
 *   1. Sync primary provider (external balance fetch)
 *   2. TTL check — if cache is fresh, use cached FHS; else recalculate
 *   3. Output FINANCIAL_HEALTH_REPORT
 *
 * Development mode: outputs a minimal report with mode=development.
 */

const path    = require('path');
const os      = require('os');
const { calcFinancialHealth } = require('../src/financial-health');
const { syncProvider }        = require('../src/providers');
const { JsonFileAdapter }     = require('../adapters/json-file');

function resolveConfig() {
  const agentId  = process.env.AGENTBOOKS_AGENT_ID || 'default';
  const dataPath = process.env.AGENTBOOKS_DATA_PATH
    || path.join(os.homedir(), '.agentbooks', agentId);
  return { agentId, dataPath };
}

function main() {
  const { agentId, dataPath } = resolveConfig();
  const adapter  = new JsonFileAdapter(dataPath);
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);

  const mode = (identity && identity.mode) || 'development';

  // 1. Sync primary provider balance
  if (state.balanceSheet.primaryProvider && identity) {
    const balance = syncProvider(state, identity, state.balanceSheet.primaryProvider);
    state.balanceSheet.operationalBalance = balance;
    // (real provider SDK integration goes here — for now reads cached value)
  }

  // 2. TTL check
  const ttl         = (identity && identity.financialHealthCacheTTLMinutes) != null
    ? identity.financialHealthCacheTTLMinutes
    : 60;
  const computedAt  = state.financialHealth && state.financialHealth.computedAt;
  const isStale     = !computedAt
    || (Date.now() - new Date(computedAt).getTime()) > ttl * 60 * 1000;

  if (isStale) {
    const result = calcFinancialHealth(state, identity);
    state.financialHealth = {
      score:           result.fhs,
      tier:            result.tier,
      diagnosis:       result.diagnosis,
      prescriptions:   result.prescriptions,
      daysToDepletion: result.daysToDepletion,
      dominantCost:    result.dominantCost,
      trend:           result.trend,
      computedAt:      new Date().toISOString(),
    };
    adapter.writeSync(agentId, state);
  }

  // 3. Output FINANCIAL_HEALTH_REPORT
  const fh = state.financialHealth;
  const lines = ['FINANCIAL_HEALTH_REPORT'];

  if (mode === 'development') {
    lines.push('mode=development  tier=uninitialized  (connect a real provider to activate scoring)');
  } else {
    lines.push(`tier=${fh.tier}  score=${(fh.score * 100).toFixed(1)}%`);
    lines.push(`diagnosis=${fh.diagnosis}`);
    lines.push(`prescriptions=${(fh.prescriptions || []).join(',')}`);
    if (fh.daysToDepletion !== null && fh.daysToDepletion !== undefined) {
      lines.push(`daysToDepletion=${fh.daysToDepletion}`);
    }
    if (fh.dominantCost) lines.push(`dominantCost=${fh.dominantCost}`);
    lines.push(`trend=${fh.trend}`);
    lines.push(`balance=${state.balanceSheet.operationalBalance.toFixed(4)} ${state.balanceSheet.operationalCurrency}`);
  }

  console.log(lines.join('\n'));
}

main();
