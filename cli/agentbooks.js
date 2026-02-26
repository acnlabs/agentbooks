#!/usr/bin/env node
'use strict';

/**
 * agentbooks — unified CLI entry point
 *
 * Framework-agnostic financial management for AI agents.
 * No dependency on OpenPersona, OpenClaw, or any other framework.
 *
 * Usage:
 *   agentbooks guard              Pre-conversation financial health check
 *   agentbooks hook [opts]        Post-conversation cost recording
 *   agentbooks <command> [opts]   Any economy.js command
 *
 * Configuration (environment variables):
 *   AGENTBOOKS_AGENT_ID    Agent identifier (default: 'default')
 *   AGENTBOOKS_DATA_PATH   Data directory   (default: ~/.agentbooks/<agentId>/)
 *
 * Examples:
 *   AGENTBOOKS_AGENT_ID=my-agent agentbooks guard
 *   AGENTBOOKS_AGENT_ID=my-agent agentbooks hook --input 1200 --output 800 --model gpt-4o
 *   AGENTBOOKS_AGENT_ID=my-agent agentbooks status
 *   AGENTBOOKS_AGENT_ID=my-agent agentbooks wallet-init
 */

const path = require('path');

const cmd  = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
agentbooks v${require('../package.json').version}
Financial management for AI agents — framework-agnostic

Usage:
  agentbooks guard              Pre-conversation financial health check
  agentbooks hook [options]     Post-conversation cost recording
  agentbooks wallet-init        Initialize wallet (idempotent)
  agentbooks wallet-connect     Connect a real provider
  agentbooks set-primary        Set primary provider
  agentbooks sync               Sync provider balance
  agentbooks record-cost        Record an expense
  agentbooks record-income      Record income
  agentbooks balance            Asset balance sheet
  agentbooks status             Full financial report
  agentbooks pl                 Income statement
  agentbooks financial-health   FHS score
  agentbooks ledger             Transaction history

Environment:
  AGENTBOOKS_AGENT_ID    Agent identifier (default: 'default')
  AGENTBOOKS_DATA_PATH   Data directory   (default: ~/.agentbooks/<id>/)
`.trim());
  process.exit(0);
}

// Route to the appropriate script
switch (cmd) {
  case 'guard':
    require('./economy-guard');
    break;
  case 'hook':
    require('./economy-hook');
    break;
  default:
    // Delegate to economy.js (all management commands)
    require('./economy');
    break;
}
