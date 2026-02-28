#!/usr/bin/env node
'use strict';

/**
 * agentbooks report — generate a self-contained HTML financial report
 *
 * Usage:
 *   agentbooks report
 *   agentbooks report --output ./report.html
 *
 * Reads economic-state.json + economic-identity.json and writes a single
 * HTML file with no external dependencies (all CSS/SVG inline).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { JsonFileAdapter }    = require('../adapters/json-file');
const { calcFinancialHealth } = require('../src/financial-health');

// ─── Config ──────────────────────────────────────────────────────────────────

function resolveConfig() {
  const agentId  = process.env.AGENTBOOKS_AGENT_ID || 'default';
  const dataPath = process.env.AGENTBOOKS_DATA_PATH
    || path.join(os.homedir(), '.agentbooks', agentId);
  return { agentId, dataPath };
}

function getArg(args, flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1]) ? args[i + 1] : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n, digits = 4) {
  return (n || 0).toFixed(digits);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function tierColor(tier) {
  return {
    normal:        '#22c55e',
    optimizing:    '#eab308',
    critical:      '#f97316',
    suspended:     '#ef4444',
    uninitialized: '#94a3b8',
  }[tier] || '#94a3b8';
}

function tierBg(tier) {
  return {
    normal:        '#f0fdf4',
    optimizing:    '#fefce8',
    critical:      '#fff7ed',
    suspended:     '#fef2f2',
    uninitialized: '#f8fafc',
  }[tier] || '#f8fafc';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── SVG Sparkline ───────────────────────────────────────────────────────────

function buildSparkline(burnHistory, width, height) {
  const data = (burnHistory || []).slice(-30);
  if (data.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width/2}" y="${height/2}" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="system-ui">No burn rate data yet</text>
    </svg>`;
  }

  const values = data.map(d => d.dailyRateEstimate || 0);
  const maxVal = Math.max(...values, 0.0001);
  const pad = { top: 20, right: 20, bottom: 40, left: 55 };
  const innerW = width  - pad.left - pad.right;
  const innerH = height - pad.top  - pad.bottom;

  const pts = values.map((v, i) => {
    const x = pad.left + (i / (values.length - 1)) * innerW;
    const y = pad.top  + (1 - v / maxVal) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  // Y axis labels (3 ticks)
  const yTicks = [0, 0.5, 1].map(t => ({
    y: pad.top + (1 - t) * innerH,
    label: `$${(t * maxVal).toFixed(4)}`,
  }));

  // X axis labels: first, middle, last
  // Use HH:MM when all data is within 24 hours, otherwise MM-DD
  const firstTs = data[0].timestamp ? new Date(data[0].timestamp) : null;
  const lastTs  = data[data.length - 1].timestamp ? new Date(data[data.length - 1].timestamp) : null;
  const spanMs  = (firstTs && lastTs) ? Math.abs(lastTs - firstTs) : 0;
  const useTime = spanMs < 86400000; // < 24 hours → show HH:MM
  const xLabels = [0, Math.floor((data.length - 1) / 2), data.length - 1].map(i => {
    const ts = data[i].timestamp;
    let label = '';
    if (ts) {
      label = useTime
        ? ts.slice(11, 16)   // HH:MM
        : ts.slice(5, 10);   // MM-DD
    }
    return { x: pad.left + (i / (values.length - 1)) * innerW, label };
  });

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <defs>
      <linearGradient id="burnGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <!-- Grid lines -->
    ${yTicks.map(t => `<line x1="${pad.left}" y1="${t.y.toFixed(1)}" x2="${pad.left + innerW}" y2="${t.y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`).join('')}
    <!-- Fill area -->
    <polygon points="${pts.join(' ')} ${(pad.left + innerW).toFixed(1)},${(pad.top + innerH).toFixed(1)} ${pad.left},${(pad.top + innerH).toFixed(1)}" fill="url(#burnGrad)"/>
    <!-- Line -->
    <polyline points="${pts.join(' ')}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <!-- Dots -->
    ${pts.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3" fill="#6366f1"/>`).join('')}
    <!-- Y axis labels -->
    ${yTicks.map(t => `<text x="${pad.left - 6}" y="${(t.y + 4).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="11" font-family="system-ui">${esc(t.label)}</text>`).join('')}
    <!-- X axis labels -->
    ${xLabels.map(l => `<text x="${l.x.toFixed(1)}" y="${(pad.top + innerH + 20).toFixed(1)}" text-anchor="middle" fill="#64748b" font-size="11" font-family="system-ui">${esc(l.label)}</text>`).join('')}
    <!-- Axis -->
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + innerH}" stroke="#cbd5e1" stroke-width="1"/>
    <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${pad.left + innerW}" y2="${pad.top + innerH}" stroke="#cbd5e1" stroke-width="1"/>
  </svg>`;
}

// ─── Cost Breakdown Bars ─────────────────────────────────────────────────────

function buildCostBars(expenses) {
  if (!expenses || expenses.total <= 0) return '<p style="color:#94a3b8;font-size:14px">No expenses recorded yet.</p>';

  const channels = {};

  // inference
  let inferenceTotal = 0;
  for (const costs of Object.values((expenses.inference && expenses.inference.llm) || {})) {
    inferenceTotal += (costs.input || 0) + (costs.output || 0) + (costs.thinking || 0);
  }
  if (inferenceTotal > 0) channels.inference = inferenceTotal;

  // flat channels
  const flat = { runtime: expenses.runtime, faculty: expenses.faculty, skill: expenses.skill, agent: expenses.agent, custom: expenses.custom };
  for (const [ch, obj] of Object.entries(flat)) {
    if (!obj) continue;
    const sum = Object.values(obj).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    if (sum > 0) channels[ch] = sum;
  }

  const total = expenses.total;
  const colors = { inference: '#6366f1', runtime: '#0ea5e9', faculty: '#10b981', skill: '#f59e0b', agent: '#8b5cf6', custom: '#64748b' };

  const bars = Object.entries(channels).sort(([, a], [, b]) => b - a).map(([ch, amt]) => {
    const pct = (amt / total * 100).toFixed(1);
    const color = colors[ch] || '#94a3b8';
    return `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:13px;font-weight:500;color:#374151">${esc(ch)}</span>
        <span style="font-size:13px;color:#6b7280">$${fmt(amt)} <span style="color:#9ca3af">(${pct}%)</span></span>
      </div>
      <div style="height:8px;background:#f1f5f9;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width 0.3s"></div>
      </div>
    </div>`;
  });

  // Inference model breakdown
  let modelDetail = '';
  const llm = expenses.inference && expenses.inference.llm;
  if (llm && Object.keys(llm).length > 0) {
    const rows = Object.entries(llm).map(([model, costs]) => {
      const t = (costs.input || 0) + (costs.output || 0) + (costs.thinking || 0);
      if (t <= 0) return '';
      return `<tr>
        <td style="padding:4px 8px;font-size:12px;color:#6b7280">${esc(model)}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right">${costs.input ? `$${fmt(costs.input)}` : '—'}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right">${costs.output ? `$${fmt(costs.output)}` : '—'}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right">${costs.thinking ? `$${fmt(costs.thinking)}` : '—'}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right;font-weight:500">$${fmt(t)}</td>
      </tr>`;
    }).filter(Boolean);

    if (rows.length > 0) {
      modelDetail = `
      <details style="margin-top:16px">
        <summary style="cursor:pointer;font-size:13px;color:#6366f1;font-weight:500">Inference model breakdown</summary>
        <table style="width:100%;margin-top:8px;border-collapse:collapse">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:4px 8px;font-size:12px;text-align:left;color:#6b7280;font-weight:500">Model</th>
              <th style="padding:4px 8px;font-size:12px;text-align:right;color:#6b7280;font-weight:500">Input</th>
              <th style="padding:4px 8px;font-size:12px;text-align:right;color:#6b7280;font-weight:500">Output</th>
              <th style="padding:4px 8px;font-size:12px;text-align:right;color:#6b7280;font-weight:500">Thinking</th>
              <th style="padding:4px 8px;font-size:12px;text-align:right;color:#6b7280;font-weight:500">Total</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </details>`;
    }
  }

  return bars.join('') + modelDetail;
}

// ─── Provider Rows ───────────────────────────────────────────────────────────

function buildProviderRows(state, identity) {
  const providers     = (state.balanceSheet.assets && state.balanceSheet.assets.providers) || {};
  const identProviders = (identity && identity.providers) || {};
  const primaryProvider = state.balanceSheet.primaryProvider || (identity && identity.primaryProvider);

  const rows = [];
  for (const [name, bal] of Object.entries(providers)) {
    const idProv = identProviders[name] || {};
    if (!idProv.enabled) continue;

    const isPrimary = name === primaryProvider;
    const badge = isPrimary
      ? '<span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:10px;margin-left:6px">primary</span>'
      : '';

    let balStr = '';
    if (bal.USDC !== undefined) {
      balStr = `USDC: ${fmt(bal.USDC, 2)}`;
      if (bal.ETH) balStr += ` · ETH: ${fmt(bal.ETH, 6)}`;
    } else if (bal.credits !== undefined) {
      balStr = `credits: ${fmt(bal.credits, 0)}`;
    }

    const synced = bal.lastSynced ? timeAgo(bal.lastSynced) : 'never';

    rows.push(`<tr>
      <td style="padding:10px 12px;font-size:13px;font-weight:500">${esc(name)}${badge}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151">${esc(balStr || '—')}</td>
      <td style="padding:10px 12px;font-size:12px;color:#9ca3af">synced ${esc(synced)}</td>
    </tr>`);
  }

  if (rows.length === 0) {
    return '<tr><td colspan="3" style="padding:12px;color:#94a3b8;font-size:13px">No providers connected. Run <code>agentbooks wallet-connect</code>.</td></tr>';
  }
  return rows.join('');
}

// ─── Ledger Table ─────────────────────────────────────────────────────────────

function buildLedgerRows(ledger) {
  const entries = (ledger || []).slice(-50).reverse();
  if (entries.length === 0) {
    return '<tr><td colspan="6" style="padding:12px;color:#94a3b8;text-align:center;font-size:13px">No ledger entries yet.</td></tr>';
  }

  const typeColor = { cost: '#ef4444', income: '#22c55e', deposit: '#6366f1', transfer: '#0ea5e9', adjustment: '#f59e0b' };

  return entries.map(e => {
    const color = typeColor[e.type] || '#64748b';
    const sign  = e.type === 'income' || e.type === 'deposit' ? '+' : '-';
    return `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px 12px;font-size:12px;color:#6b7280;white-space:nowrap">${esc(fmtDate(e.timestamp))}</td>
      <td style="padding:8px 12px"><span style="font-size:11px;font-weight:600;color:${color};background:${color}18;padding:2px 7px;border-radius:10px">${esc(e.type)}</span></td>
      <td style="padding:8px 12px;font-size:13px;font-weight:600;color:${color};text-align:right">${sign}$${fmt(e.amount)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#6b7280">${esc(e.channel || '—')}</td>
      <td style="padding:8px 12px;font-size:12px;color:#9ca3af">${esc(e.source || '—')}</td>
      <td style="padding:8px 12px;font-size:12px;color:#374151">${esc(e.note || '')}</td>
    </tr>`;
  }).join('');
}

// ─── HTML Builder ─────────────────────────────────────────────────────────────

function buildHTML(agentId, state, identity) {
  const fh   = calcFinancialHealth(state, identity);
  const bs   = state.balanceSheet;
  const cp   = state.incomeStatement.currentPeriod;
  const at   = state.incomeStatement.allTime;
  const mode = (identity && identity.mode) || 'development';
  const wallet = (identity && identity.walletAddress) ? identity.walletAddress : null;
  const shortWallet = wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : '—';
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

  const tierC  = tierColor(fh.tier);
  const tierBgC = tierBg(fh.tier);
  const scoreDisplay = mode === 'development' ? '—' : `${(fh.fhs * 100).toFixed(1)}%`;
  const daysDisplay = fh.daysToDepletion !== null && fh.daysToDepletion !== undefined
    ? `${fh.daysToDepletion} days`
    : '—';

  const sparkline   = buildSparkline(state.burnRateHistory, 700, 180);
  const costBars    = buildCostBars(cp.expenses);
  const providerRows = buildProviderRows(state, identity);
  const ledgerRows  = buildLedgerRows(state.ledger);

  const modeBadge = mode === 'production'
    ? '<span style="font-size:11px;background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:10px;font-weight:600">PRODUCTION</span>'
    : '<span style="font-size:11px;background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:10px;font-weight:600">DEVELOPMENT</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentBooks Report — ${esc(agentId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; }
  .container { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
  .header { margin-bottom: 28px; }
  .header h1 { font-size: 22px; font-weight: 700; color: #0f172a; }
  .header .meta { font-size: 13px; color: #64748b; margin-top: 4px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .card-title { font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .stat-label { font-size: 12px; color: #94a3b8; margin-bottom: 2px; }
  .stat-value { font-size: 22px; font-weight: 700; color: #0f172a; }
  .stat-value.sm { font-size: 16px; }
  .stat-value.pos { color: #16a34a; }
  .stat-value.neg { color: #dc2626; }
  .divider { border: none; border-top: 1px solid #f1f5f9; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 12px 10px; }
  code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 14px; font-weight: 700; }
  .rx { margin: 0; padding: 0; list-style: none; }
  .rx li { font-size: 13px; color: #374151; padding: 3px 0; }
  .rx li::before { content: '→ '; color: #94a3b8; }
  @media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <h1>AgentBooks Financial Report</h1>
    <div class="meta">
      <span>Agent: <strong>${esc(agentId)}</strong></span>
      ${wallet ? `<span title="${esc(wallet)}">Wallet: <code>${esc(shortWallet)}</code></span>` : ''}
      <span>${modeBadge}</span>
      <span style="margin-left:auto;color:#9ca3af">Generated ${esc(generatedAt)}</span>
    </div>
  </div>

  <!-- FHS Health Card -->
  <div class="card" style="background:${tierBgC};border-color:${tierC}40">
    <div style="display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap">
      <div style="text-align:center;min-width:100px">
        <div style="font-size:48px;font-weight:800;color:${tierC};line-height:1">${esc(scoreDisplay)}</div>
        <div class="pill" style="background:${tierC};color:#fff;margin-top:8px">${esc(fh.tier.toUpperCase())}</div>
      </div>
      <div style="flex:1;min-width:200px">
        <div class="card-title" style="margin-bottom:12px">Financial Health Score</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
          <div>
            <div class="stat-label">Days to Depletion</div>
            <div class="stat-value sm">${esc(daysDisplay)}</div>
          </div>
          <div>
            <div class="stat-label">Dominant Cost</div>
            <div class="stat-value sm">${esc(fh.dominantCost || '—')}</div>
          </div>
          <div>
            <div class="stat-label">Burn Trend</div>
            <div class="stat-value sm">${esc(fh.trend || '—')}</div>
          </div>
          <div>
            <div class="stat-label">Diagnosis</div>
            <div class="stat-value sm" style="font-size:13px">${esc(fh.diagnosis || '—')}</div>
          </div>
        </div>
        ${fh.prescriptions && fh.prescriptions.length > 0 ? `
        <hr class="divider">
        <div class="stat-label" style="margin-bottom:6px">Prescriptions</div>
        <ul class="rx">${fh.prescriptions.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
  </div>

  <!-- Balance + P&L -->
  <div class="grid2">

    <!-- Balance Sheet -->
    <div class="card">
      <div class="card-title">Balance Sheet</div>
      ${wallet ? `<div style="margin-bottom:14px"><div class="stat-label">Wallet Address</div><code style="font-size:11px;word-break:break-all">${esc(wallet)}</code></div>` : ''}
      <table style="margin-bottom:16px">
        <thead>
          <tr><th>Provider</th><th>Balance</th><th>Sync</th></tr>
        </thead>
        <tbody>${providerRows}</tbody>
      </table>
      <hr class="divider">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div class="stat-label">Operational Balance</div>
          <div class="stat-value sm">$${fmt(bs.operationalBalance, 2)}</div>
        </div>
        <div>
          <div class="stat-label">Total Assets</div>
          <div class="stat-value sm">$${fmt(bs.assets && bs.assets.totalUSDEquivalent, 2)}</div>
        </div>
        <div>
          <div class="stat-label">Liabilities</div>
          <div class="stat-value sm">$${fmt(bs.liabilities && bs.liabilities.total, 2)}</div>
        </div>
        <div>
          <div class="stat-label">Equity</div>
          <div class="stat-value sm ${bs.equity && bs.equity.value >= 0 ? 'pos' : 'neg'}">$${fmt(bs.equity && bs.equity.value, 2)}</div>
        </div>
      </div>
    </div>

    <!-- P&L -->
    <div class="card">
      <div class="card-title">Income Statement</div>
      <div style="margin-bottom:16px">
        <div style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Current Period (${esc(cp.periodStart || '—')} – ${esc(cp.periodEnd || 'present')})</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div>
            <div class="stat-label">Revenue</div>
            <div class="stat-value sm pos">$${fmt(cp.revenue, 2)}</div>
          </div>
          <div>
            <div class="stat-label">Expenses</div>
            <div class="stat-value sm neg">$${fmt(cp.expenses && cp.expenses.total, 2)}</div>
          </div>
          <div>
            <div class="stat-label">Net Income</div>
            <div class="stat-value sm ${cp.netIncome >= 0 ? 'pos' : 'neg'}">$${fmt(cp.netIncome, 2)}</div>
          </div>
        </div>
      </div>
      <hr class="divider">
      <div>
        <div style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">All Time</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div>
            <div class="stat-label">Revenue</div>
            <div class="stat-value sm pos">$${fmt(at.totalRevenue, 2)}</div>
          </div>
          <div>
            <div class="stat-label">Expenses</div>
            <div class="stat-value sm neg">$${fmt(at.totalExpenses, 2)}</div>
          </div>
          <div>
            <div class="stat-label">Net Income</div>
            <div class="stat-value sm ${at.netIncome >= 0 ? 'pos' : 'neg'}">$${fmt(at.netIncome, 2)}</div>
          </div>
        </div>
      </div>
      ${mode === 'production' && cp.openingBalance !== null && cp.openingBalance !== undefined ? (() => {
        const expected = cp.openingBalance + cp.revenue - (cp.expenses && cp.expenses.total || 0);
        const delta = Math.abs(expected - bs.operationalBalance);
        const ok = delta <= 0.01;
        return `<hr class="divider">
        <div style="font-size:12px;color:${ok ? '#16a34a' : '#dc2626'};background:${ok ? '#f0fdf4' : '#fef2f2'};padding:8px 10px;border-radius:6px">
          ${ok ? '✓' : '✗'} Cash flow check: Δ $${delta.toFixed(4)} ${ok ? '(balanced)' : '(discrepancy)'}
        </div>`;
      })() : ''}
    </div>
  </div>

  <!-- Cost Breakdown -->
  <div class="card">
    <div class="card-title">Cost Breakdown — Current Period</div>
    ${costBars}
  </div>

  <!-- Burn Rate Chart -->
  <div class="card">
    <div class="card-title">Daily Burn Rate History</div>
    <div style="overflow-x:auto">${sparkline}</div>
    <div style="font-size:12px;color:#9ca3af;margin-top:8px">Daily rate estimate (USD/day) · last ${Math.min((state.burnRateHistory || []).length, 30)} sessions</div>
  </div>

  <!-- Ledger -->
  <div class="card">
    <div class="card-title">Recent Ledger <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:12px;color:#9ca3af">(last 50 entries)</span></div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Type</th>
            <th style="text-align:right">Amount</th>
            <th>Channel</th>
            <th>Source</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>${ledgerRows}</tbody>
      </table>
    </div>
  </div>

  <div style="text-align:center;font-size:12px;color:#cbd5e1;padding:16px 0">
    AgentBooks v${require('../package.json').version} · ${esc(generatedAt)}
  </div>

</div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { agentId, dataPath } = resolveConfig();
  const startIdx = process.argv[2] === 'report' ? 3 : 2;
  const args     = process.argv.slice(startIdx);
  const outArg   = getArg(args, '--output');

  const adapter  = new JsonFileAdapter(dataPath);
  const state    = adapter.readSync(agentId);
  const identity = adapter.readIdentitySync(agentId);

  const html    = buildHTML(agentId, state, identity);
  const today   = new Date().toISOString().slice(0, 10);
  const outPath = outArg || path.join(process.cwd(), `agentbooks-report-${agentId}-${today}.html`);

  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`Report written to ${outPath}`);
}

if (require.main === module) {
  main();
} else {
  // Exposed for unit tests only — not part of the public API.
  module.exports = {
    __test__: { buildHTML, buildSparkline, buildCostBars, buildProviderRows },
  };
}
