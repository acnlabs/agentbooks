'use strict';

/**
 * Provider management — balance sync, credit/debit, USD conversion.
 *
 * Supported providers:
 *   coinbase-cdp  — USDC / ETH on Base network
 *   acn           — ACN credits (Agent Commerce Network)
 *   onchain       — generic onchain wallet (USDC / ETH)
 *
 * All balance mutations go through deductFromProvider / creditToProvider so
 * that totalUSDEquivalent is always recalculated consistently.
 */

const SUPPORTED_PROVIDERS = ['coinbase-cdp', 'acn', 'onchain'];

// ─── USD Conversion ──────────────────────────────────────────────────────────

/**
 * Calculate total USD equivalent across all providers.
 * Uses exchange rates from identity (falls back to sensible defaults).
 *
 * @param {object} state
 * @param {object|null} identity
 * @returns {number}
 */
function calcTotalUSDEquivalent(state, identity) {
  const rates = (identity && identity.exchangeRates) || { ETH: 2500, credits: 0.01 };
  const providers = state.balanceSheet.assets.providers;
  let total = 0;

  const cdp = providers['coinbase-cdp'];
  if (cdp) {
    total += (cdp.USDC || 0);
    total += (cdp.ETH  || 0) * (rates.ETH || 2500);
  }

  const acn = providers['acn'];
  if (acn) {
    total += (acn.credits || 0) * (rates.credits || 0.01);
  }

  const onchain = providers['onchain'];
  if (onchain) {
    total += (onchain.USDC || 0);
    total += (onchain.ETH  || 0) * (rates.ETH || 2500);
  }

  return parseFloat(total.toFixed(6));
}

// ─── Balance Read ────────────────────────────────────────────────────────────

/**
 * Get the USD balance of a specific provider.
 */
function getProviderBalance(state, identity, providerName) {
  const rates    = (identity && identity.exchangeRates) || { ETH: 2500, credits: 0.01 };
  const provider = state.balanceSheet.assets.providers[providerName];
  if (!provider) return 0;

  switch (providerName) {
    case 'coinbase-cdp':
    case 'onchain':
      return (provider.USDC || 0) + (provider.ETH || 0) * (rates.ETH || 2500);
    case 'acn':
      return (provider.credits || 0) * (rates.credits || 0.01);
    default:
      return 0;
  }
}

// ─── Provider Sync ───────────────────────────────────────────────────────────

/**
 * Sync balance from an external provider.
 *
 * In production this would call the actual provider SDK/API.
 * For now, the function reads from the provider config in identity and
 * returns the current cached balance (real integration per provider is
 * implemented outside this module — the CLI commands call syncProvider
 * after obtaining the real balance via the provider's SDK).
 *
 * Returns the synced USD balance for the primary provider.
 */
function syncProvider(state, identity, providerName) {
  if (!providerName || !SUPPORTED_PROVIDERS.includes(providerName)) return 0;

  const provider = state.balanceSheet.assets.providers[providerName];
  if (!provider) return 0;

  provider.lastSynced = new Date().toISOString();
  const balance = getProviderBalance(state, identity, providerName);
  return balance;
}

/**
 * Update a provider's raw balance fields after an external sync.
 * Called by wallet-sync command after obtaining real balance from provider API.
 */
function setProviderBalance(state, providerName, balanceFields) {
  const provider = state.balanceSheet.assets.providers[providerName];
  if (!provider) return;
  Object.assign(provider, balanceFields);
  provider.lastSynced = new Date().toISOString();
}

// ─── Deduct / Credit ─────────────────────────────────────────────────────────

/**
 * Deduct amount (USD) from primary provider.
 * In development mode, allows negative balance.
 */
function deductFromProvider(state, identity, amountUSD) {
  const mode         = (identity && identity.mode) || 'development';
  const primaryName  = state.balanceSheet.primaryProvider;
  if (!primaryName) return;

  const provider = state.balanceSheet.assets.providers[primaryName];
  if (!provider) return;

  switch (primaryName) {
    case 'coinbase-cdp':
    case 'onchain':
      if (provider.USDC >= amountUSD || mode === 'development') {
        provider.USDC = parseFloat(((provider.USDC || 0) - amountUSD).toFixed(6));
      }
      break;
    case 'acn': {
      const rates   = (identity && identity.exchangeRates) || { credits: 0.01 };
      const credits = amountUSD / (rates.credits || 0.01);
      if (provider.credits >= credits || mode === 'development') {
        provider.credits = parseFloat(((provider.credits || 0) - credits).toFixed(6));
      }
      break;
    }
  }

  // Update operational balance mirror
  state.balanceSheet.operationalBalance = getProviderBalance(state, identity, primaryName);
}

/**
 * Credit amount (USD) to primary provider.
 */
function creditToProvider(state, identity, amountUSD) {
  const primaryName = state.balanceSheet.primaryProvider;
  if (!primaryName) return;

  const provider = state.balanceSheet.assets.providers[primaryName];
  if (!provider) return;

  switch (primaryName) {
    case 'coinbase-cdp':
    case 'onchain':
      provider.USDC = parseFloat(((provider.USDC || 0) + amountUSD).toFixed(6));
      break;
    case 'acn': {
      const rates   = (identity && identity.exchangeRates) || { credits: 0.01 };
      const credits = amountUSD / (rates.credits || 0.01);
      provider.credits = parseFloat(((provider.credits || 0) + credits).toFixed(6));
      break;
    }
  }

  state.balanceSheet.operationalBalance = getProviderBalance(state, identity, primaryName);
}

module.exports = {
  SUPPORTED_PROVIDERS,
  calcTotalUSDEquivalent,
  getProviderBalance,
  syncProvider,
  setProviderBalance,
  deductFromProvider,
  creditToProvider,
};
