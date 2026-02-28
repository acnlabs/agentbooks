#!/usr/bin/env node
'use strict';

/**
 * gen-demo-report.js — generate a demo HTML report with realistic mock data
 * Usage: node scripts/gen-demo-report.js [--output <path>]
 */

const fs   = require('fs');
const path = require('path');

const { buildHTML } = require('../cli/report.js').__test__;

// ─── Mock Identity ────────────────────────────────────────────────────────────

const identity = {
  schema:          'agentbooks/economic-identity',
  version:         '1.0.0',
  agentId:         'samantha',
  mode:            'production',
  walletAddress:   '0x37a8eec1ce19687d132fe29051dca629d164e2c4',
  primaryProvider: 'coinbase-cdp',
  modelPricing: {
    'gpt-4o': { input: 2.50, output: 10.00, thinking: 10.00 },
  },
  exchangeRates: { ETH: 2500, credits: 0.01 },
  financialHealthCacheTTLMinutes: 60,
  providers: {
    'coinbase-cdp': { enabled: true, authenticated: true },
    acn:            { enabled: false, acnAgentId: null },
    onchain:        { enabled: false, rpc: null, network: 'base' },
  },
  createdAt: '2026-02-01T00:00:00Z',
};

// ─── Mock State ───────────────────────────────────────────────────────────────
// Accounting identity: openingBalance + revenue - expenses = operationalBalance
// 50.00 + 20.50 - 2.54 = 67.96 ✓

const OPERATIONAL_BALANCE = 67.96;
const REVENUE             = 20.50;
const EXPENSES_TOTAL      = 2.54;
const OPENING_BALANCE     = parseFloat((OPERATIONAL_BALANCE - REVENUE + EXPENSES_TOTAL).toFixed(6)); // 50.00

const now = new Date();
function daysAgo(d) {
  return new Date(now.getTime() - d * 86400000).toISOString();
}
function hoursAgo(h) {
  return new Date(now.getTime() - h * 3600000).toISOString();
}

const state = {
  schema:  'agentbooks/economic-state',
  version: '1.0.0',
  agentId: 'samantha',

  balanceSheet: {
    assets: {
      providers: {
        'coinbase-cdp': {
          USDC: OPERATIONAL_BALANCE,
          ETH:  0.0,
          network: 'base',
          lastSynced: now.toISOString(),
        },
        acn:     { credits: 0.0, lastSynced: null },
        onchain: { USDC: 0.0, ETH: 0.0, network: 'base', lastSynced: null },
      },
      totalUSDEquivalent: OPERATIONAL_BALANCE, // matches operational balance
    },
    primaryProvider:     'coinbase-cdp',
    operationalBalance:  OPERATIONAL_BALANCE,
    operationalCurrency: 'USD',
    liabilities: { accountsPayable: [], total: 0.0 },
    equity:      { value: OPERATIONAL_BALANCE }, // assets - liabilities
  },

  incomeStatement: {
    currentPeriod: {
      periodStart:    '2026-02-28',
      periodEnd:      null,
      openingBalance: OPENING_BALANCE, // cash flow check will pass: 50 + 20.50 - 2.54 = 67.96
      revenue:        REVENUE,
      expenses: {
        inference: {
          llm: {
            'gpt-4o': { input: 0.0120, output: 0.0300, thinking: 0 },
          },
        },
        runtime:  { compute: 2.50, storage: 0.0, bandwidth: 0.0 },
        faculty:  {},
        skill:    {},
        agent:    { acn: 0.0, a2a: 0.0 },
        custom:   {},
        total:    EXPENSES_TOTAL,
      },
      netIncome: parseFloat((REVENUE - EXPENSES_TOTAL).toFixed(6)),
    },
    periodHistory: [],
    allTime: {
      totalRevenue:  REVENUE,
      totalExpenses: EXPENSES_TOTAL,
      netIncome:     parseFloat((REVENUE - EXPENSES_TOTAL).toFixed(6)),
    },
  },

  burnRateHistory: [
    { timestamp: daysAgo(5), sessionCost: 0.038, dailyRateEstimate: 0.18, model: 'gpt-4o' },
    { timestamp: daysAgo(4), sessionCost: 0.052, dailyRateEstimate: 0.21, model: 'gpt-4o' },
    { timestamp: daysAgo(3), sessionCost: 0.041, dailyRateEstimate: 0.20, model: 'gpt-4o' },
    { timestamp: daysAgo(2), sessionCost: 0.063, dailyRateEstimate: 0.31, model: 'gpt-4o' },
    { timestamp: daysAgo(1), sessionCost: 0.055, dailyRateEstimate: 0.27, model: 'gpt-4o' },
    { timestamp: daysAgo(0), sessionCost: 0.042, dailyRateEstimate: 0.45, model: 'gpt-4o' },
  ],

  financialHealth: {
    tier:            'normal',
    score:           0.94,
    diagnosis:       'healthy',
    prescriptions:   ['operate_normally'],
    daysToDepletion: null,
    dominantCost:    'runtime',
    trend:           'stable',
    computedAt:      now.toISOString(),
  },

  ledger: [
    {
      id:        'a1b2c3d4-0001',
      type:      'deposit',
      channel:   'wallet',
      amount:    50.00,
      currency:  'USD',
      model:     null,
      quality:   null,
      note:      'Initial fueling',
      source:    'host',
      timestamp: hoursAgo(3.5),
    },
    {
      id:        'a1b2c3d4-0002',
      type:      'income',
      channel:   'skill:creative-writing',
      amount:    15.50,
      currency:  'USD',
      model:     null,
      quality:   'high',
      note:      'Creative writing task bounty',
      source:    'acn',
      timestamp: hoursAgo(1.25),
    },
    {
      id:        'a1b2c3d4-0003',
      type:      'cost',
      channel:   'inference',
      amount:    0.042,
      currency:  'USD',
      model:     'gpt-4o',
      quality:   null,
      note:      'LLM Inference: GPT-4o',
      source:    'runner',
      timestamp: hoursAgo(1.17),
    },
    {
      id:        'a1b2c3d4-0004',
      type:      'cost',
      channel:   'runtime',
      amount:    2.50,
      currency:  'USD',
      model:     null,
      quality:   null,
      note:      'Cloud compute runtime monthly prorated',
      source:    'agent',
      timestamp: hoursAgo(0.5),
    },
    {
      id:        'a1b2c3d4-0005',
      type:      'income',
      channel:   'faculty:voice',
      amount:    5.00,
      currency:  'USD',
      model:     null,
      quality:   'medium',
      note:      'Voice task achievement reward',
      source:    'acn',
      timestamp: hoursAgo(0.14),
    },
  ],

  integrityWarnings: [],
  createdAt:     '2026-02-01T00:00:00Z',
  lastUpdatedAt: now.toISOString(),
};

// ─── Generate ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const outIdx  = args.indexOf('--output');
const outPath = outIdx !== -1 && args[outIdx + 1]
  ? args[outIdx + 1]
  : path.join(process.cwd(), 'agentbooks-demo-report.html');

const html = buildHTML('samantha', state, identity);
fs.writeFileSync(outPath, html, 'utf8');
console.log(`Demo report written to ${outPath}`);
