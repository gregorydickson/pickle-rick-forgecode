#!/usr/bin/env node
/**
 * init-microverse.js — Microverse session setup CLI.
 *
 * Creates microverse.json with initial state for the convergence loop.
 * ESM module, zero external deps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { StateManager } from '../lib/state-manager.js';

const VALID_MODES = new Set(['metric', 'worker']);
const VALID_METRIC_TYPES = new Set(['command', 'llm', 'none']);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
export function parseInitArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'stall-limit': { type: 'string', default: '3' },
      'convergence-target': { type: 'string' },
      'convergence-mode': { type: 'string', default: 'metric' },
      'convergence-file': { type: 'string' },
      'metric-json': { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });

  const ct = values['convergence-target'];

  return {
    sessionDir: positionals[0] || undefined,
    targetPath: positionals[1] || undefined,
    stallLimit: parseInt(values['stall-limit'], 10),
    convergenceTarget: ct !== undefined ? parseFloat(ct) : null,
    convergenceMode: values['convergence-mode'],
    convergenceFile: values['convergence-file'] || null,
    metricJson: values['metric-json'] || undefined,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function validateArgs(args) {
  if (!args.sessionDir) {
    return { valid: false, error: 'Missing required argument: session-dir' };
  }
  if (!args.targetPath) {
    return { valid: false, error: 'Missing required argument: target-path' };
  }
  if (!VALID_MODES.has(args.convergenceMode)) {
    return { valid: false, error: `Invalid convergence-mode: "${args.convergenceMode}". Must be metric or worker` };
  }
  if (!Number.isFinite(args.stallLimit) || args.stallLimit < 1) {
    return { valid: false, error: `Invalid stall-limit: must be a positive integer` };
  }
  if (args.convergenceMode === 'metric') {
    if (!args.metricJson) {
      return { valid: false, error: '--metric-json is required when convergence-mode is metric' };
    }
    let parsed;
    try {
      parsed = JSON.parse(args.metricJson);
    } catch {
      return { valid: false, error: '--metric-json must be valid JSON' };
    }
    if (!parsed.description) {
      return { valid: false, error: 'metric-json missing required field: description' };
    }
    if (!parsed.validation) {
      return { valid: false, error: 'metric-json missing required field: validation' };
    }
    if (!parsed.type) {
      return { valid: false, error: 'metric-json missing required field: type' };
    }
    if (!VALID_METRIC_TYPES.has(parsed.type)) {
      return { valid: false, error: `Invalid metric type: "${parsed.type}". Must be command, llm, or none` };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// State builder
// ---------------------------------------------------------------------------
export function buildMicroverseState(args) {
  const keyMetric = args.metricJson ? JSON.parse(args.metricJson) : null;

  return {
    schema_version: 1,
    status: 'gap_analysis',
    target_path: args.targetPath,
    prd_path: null,
    gap_analysis_path: null,
    key_metric: keyMetric,
    convergence: {
      stall_limit: args.stallLimit,
      stall_counter: 0,
      history: [],
    },
    convergence_target: args.convergenceTarget ?? null,
    convergence_mode: args.convergenceMode,
    convergence_file: args.convergenceFile ?? null,
    failed_approaches: [],
    baseline_score: 0,
    exit_reason: null,
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export function initMicroverse(args) {
  const state = buildMicroverseState(args);
  fs.mkdirSync(args.sessionDir, { recursive: true });
  const sm = new StateManager();
  const statePath = path.join(args.sessionDir, 'microverse.json');
  sm.forceWrite(statePath, state);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function main() {
  const args = parseInitArgs(process.argv.slice(2));
  const validation = validateArgs(args);
  if (!validation.valid) {
    process.stderr.write(`Error: ${validation.error}\n`);
    process.exit(1);
  }
  initMicroverse(args);
  process.exit(0);
}

if (process.argv[1]?.endsWith('init-microverse.js')) {
  main();
}
