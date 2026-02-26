# AgentBooks — Coding Agent Guide

Financial management toolkit for AI agents. This is a standalone CommonJS package inside the OpenPersona monorepo (`packages/agentbooks/`).

## Setup

```bash
cd packages/agentbooks
node --test tests/agentbooks.test.js   # run agentbooks tests only
```

To run the full OpenPersona suite (includes agentbooks):

```bash
cd /path/to/OpenPersona
node --test tests/                     # 234 tests, must all pass
```

No build step — plain CommonJS, Node.js ≥ 18, no transpilation.

## Project Structure

```
src/
  schema.js          ← createInitialState / createIdentityInitialState / createLedgerEntry
  providers.js       ← calcTotalUSDEquivalent / deduct / credit / syncProvider
  ledger.js          ← addToExpenseAccount / recalcExpensesTotal / appendLedger
  period.js          ← shouldRollover / rolloverPeriod / appendBurnRate
  financial-health.js ← calcFinancialHealth (FHS engine — the core algorithm)
  reconcile.js       ← validateState (equity + cash flow integrity check)
  index.js           ← public API re-exports

adapters/
  json-file.js       ← persistent storage (readSync/writeSync + v2.x→v1.0.0 migration)
  in-memory.js       ← test adapter (same interface as json-file)

cli/
  agentbooks.js      ← unified bin entry point (routes to guard / hook / economy)
  economy-guard.js   ← pre-conversation FINANCIAL_HEALTH_REPORT
  economy-hook.js    ← post-conversation cost recorder (source: 'runner')
  economy.js         ← all management commands (wallet-init, status, record-cost, …)

tests/
  agentbooks.test.js ← 30 unit tests covering all src/ modules
```

## Code Style

- **CommonJS** (`require` / `module.exports`) — no ES modules
- **Single quotes** for strings
- **No external dependencies** — pure Node.js standard library only
- `crypto.randomUUID()` for IDs, `new Date().toISOString()` for timestamps
- Monetary values: `parseFloat(value.toFixed(6))` — always 6 decimal places

## Architecture Rules

### Adapter interface contract

Both adapters implement the same synchronous interface:

```js
adapter.readSync(agentId)          → state object
adapter.writeSync(agentId, state)  → void (calls validateState before write)
adapter.readIdentitySync(agentId)  → identity object | null
adapter.writeIdentitySync(agentId, identity) → void
```

Always use the adapter interface — never read/write files directly in src/ modules.

### Financial data flow

```
Runner env vars (TOKEN_INPUT_COUNT etc.)
    ↓
economy-hook.js  [source: 'runner']
    ↓
addToExpenseAccount → ledger entry
    ↓
adapter.writeSync → validateState → reconcile.js
    ↓
json-file.js writes economic-state.json
```

### Derived fields rule

`validateState` recomputes:
- `balanceSheet.assets.totalUSDEquivalent`
- `balanceSheet.equity.value`
- `integrityWarnings` (cash flow check, production mode only)

Never set these fields manually — let `validateState` own them.

### No local provider

The `local` provider was removed in v0.1.0. There is no fallback simulated balance. If no real provider is connected, `mode` stays `'development'` and `calcFinancialHealth` returns `tier: 'uninitialized'`. Do not reintroduce a local/mock provider.

### Source field on ledger entries

Every ledger entry has a `source` field:
- `'runner'` — injected by economy-hook (Runner-provided token counts, trusted)
- `'agent'` — Agent-initiated via CLI (record-cost, record-income)
- `'provider_sync'` — written during external provider balance sync

Set `source` explicitly when calling `createLedgerEntry`. Default is `'agent'`.

### calcFinancialHealth vs calcVitality

- `calcFinancialHealth(state, identity)` — AgentBooks public API, financial dimension only
- `calcVitality(agentId, adapter)` — OpenPersona aggregator in `lib/vitality.js`, uses AgentBooks as a dependency

AgentBooks must never import from OpenPersona. The dependency is one-way.

## Data Locations

| Context | Path |
|---|---|
| Standalone | `~/.agentbooks/<agentId>/` |
| OpenPersona integration | `~/.openclaw/economy/persona-<slug>/` |
| Override | `AGENTBOOKS_DATA_PATH` env var |

## Testing

```bash
node --test tests/agentbooks.test.js
```

Tests use `InMemoryAdapter` — no filesystem side effects, no cleanup needed.

When adding a new feature:
1. Add unit tests in `tests/agentbooks.test.js` using `InMemoryAdapter`
2. Verify migration path if `economic-state.json` schema changes (bump `version`, add migration branch in `json-file.js`)
3. Run the full OpenPersona suite to ensure no regressions

## Versioning

Version is `0.1.0` in `packages/agentbooks/package.json`.

When bumping the version:
1. Update `packages/agentbooks/package.json`
2. Update `packages/agentbooks/skill/agentbooks/SKILL.md` frontmatter `metadata.version`
3. Update `packages/agentbooks/README.md`
