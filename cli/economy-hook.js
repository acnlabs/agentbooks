#!/usr/bin/env node
'use strict';

/**
 * economy-hook.js — post-conversation inference cost recorder
 *
 * Called by the runner after each conversation to record LLM costs.
 * Runner MUST provide token counts via environment variables (preferred)
 * or CLI arguments. If no token data is available, nothing is recorded.
 *
 * Runner data contract (env vars take priority over CLI args):
 *   AGENTBOOKS_AGENT_ID      Agent identifier
 *   AGENTBOOKS_DATA_PATH     Data directory (overrides default ~/.agentbooks/<id>/)
 *   TOKEN_INPUT_COUNT        Actual input token count
 *   TOKEN_OUTPUT_COUNT       Actual output token count
 *   TOKEN_THINKING_COUNT     Thinking token count (optional, default 0)
 *   LLM_MODEL                Model name (optional, default 'default')
 *   CONVERSATION_DURATION_MS Conversation duration in ms (for burn rate estimate)
 */

const path    = require('path');
const os      = require('os');
const {
  shouldRollover, rolloverPeriod, appendBurnRate,
} = require('../src/period');
const { addToExpenseAccount } = require('../src/ledger');
const { calcFinancialHealth } = require('../src/financial-health');
const { JsonFileAdapter }     = require('../adapters/json-file');

// ─── Config ───────────────────────────────────────────────────────────────────

function resolveConfig() {
  const agentId  = process.env.AGENTBOOKS_AGENT_ID || 'default';
  const dataPath = process.env.AGENTBOOKS_DATA_PATH
    || path.join(os.homedir(), '.agentbooks', agentId);
  return { agentId, dataPath };
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

/**
 * Parse CLI arguments, but env vars ALWAYS take priority.
 * If an env var is set, the corresponding CLI arg is silently ignored.
 */
function parseArgs(argv) {
  const opts = {
    input:       parseInt(process.env.TOKEN_INPUT_COUNT    || '0', 10),
    output:      parseInt(process.env.TOKEN_OUTPUT_COUNT   || '0', 10),
    thinking:    parseInt(process.env.TOKEN_THINKING_COUNT || '0', 10),
    model:       process.env.LLM_MODEL                     || 'default',
    durationMs:  parseInt(process.env.CONVERSATION_DURATION_MS || '0', 10),
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
        if (!process.env.TOKEN_INPUT_COUNT)    opts.input    = parseInt(args[++i], 10); else i++;
        break;
      case '--output':
        if (!process.env.TOKEN_OUTPUT_COUNT)   opts.output   = parseInt(args[++i], 10); else i++;
        break;
      case '--thinking':
        if (!process.env.TOKEN_THINKING_COUNT) opts.thinking = parseInt(args[++i], 10); else i++;
        break;
      case '--model':
        if (!process.env.LLM_MODEL)            opts.model    = args[++i];              else i++;
        break;
      case '--duration-ms':
        if (!process.env.CONVERSATION_DURATION_MS) opts.durationMs = parseInt(args[++i], 10); else i++;
        break;
    }
  }
  return opts;
}

// ─── Cost Calculation ─────────────────────────────────────────────────────────

function calcCosts(opts, pricing) {
  const p = pricing[opts.model] || pricing['default'] || { input: 3.0, output: 15.0, thinking: 15.0 };
  // Pricing is per 1M tokens
  const inputCost    = (opts.input    / 1_000_000) * p.input;
  const outputCost   = (opts.output   / 1_000_000) * p.output;
  const thinkingCost = (opts.thinking / 1_000_000) * p.thinking;
  return { inputCost, outputCost, thinkingCost,
           total: inputCost + outputCost + thinkingCost };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);

  // If no token data at all, skip silently (no estimation)
  if (opts.input === 0 && opts.output === 0 && opts.thinking === 0) {
    process.exit(0);
  }

  const { agentId, dataPath } = resolveConfig();
  const adapter  = new JsonFileAdapter(dataPath);
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);
  const pricing  = (identity && identity.modelPricing) || {};

  // Rollover if needed (must happen before recording today's costs)
  if (shouldRollover(state)) {
    rolloverPeriod(state);
  }

  const costs = calcCosts(opts, pricing);

  // Record costs — source:'runner' signals these are Runner-provided (trusted)
  if (costs.inputCost > 0) {
    addToExpenseAccount(state, identity, {
      channel: 'inference', subKey: 'input', amount: costs.inputCost,
      model: opts.model, source: 'runner',
    });
  }
  if (costs.outputCost > 0) {
    addToExpenseAccount(state, identity, {
      channel: 'inference', subKey: 'output', amount: costs.outputCost,
      model: opts.model, source: 'runner',
    });
  }
  if (costs.thinkingCost > 0) {
    addToExpenseAccount(state, identity, {
      channel: 'inference', subKey: 'thinking', amount: costs.thinkingCost,
      model: opts.model, source: 'runner',
    });
  }

  // Append burn rate entry
  if (costs.total > 0) {
    appendBurnRate(state, costs.total, opts.durationMs || 300000, opts.model);
  }

  // Refresh financialHealth cache
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

main();
