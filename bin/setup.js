#!/usr/bin/env node
/**
 * setup.js — Session initializer CLI for ForgeCode.
 *
 * Creates session dir, writes state.json, outputs SESSION_ROOT=<path>.
 * ESM module, zero external deps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
export function parseSetupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      tmux: { type: 'boolean', default: false },
      'max-iterations': { type: 'string', default: '100' },
      'max-time': { type: 'string', default: '720' },
      'worker-timeout': { type: 'string', default: '1200' },
      resume: { type: 'string' },
      reset: { type: 'boolean', default: false },
    },
    strict: false,
  });

  return {
    task: values.task,
    tmux: values.tmux ?? false,
    maxIterations: parseInt(values['max-iterations'], 10),
    maxTime: parseInt(values['max-time'], 10),
    workerTimeout: parseInt(values['worker-timeout'], 10),
    resume: values.resume,
    reset: values.reset ?? false,
  };
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------
export function createSession(args, root) {
  const today = new Date().toISOString().slice(0, 10);
  const hash = crypto.randomBytes(4).toString('hex');
  const dirName = `${today}-${hash}`;
  const sessionRoot = path.join(root, 'sessions', dirName);

  fs.mkdirSync(sessionRoot, { recursive: true });

  const state = {
    schema_version: 1,
    active: false,
    pid: process.pid,
    iteration: 0,
    max_iterations: args.maxIterations,
    step: 'prd',
    working_dir: process.cwd(),
    current_ticket: null,
    start_time_epoch: Date.now(),
    max_time_minutes: args.maxTime,
    history: [],
    tickets: [],
    session_dir: sessionRoot,
    tmux_mode: args.tmux,
    worker_timeout_sec: args.workerTimeout,
    task: args.task,
    auto_dump_path: path.join(sessionRoot, 'auto_dump.json'),
  };

  fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify(state, null, 2));
  return sessionRoot;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------
export function resumeSession(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found in ${sessionDir}`);
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
export function resetSession(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found in ${sessionDir}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.iteration = 0;
  state.active = true;
  state.step = 'prd';
  state.start_time_epoch = Date.now();
  state.pid = process.pid;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function main() {
  const args = parseSetupArgs(process.argv.slice(2));

  if (args.reset && args.resume) {
    resetSession(args.resume);
    process.stdout.write(`SESSION_ROOT=${args.resume}\n`);
    return;
  }

  if (args.resume) {
    resumeSession(args.resume);
    process.stdout.write(`SESSION_ROOT=${args.resume}\n`);
    return;
  }

  if (!args.task) {
    process.stderr.write('Error: --task is required for new sessions\n');
    process.exit(1);
  }

  const root = process.env.FORGECODE_SESSION_ROOT || process.cwd();
  const sessionRoot = createSession(args, root);
  process.stdout.write(`SESSION_ROOT=${sessionRoot}\n`);
}

if (process.argv[1]?.endsWith('setup.js')) {
  main();
}
