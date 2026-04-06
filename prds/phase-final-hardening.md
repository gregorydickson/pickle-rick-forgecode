# PRD: Final Hardening Pass — ForgeCode Pickle Rick Port

## Overview

Final review of the completed 4-phase build (468 tests passing) found 3 P0 runtime blockers, 16 P1 gaps, and 13 P2 issues. The lib/ layer is ship-quality. The bin/ layer has critical issues that would prevent real `forge` binary execution: missing `--agent` flags, incorrect spawn arg formats, missing git safety invariants, and non-functional CLI entry points.

This PRD fixes all P0s, all high-impact P1s, and adds validation tests to prevent regressions.

**Working directory**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-forgecode`
**Test runner**: `node --test tests/*.test.js`
**Module format**: ESM
**Constraint**: All 468 existing tests must still pass after changes.

---

## Ticket 1: Fix `forge -p --agent` Spawn Invocations (ALL bin/ scripts)

**Priority**: P0 — runtime blocker, nothing works without this
**Files**: `bin/tmux-runner.js`, `bin/microverse-runner.js`, `tests/tmux-runner.test.js`, `tests/microverse-runner.test.js`

### Problem

1. `tmux-runner.js:93,201` passes agent filename as prompt text: `spawn('forge', ['-p', agentFile])`. Should be `spawn('forge', ['-p', handoffContent, '--agent', agentId])`.
2. `microverse-runner.js:121,152,199` passes spawn args as positional strings, not array. `spawn('forge', '-p', agentId, {...})` treats `'-p'` as the args and `agentId` as options. Must be `spawn('forge', ['-p', handoffContent, '--agent', agentId], {...})`.
3. Both scripts need `--agent` flag to select the ForgeCode agent definition, not pass the .md filename as prompt.

### Fix

Standardize all `forge -p` invocations across both scripts:
```javascript
spawn('forge', [
  '-p', handoffContent,
  '--agent', agentId,        // e.g., 'microverse-worker', NOT 'microverse-worker.md'
  '-C', workingDir           // ensure forge runs in correct directory
], { cwd: workingDir, ... })
```

The agent ID is the `id` field from the agent YAML frontmatter (e.g., `microverse-worker`), not the filename.

### Acceptance Criteria

- [ ] tmux-runner sequential worker: spawn args include `--agent` flag with correct agent ID — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "spawn-agent-flag"` — Type: test
- [ ] tmux-runner parallel worker: spawn args include `--agent` flag — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-agent-flag"` — Type: test
- [ ] microverse-runner worker spawn: args is array with `--agent` — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "spawn-agent-flag"` — Type: test
- [ ] microverse-runner judge spawn: args is array with `--agent microverse-judge` — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "judge-agent-flag"` — Type: test
- [ ] microverse-runner analyst spawn: args is array with `--agent microverse-analyst` — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "analyst-agent-flag"` — Type: test
- [ ] All spawn calls pass `-C workingDir` flag — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "spawn-cwd-flag"` — Type: test
- [ ] No spawn call passes `.md` filename as prompt or agent — Verify: `grep -rn '\.md' bin/tmux-runner.js bin/microverse-runner.js | grep -v '//' | grep -c 'spawn'` outputs `0` — Type: lint

---

## Ticket 2: Fix `setup.js` Initial State Values

**Priority**: P1 — contradicts PRD, breaks crash recovery semantics
**Files**: `bin/setup.js`, `tests/setup.test.js`

### Problem

1. `setup.js:55` sets `active: true`. PRD says `active: false` — runner takes ownership by flipping to true.
2. `setup.js:59` sets `step: 'research'`. PRD says `step: 'prd'` — first phase of lifecycle.
3. Missing `tickets: []` array — tmux-runner references `state.tickets` which would be `undefined`.
4. Missing `auto_dump_path` — falls back to shared `/tmp/auto_dump.json`, unsafe with concurrent sessions.

### Fix

```javascript
const initialState = {
  active: false,                    // Runner takes ownership
  step: 'prd',                      // First phase
  iteration: 0,
  max_iterations: maxIterations,
  max_time_minutes: maxTime,
  worker_timeout_seconds: workerTimeout,
  start_time_epoch: Math.floor(Date.now() / 1000),
  working_dir: workingDir,
  session_dir: sessionDir,
  current_ticket: null,
  tickets: [],                      // Initialize empty
  auto_dump_path: path.join(sessionDir, 'auto_dump.json'),  // Per-session
  schema_version: 1,
  pid: null,                        // Set by runner on ownership
  original_prompt: task,
  // ...existing fields
};
```

### Acceptance Criteria

- [ ] Initial state has `active: false` — Verify: `node --test tests/setup.test.js --test-name-pattern "active-false"` — Type: test
- [ ] Initial state has `step: 'prd'` — Verify: `node --test tests/setup.test.js --test-name-pattern "step-prd"` — Type: test
- [ ] Initial state has `tickets: []` — Verify: `node --test tests/setup.test.js --test-name-pattern "tickets-array"` — Type: test
- [ ] Initial state has per-session `auto_dump_path` — Verify: `node --test tests/setup.test.js --test-name-pattern "auto-dump-path"` — Type: test

---

## Ticket 3: Harden `microverse-runner.js` Git Safety + State Persistence

**Priority**: P1 — data loss risk on rollback and crash
**Files**: `bin/microverse-runner.js`, `tests/microverse-runner.test.js`

### Problem

1. `line 232`: `git reset --hard` without `git stash` first — violates PRD Git Safety Invariant 4
2. `line 232`: No `git clean -fd` after reset — violates PRD Git Safety Invariant 5
3. No dirty-tree auto-commit between iterations — PRD orchestrator loop step 5
4. `preflight()` exported but never called from `runMicroverse`
5. Gap analysis phase (lines 149-158) skips baseline measurement — PRD step 0b
6. State mutations (convergence history, failed approaches, stall counter) done on local object, not persisted via StateManager until much later — crash between mutations loses data

### Fix

**3a: Git safety in rollback:**
```javascript
// Before reset
const stashRef = await git.stash();
await git.resetToSha(preSha);  // resetToSha already does reset --hard + clean -fd
// Record stash ref in state
sm.update(statePath, s => { s.stash_ref = stashRef; });
```

**3b: Dirty-tree check after each iteration:**
```javascript
// After worker exits, before metric measurement
if (await git.isDirty()) {
  await git.autoCommit('microverse: auto-commit worker changes');
}
```

**3c: Call preflight before first iteration:**
```javascript
async function runMicroverse(deps) {
  await preflight(deps);  // Auto-commit dirty tree, validate clean state
  // ... gap analysis ...
  // ... iteration loop ...
}
```

**3d: Baseline measurement after gap analysis:**
```javascript
if (state.status === 'gap_analysis') {
  await runGapAnalysis(deps);
  const baseline = await measureMetric(deps);
  sm.update(mvPath, s => {
    s.baseline_score = baseline?.score ?? 0;
    s.status = 'iterating';
  });
}
```

**3e: Persist state after every mutation:**
```javascript
// After each metric comparison and decision
sm.update(mvPath, s => {
  s.convergence.history.push(entry);
  s.convergence.stall_counter = newStallCount;
  if (regressed) s.failed_approaches.push(description);
});
// NOT: mutate local object, hope it gets written later
```

### Acceptance Criteria

- [ ] Rollback calls stash before reset — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "stash-before-reset"` — Type: test
- [ ] Rollback records stash_ref in state — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "stash-ref-persisted"` — Type: test
- [ ] Dirty tree auto-committed after worker exits — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "auto-commit-dirty"` — Type: test
- [ ] Preflight called before first iteration — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "preflight-called"` — Type: test
- [ ] Gap analysis measures baseline and persists score — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "baseline-measurement"` — Type: test
- [ ] Convergence history persisted via StateManager after each iteration — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "state-persisted-each-iteration"` — Type: test
- [ ] Failed approaches persisted immediately on regression — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "failed-approach-persisted"` — Type: test

---

## Ticket 4: Add Hang Guards to tmux-runner and microverse-runner

**Priority**: P1 — hung process blocks loop forever
**Files**: `bin/tmux-runner.js`, `bin/microverse-runner.js`, `tests/tmux-runner.test.js`, `tests/microverse-runner.test.js`

### Problem

Both scripts have SIGTERM → SIGKILL escalation but no hang guard. If SIGKILL fails (zombie, FUSE mount), the promise never resolves and the loop hangs forever. PRD specifies hang guard at `timeout + 30s`.

### Fix

```javascript
// After SIGKILL escalation timer
const hangGuard = setTimeout(() => {
  console.error('Hang guard triggered — force-resolving');
  resolve({ status: 'error', reason: 'hang_guard' });
}, (timeoutSeconds + 30) * 1000);
hangGuard.unref();  // Don't keep process alive for the guard
```

### Acceptance Criteria

- [ ] tmux-runner hang guard fires at timeout+30s — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "hang-guard"` — Type: test
- [ ] microverse-runner hang guard fires at timeout+30s — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "hang-guard"` — Type: test
- [ ] Hang guard resolves with error status, doesn't crash — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "hang-guard-resolves"` — Type: test

---

## Ticket 5: Fix `spawn-refinement-team.js` CLI Entry + Arg Size

**Priority**: P1 — script cannot be run from command line
**Files**: `bin/spawn-refinement-team.js`, `tests/refinement-team.test.js`

### Problem

1. No CLI entry point — PRD specifies `bin/spawn-refinement-team.js --prd <path> --session-dir <path> [flags]` but file only exports a library function.
2. Full PRD content + all prior analyses concatenated as `forge -p` prompt arg — will exceed OS argv limit (~256KB on macOS) for large PRDs.

### Fix

**5a: Add CLI entry point:**
```javascript
if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-refinement-team.js') {
  const args = parseArgs(process.argv.slice(2));
  // Wire deps from real implementations
  const deps = { spawn: child_process.spawn, ... };
  spawnRefinementTeam({ ...args, ...deps })
    .then(manifest => { process.exit(manifest.all_success ? 0 : 1); })
    .catch(err => { console.error(err); process.exit(1); });
}
```

**5b: Write prompt to temp file, pass path:**
```javascript
// Instead of: ['-p', entirePromptString, '--agent', agentName]
const promptFile = path.join(sessionDir, `refinement_prompt_${role}_c${cycle}.txt`);
fs.writeFileSync(promptFile, prompt);
// Use: ['-p', `@${promptFile}`, '--agent', agentName]
// OR pipe via stdin: spawn('forge', ['--agent', agentName], { stdin: promptFile })
```

If ForgeCode doesn't support `@file` syntax, write prompt to file and use `cat promptFile | forge --agent agentName` pattern.

### Acceptance Criteria

- [ ] CLI parses `--prd`, `--session-dir`, `--timeout`, `--cycles`, `--max-turns` — Verify: `node --test tests/refinement-team.test.js --test-name-pattern "cli-args"` — Type: test
- [ ] CLI exits 0 on all success, 1 on any failure — Verify: `node --test tests/refinement-team.test.js --test-name-pattern "cli-exit-codes"` — Type: test
- [ ] Prompt written to temp file, not passed as argv — Verify: `node --test tests/refinement-team.test.js --test-name-pattern "prompt-file"` — Type: test
- [ ] Prompt temp files cleaned up after worker exits — Verify: `node --test tests/refinement-team.test.js --test-name-pattern "prompt-cleanup"` — Type: test

---

## Ticket 6: Fix Parallel Worker Issues in tmux-runner

**Priority**: P1 — parallel workers broken
**Files**: `bin/tmux-runner.js`, `tests/tmux-runner.test.js`

### Problem

1. `getCurrentSha()` in parallel worker reads main repo HEAD, not worktree HEAD — cherry-picks wrong commit.
2. Parallel workers have no timeout — hung worker blocks forever.
3. CLI `main()` doesn't provide `createWorktree`, `removeWorktree`, `cherryPick` in deps — parallel workers throw on first use.

### Fix

**6a: Pass `cwd` to git operations in worktree context:**
```javascript
const worktreeSha = git.getCurrentSha({ cwd: worktreePath });
git.cherryPick(worktreeSha, { cwd: mainWorkingDir });
```

**6b: Add timeout to parallel workers (same SIGTERM→SIGKILL→hang guard pattern).**

**6c: Wire worktree deps in CLI main:**
```javascript
const deps = {
  // ...existing deps
  createWorktree: git.createWorktree,
  removeWorktree: git.removeWorktree,
  cherryPick: git.cherryPick,
};
```

### Acceptance Criteria

- [ ] Parallel worker cherry-pick uses worktree SHA, not main HEAD — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-worktree-sha"` — Type: test
- [ ] Parallel workers have timeout with SIGTERM→SIGKILL — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-timeout"` — Type: test
- [ ] CLI main provides worktree deps — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "cli-worktree-deps"` — Type: test
- [ ] Failed parallel worker worktree cleaned up — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-worktree-cleanup"` — Type: test

---

## Ticket 7: Wire CLI Entry Points for microverse-runner

**Priority**: P1 — CLI non-functional
**Files**: `bin/microverse-runner.js`, `tests/microverse-runner.test.js`

### Problem

CLI `main()` (lines 310-319) calls `runMicroverse({ sessionDir })` without providing `deps.state`, `deps.stateManager`, `deps.spawn`, etc. Runtime crash on first access.

### Fix

```javascript
if (process.argv[1] && path.basename(process.argv[1]) === 'microverse-runner.js') {
  const sessionDir = process.argv[2];
  if (!sessionDir) { console.error('Usage: microverse-runner.js <session-dir>'); process.exit(1); }

  const sm = new StateManager();
  const statePath = path.join(sessionDir, 'state.json');
  const mvPath = path.join(sessionDir, 'microverse.json');

  runMicroverse({
    sessionDir,
    statePath,
    mvPath,
    sm,
    spawn: child_process.spawn,
    exec: child_process.execSync,
    git: {
      getCurrentSha: () => gitUtils.getCurrentSha(workingDir),
      isDirty: () => gitUtils.isDirty(workingDir),
      autoCommit: (msg) => gitUtils.autoCommit(workingDir, msg),
      resetToSha: (sha) => gitUtils.resetToSha(workingDir, sha),
      stash: () => gitUtils.stash(workingDir),
    },
    writeHandoff: handoff.writeHandoff,
    parseAutoDump: tokenParser.parseAutoDump,
    measureMetric: (validation, timeout, cwd) => { /* shell exec wrapper */ },
  }).catch(err => { console.error(err); process.exit(1); });
}
```

### Acceptance Criteria

- [ ] CLI parses session-dir argument — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "cli-args"` — Type: test
- [ ] CLI wires all required deps (sm, spawn, git, handoff, tokenParser) — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "cli-deps-wired"` — Type: test
- [ ] CLI exits 1 with usage message if no session-dir — Verify: `node --test tests/microverse-runner.test.js --test-name-pattern "cli-usage"` — Type: test

---

## Ticket 8: Add Agent Tool Restriction Tests

**Priority**: P0 — PRD has 4 explicit ACs with zero test coverage
**Files**: `tests/persona.test.js`

### Problem

No test asserts agent tool lists. PRD ACs require:
- Tracer: NO write/patch
- Verifier: NO write/patch
- Surgeon: HAS write/patch
- Judge: NO write/patch/shell

Someone could add `write` to tracer and no test catches it.

Additionally, `persona.test.js` only covers 9 of 14 agents — missing prd-drafter, prd-synthesizer, analyst-codebase, analyst-requirements, analyst-risk-scope.

### Fix

Add tool restriction test block:

```javascript
describe('agent tool restrictions', () => {
  test('anatomy-tracer has NO write or patch', () => {
    const tools = parseTools('anatomy-tracer.md');
    assert.ok(!tools.includes('write'));
    assert.ok(!tools.includes('patch'));
  });
  test('anatomy-verifier has NO write or patch', () => {
    const tools = parseTools('anatomy-verifier.md');
    assert.ok(!tools.includes('write'));
    assert.ok(!tools.includes('patch'));
  });
  test('anatomy-surgeon HAS write and patch', () => {
    const tools = parseTools('anatomy-surgeon.md');
    assert.ok(tools.includes('write'));
    assert.ok(tools.includes('patch'));
  });
  test('microverse-judge has NO write, patch, or shell', () => {
    const tools = parseTools('microverse-judge.md');
    assert.ok(!tools.includes('write'));
    assert.ok(!tools.includes('patch'));
    assert.ok(!tools.includes('shell'));
  });
  test('microverse-worker HAS write and shell', () => {
    const tools = parseTools('microverse-worker.md');
    assert.ok(tools.includes('write'));
    assert.ok(tools.includes('shell'));
  });
});
```

Add missing agents to `AGENT_FILES` array for frontmatter validation.

### Acceptance Criteria

- [ ] Test: tracer has no write/patch tools — Verify: `node --test tests/persona.test.js --test-name-pattern "tracer.*write"` — Type: test
- [ ] Test: verifier has no write/patch tools — Verify: `node --test tests/persona.test.js --test-name-pattern "verifier.*write"` — Type: test
- [ ] Test: surgeon has write and patch — Verify: `node --test tests/persona.test.js --test-name-pattern "surgeon.*write"` — Type: test
- [ ] Test: judge has no write/patch/shell — Verify: `node --test tests/persona.test.js --test-name-pattern "judge.*write"` — Type: test
- [ ] Test: all 14 agents (minus spike fixtures) have valid frontmatter — Verify: `node --test tests/persona.test.js --test-name-pattern "frontmatter"` — Type: test

---

## Ticket 9: Harden tmux-runner Handoff Content + Rate Limit Defaults

**Priority**: P1 + P2 combined
**Files**: `bin/tmux-runner.js`, `tests/tmux-runner.test.js`

### Problem

1. (P1) Handoff missing fields: no `timeElapsed`, no `instructions` section, no metric context passed to microverse handoff builder.
2. (P2) `rateLimitBackoffMs` default 100ms — too low. Should default to 30000ms (30s) matching the CLI override.
3. (P2) `agentDir` can be undefined in some code paths, causing `path.join(undefined, ...)` to throw.

### Fix

**9a:** Pass all required fields to handoff builders:
```javascript
const handoffContent = handoff.buildHandoff({
  iteration, step: state.step, currentTicket: state.current_ticket,
  workingDir: state.working_dir, sessionRoot: state.session_dir,
  ticketsDone: completedTickets, ticketsPending: pendingTickets,
  startTime: state.start_time_epoch,
  instructions: getPhaseInstructions(state.step),
});
```

**9b:** Default `rateLimitBackoffMs: 30000`.

**9c:** Default `agentDir` to `.forge/agents` relative to working dir.

### Acceptance Criteria

- [ ] Handoff includes elapsed time (HH:MM:SS) — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "handoff-elapsed"` — Type: test
- [ ] Handoff includes phase-specific instructions — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "handoff-instructions"` — Type: test
- [ ] Rate limit backoff defaults to 30000ms — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "rate-limit-default"` — Type: test
- [ ] agentDir defaults to .forge/agents — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "agent-dir-default"` — Type: test

---

## Ticket 10: Integration Validation — Real `forge` Binary Smoke Tests

**Priority**: P1 — all existing smoke tests skip if forge unavailable
**Files**: `tests/smoke/*.sh`, `tests/smoke.test.js`

### Problem

`smoke.test.js` only checks file existence. All smoke scripts gate on `command -v forge` and skip silently. A broken smoke script passes CI.

### Fix

**10a:** Add a `tests/smoke/validate-scripts.sh` that sources each smoke script with `--dry-run` flag (or `SMOKE_DRY_RUN=1` env) to syntax-check without execution.

**10b:** Update `smoke.test.js` to actually validate script syntax:
```javascript
test('smoke scripts are valid bash', () => {
  for (const script of smokeScripts) {
    const result = execSync(`bash -n ${script}`, { encoding: 'utf-8' });
    // bash -n = syntax check only, no execution
  }
});
```

**10c:** Add a `tests/smoke/forge-spawn-contract.sh` that validates the exact `forge -p --agent` invocation contract works:
```bash
#!/bin/bash
# Verify forge -p --agent <id> spawns correctly
command -v forge || { echo "SKIP: forge not installed"; exit 0; }
OUTPUT=$(forge -C "$WORKING_DIR" -p "Say: CONTRACT_TEST" --agent microverse-worker 2>&1)
echo "$OUTPUT" | grep -q "CONTRACT_TEST" && echo "PASS" || { echo "FAIL: agent not invoked correctly"; exit 1; }
```

### Acceptance Criteria

- [ ] All smoke scripts pass `bash -n` syntax check — Verify: `node --test tests/smoke.test.js --test-name-pattern "syntax"` — Type: test
- [ ] forge-spawn-contract.sh validates `forge -p --agent` works — Verify: `bash tests/smoke/forge-spawn-contract.sh` (requires forge binary) — Type: smoke
- [ ] smoke.test.js tests script syntax, not just existence — Verify: `node --test tests/smoke.test.js` — Type: test

---

## Verification Strategy

**Gate command:**
```bash
node --test tests/state-manager.test.js && \
node --test tests/circuit-breaker.test.js && \
node --test tests/token-parser.test.js && \
node --test tests/git-utils.test.js && \
node --test tests/handoff.test.js && \
node --test tests/persona.test.js && \
node --test tests/setup.test.js && \
node --test tests/tmux-runner.test.js && \
node --test tests/microverse-runner.test.js && \
node --test tests/anatomy-park.test.js && \
node --test tests/prd-pipeline.test.js && \
node --test tests/refinement-team.test.js && \
node --test tests/init-microverse.test.js && \
node --test tests/smoke.test.js && \
echo "FINAL HARDENING: PASS"
```

**Post-gate (requires forge binary):**
```bash
bash tests/smoke/forge-spawn-contract.sh && \
bash tests/smoke/forge-p-context-clear.sh && \
bash tests/smoke/forge-p-token-roundtrip.sh && \
echo "SMOKE TESTS: PASS"
```

## Implementation Order

1. **Ticket 1** (forge spawn args) — unblocks everything
2. **Ticket 2** (setup.js state values) — unblocks correct runner startup
3. **Ticket 8** (tool restriction tests) — quick, high-value
4. **Ticket 3** (microverse git safety + state persistence) — most complex
5. **Ticket 4** (hang guards) — isolated, adds to both runners
6. **Ticket 7** (microverse CLI wiring) — depends on Ticket 3
7. **Ticket 5** (refinement CLI + arg size) — isolated
8. **Ticket 6** (parallel worker fixes) — depends on Ticket 1
9. **Ticket 9** (handoff + defaults) — polish
10. **Ticket 10** (smoke test validation) — final validation layer
