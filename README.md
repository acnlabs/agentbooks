# AgentBooks

Financial management toolkit for AI agents — framework-agnostic, works with any agent runtime.

**Version:** 0.1.2

## What it is

AgentBooks gives AI agents a real, double-entry financial ledger. Agents track their costs (LLM inference, runtime, custom), record confirmed income, maintain a balance sheet against real crypto wallets, and compute a Financial Health Score (FHS) that reflects their operational sustainability.

AgentBooks is a **financial dimension provider**. It does not make behavioral decisions — it computes facts and exposes them. Host frameworks (like OpenPersona) aggregate the financial dimension into a broader Vitality score and map it to agent behavior.

## Installation

```bash
# Standalone
npm install -g agentbooks

# As a module (within a monorepo or framework)
npm install agentbooks
```

## Quick Start

```bash
# Set your agent ID
export AGENTBOOKS_AGENT_ID=my-agent

# Initialize wallet
agentbooks wallet-init

# Connect a real provider (switches to production mode)
agentbooks wallet-connect --provider coinbase-cdp

# Check financial health
agentbooks status

# Generate a self-contained HTML report (open in browser)
agentbooks report

# Record a cost (manual)
agentbooks record-cost --channel inference --amount 0.005 --note "code review"

# Record confirmed income
agentbooks record-income --amount 10.00 --quality high --confirmed

# Pre-conversation health check (outputs FINANCIAL_HEALTH_REPORT)
agentbooks guard
```

## HTML Report

Generate a self-contained HTML file for human review — no external dependencies, open directly in a browser:

```bash
agentbooks report                          # saves agentbooks-report-<id>-<date>.html
agentbooks report --output ./report.html   # custom output path
```

The report includes: Financial Health Score with tier badge, wallet & provider balances, P&L (current period + all time), cost breakdown by channel, daily burn rate trend chart (SVG), and the last 50 ledger entries.

## Runner Integration

Runners call `economy-hook` after each conversation to record LLM costs automatically.

**Environment variables (runner sets these):**

| Variable | Description |
|---|---|
| `AGENTBOOKS_AGENT_ID` | Agent identifier |
| `AGENTBOOKS_DATA_PATH` | Data directory (default: `~/.agentbooks/<id>/`) |
| `TOKEN_INPUT_COUNT` | Input token count for this conversation |
| `TOKEN_OUTPUT_COUNT` | Output token count |
| `TOKEN_THINKING_COUNT` | Thinking token count (optional) |
| `LLM_MODEL` | Model name (e.g. `claude-sonnet-4`) |
| `CONVERSATION_DURATION_MS` | Duration in ms (for burn rate estimate) |

```bash
# Runner calls this at end of every conversation
TOKEN_INPUT_COUNT=1500 TOKEN_OUTPUT_COUNT=800 LLM_MODEL=claude-sonnet-4 \
  agentbooks hook
```

## Data Location

**Standalone:** `~/.agentbooks/<agentId>/`
- `economic-state.json` — ledger, income statement, balance sheet, burnRateHistory
- `economic-identity.json` — provider config, model pricing, wallet address

**OpenPersona integration:** `~/.openclaw/economy/persona-<slug>/` (set via `AGENTBOOKS_DATA_PATH`)

## Financial Health Score (FHS)

The FHS is a 0–1 composite score, not exposed to agents as a raw number but mapped to tiers:

| Tier | Meaning |
|---|---|
| `uninitialized` | Development mode or no real provider connected |
| `normal` | FHS ≥ 0.50 and runway ≥ 14 days |
| `optimizing` | FHS < 0.50 or runway < 14 days |
| `critical` | FHS < 0.20 or runway < 3 days |
| `suspended` | Balance ≤ 0 |

**Dimensions (weights):**
- Liquidity 0.40 — days of runway
- Profitability 0.30 — net income rate
- Efficiency 0.15 — revenue/expense ratio
- Trend 0.15 — recent burn rate direction

## Data Integrity

Three-layer defense against fabricated financial data:

1. **Provider is source of truth** — operational balance mirrors the external provider; balance cannot be directly set via CLI
2. **Cash flow reconciliation** — `openingBalance + revenue - expenses ≈ operationalBalance`; discrepancy > $0.01 appends to `integrityWarnings` (production mode only)
3. **Ledger source field** — every entry tagged `agent` | `runner` | `provider_sync`; runner entries are trusted; agent entries are auditable

## Supported Providers

| Provider | Assets | Status |
|---|---|---|
| `coinbase-cdp` | USDC, ETH on Base | Integration ready (SDK call reserved) |
| `acn` | ACN credits | Integration ready |
| `onchain` | USDC, ETH on Base | Integration ready |

## OpenPersona Integration

AgentBooks exports `calcFinancialHealth(state, identity)` as its public API. OpenPersona's `lib/vitality.js` consumes this as the financial dimension in its Vitality aggregator.

```bash
# OpenPersona-specific Vitality report (aggregates financial + future dimensions)
openpersona vitality <slug>

# AgentBooks standalone report
agentbooks guard
```

## API

```js
const {
  calcFinancialHealth,       // (state, identity) → { fhs, tier, diagnosis, prescriptions, ... }
  createInitialState,        // (agentId) → initial economic-state.json
  createIdentityInitialState,// (agentId) → initial economic-identity.json
  createLedgerEntry,         // (type, channel, amount, opts) → ledger entry
  addToExpenseAccount,       // (state, identity, opts) → mutates state
  shouldRollover,            // (state) → boolean
  rolloverPeriod,            // (state) → mutates state
  deductFromProvider,        // (state, identity, amountUSD) → mutates state
  creditToProvider,          // (state, identity, amountUSD) → mutates state
  validateState,             // (state, identity) → mutates derived fields
} = require('agentbooks');
```

## License

MIT
