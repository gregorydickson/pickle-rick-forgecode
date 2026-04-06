# PRD: Phase 1 Gap Fix — ForgeCode Pickle Rick Port

## Overview

Phase 1 implementation produced a solid foundation (249/249 tests passing) but review identified 6 P0 issues, 16 P1 issues, and test coverage gaps. This PRD addresses all P0s and critical P1s to bring Phase 1 to gate-passing quality.

## Scope

Fix P0 and high-priority P1 issues from the Phase 1 review. Do NOT add new features — this is a hardening pass on existing code.

**Working directory**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-forgecode`
**Test runner**: `node --test tests/*.test.js`
**Module format**: ESM

---

## Ticket 1: Fix `state-manager.js` Transaction Path Ordering

**Priority**: P0
**Files**: `lib/state-manager.js`, `tests/state-manager.test.js`

### Problem
`transaction()` sorts paths for deadlock prevention but passes states to the mutator in sorted order, not caller-specified order. A caller doing `transaction(['/z', '/a'], ([zState, aState]) => {...})` gets `[aState, zState]` — silent data corruption.

### Fix
Maintain a mapping from sorted index back to original index. Pass states to mutator in original order. Keep sorted lock acquisition for deadlock prevention.

### Acceptance Criteria
- [ ] `transaction(['/z', '/a'], ([z, a]) => ...)` receives states matching caller path order — Verify: `node --test tests/state-manager.test.js --test-name-pattern "transaction-ordering"` — Type: test
- [ ] Lock acquisition still happens in sorted order (deadlock prevention preserved) — Verify: `node --test tests/state-manager.test.js --test-name-pattern "transaction-lock-order"` — Type: test

---

## Ticket 2: Fix `git-utils.js` Command Injection and Missing Returns

**Priority**: P0
**Files**: `lib/git-utils.js`, `tests/git-utils.test.js`

### Problem
1. `resetToSha`, `cherryPick`, `createWorktree`, `removeWorktree` interpolate unsanitized input into shell commands — command injection vulnerability
2. `resetToSha` and `stash()` don't return stash ref — PRD requires "record stash_ref in state"
3. `autoCommit` throws if tree is clean
4. Paths with spaces break commands (no quoting)

### Fix
1. Validate SHA is hex-only (`/^[0-9a-f]{4,40}$/i`). Quote all path arguments with shell escaping.
2. `stash()` returns stash ref string (parse `git stash` output). `resetToSha()` calls `stash()` first and returns `{ stashRef }`.
3. `autoCommit()` checks `isDirty()` first, returns early if clean (no error).
4. All `execSync` commands use array args or proper shell quoting for paths.

### Acceptance Criteria
- [ ] SHA validation rejects non-hex input — Verify: `node --test tests/git-utils.test.js --test-name-pattern "sha-validation"` — Type: test
- [ ] Path arguments with spaces don't break commands — Verify: `node --test tests/git-utils.test.js --test-name-pattern "path-quoting"` — Type: test
- [ ] `stash()` returns stash ref string — Verify: `node --test tests/git-utils.test.js --test-name-pattern "stash-returns-ref"` — Type: test
- [ ] `resetToSha()` returns `{ stashRef }` — Verify: `node --test tests/git-utils.test.js --test-name-pattern "reset-returns-stash"` — Type: test
- [ ] `autoCommit()` on clean tree returns without error — Verify: `node --test tests/git-utils.test.js --test-name-pattern "autocommit-clean-tree"` — Type: test
- [ ] `cherryPick` distinguishes conflict from other errors — Verify: `node --test tests/git-utils.test.js --test-name-pattern "cherrypick-conflict"` — Type: test

---

## Ticket 3: Rewrite `handoff.js` to Match PRD Spec

**Priority**: P0
**Files**: `lib/handoff.js`, `tests/handoff.test.js`

### Problem
Current implementation produces a 6-line skeleton (ticket/sha/status). PRD specifies a rich handoff format with iteration context, progress tracking, metric context (microverse), subsystem context (anatomy park), and phase-specific instructions.

### Fix
Rewrite `buildHandoff()` to accept a full context object and produce the PRD-specified markdown format. Add `buildMicroverseHandoff()` and `buildAnatomyParkHandoff()` variants that include mode-specific sections.

### Interface Contract

```javascript
// Base handoff (tmux-runner)
buildHandoff({
  iteration, step, currentTicket, workingDir, sessionRoot,
  ticketsDone, ticketsPending, startTime, instructions
}) → string

// Microverse extension
buildMicroverseHandoff({
  ...base,
  metric: { description, validation, direction, baseline, current, target },
  stallCounter, stallLimit,
  recentHistory,   // last 5 entries
  failedApproaches // string[]
}) → string

// Anatomy Park extension
buildAnatomyParkHandoff({
  ...base,
  subsystem, subsystemIndex, subsystemTotal,
  passCount, consecutiveClean, previousFindings
}) → string
```

### Acceptance Criteria
- [ ] `buildHandoff()` output contains iteration number, phase, ticket, working dir, session root — Verify: `node --test tests/handoff.test.js --test-name-pattern "base-handoff-content"` — Type: test
- [ ] `buildHandoff()` output contains tickets done/pending lists — Verify: `node --test tests/handoff.test.js --test-name-pattern "ticket-lists"` — Type: test
- [ ] `buildHandoff()` output contains elapsed time — Verify: `node --test tests/handoff.test.js --test-name-pattern "elapsed-time"` — Type: test
- [ ] `buildMicroverseHandoff()` includes metric context (description, validation, direction, scores, stall) — Verify: `node --test tests/handoff.test.js --test-name-pattern "microverse-context"` — Type: test
- [ ] `buildMicroverseHandoff()` includes recent history (last 5) — Verify: `node --test tests/handoff.test.js --test-name-pattern "microverse-history"` — Type: test
- [ ] `buildMicroverseHandoff()` includes failed approaches list — Verify: `node --test tests/handoff.test.js --test-name-pattern "failed-approaches"` — Type: test
- [ ] `buildAnatomyParkHandoff()` includes subsystem context — Verify: `node --test tests/handoff.test.js --test-name-pattern "anatomy-context"` — Type: test
- [ ] `writeHandoff()` writes to handoff.txt in session dir — Verify: `node --test tests/handoff.test.js --test-name-pattern "write-handoff"` — Type: test

---

## Ticket 4: Harden `tmux-runner.js`

**Priority**: P0 + P1 combined
**Files**: `bin/tmux-runner.js`, `tests/tmux-runner.test.js`

### Problem
1. (P0) Missing `EXISTENCE_IS_PAIN` completion token — review-clean exit never triggers
2. (P1) Phase map incomplete — `prd`, `breakdown`, `review` phases not routed, fall through to morty-worker instead of pickle-manager
3. (P1) Signal handler doesn't set `active=false` in state.json or kill child process
4. (P1) Handoff content is sparse — only passes ticket/sha, not full context
5. (P1) No parallel morty workers in git worktrees

### Fix

**4a: Add `EXISTENCE_IS_PAIN` and `ANALYSIS_DONE` to completion tokens.**

**4b: Complete the PHASE_AGENTS map:**
```javascript
const PHASE_AGENTS = {
  prd: 'pickle-manager',
  breakdown: 'pickle-manager',
  research: 'pickle-manager',
  plan: 'pickle-manager',
  implement: 'morty-worker',
  refactor: 'pickle-manager',
  review: 'pickle-manager',
};
// Default for unrecognized: pickle-manager + log warning
```

**4c: Signal handler cleanup:**
```javascript
async shutdown() {
  this._shuttingDown = true;
  // Kill child process if running
  if (this._child) {
    this._child.kill('SIGTERM');
    setTimeout(() => this._child?.kill('SIGKILL'), 2000);
  }
  // Set active=false in state.json
  try {
    this._sm.update(this._statePath, s => { s.active = false; });
  } catch {
    this._sm.forceWrite(this._statePath, { active: false });
  }
}
```

**4d: Use full handoff builders from rewritten `lib/handoff.js`.**

**4e: Parallel workers (implement phase):**
- When phase is `implement` and multiple tickets are pending, spawn N workers in parallel
- Each worker gets a git worktree (`git worktree add`)
- After all workers complete, cherry-pick commits to main branch
- If any worker fails, its worktree is cleaned up (no commits cherry-picked)
- Sequential fallback if git worktree fails

### Acceptance Criteria
- [ ] `EXISTENCE_IS_PAIN` token triggers review-clean exit — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "existence-is-pain"` — Type: test
- [ ] `ANALYSIS_DONE` token recognized — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "analysis-done"` — Type: test
- [ ] Phase `prd` routes to pickle-manager — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "phase-prd"` — Type: test
- [ ] Phase `breakdown` routes to pickle-manager — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "phase-breakdown"` — Type: test
- [ ] Phase `review` routes to pickle-manager — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "phase-review"` — Type: test
- [ ] Unrecognized phase defaults to pickle-manager with warning — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "unknown-phase"` — Type: test
- [ ] SIGTERM sets active=false in state.json — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "signal-deactivate"` — Type: test
- [ ] SIGTERM kills child process — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "signal-kill-child"` — Type: test
- [ ] Handoff includes phase, ticket list, progress — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "rich-handoff"` — Type: test
- [ ] Parallel workers spawn in git worktrees — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-worktrees"` — Type: test
- [ ] Failed parallel worker's worktree cleaned up — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-cleanup"` — Type: test
- [ ] Cherry-pick from worktrees to main after completion — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-cherrypick"` — Type: test

---

## Ticket 5: Fix `circuit-breaker.js` History and Progress Tracking

**Priority**: P1
**Files**: `lib/circuit-breaker.js`, `tests/circuit-breaker.test.js`

### Problem
1. `last_progress_iteration` incremented as counter, not set to actual iteration number — field is meaningless
2. History entries record `consecutive_no_progress` as `iteration` — misleading

### Fix
`recordIteration()` accepts an `iteration` parameter (the orchestrator's actual iteration number). Store it in `last_progress_iteration` on progress and in history entries.

### Acceptance Criteria
- [ ] `recordIteration(result, iteration)` stores actual iteration number — Verify: `node --test tests/circuit-breaker.test.js --test-name-pattern "iteration-tracking"` — Type: test
- [ ] History entries have correct iteration numbers — Verify: `node --test tests/circuit-breaker.test.js --test-name-pattern "history-iteration"` — Type: test
- [ ] `last_progress_iteration` reflects last iteration with progress — Verify: `node --test tests/circuit-breaker.test.js --test-name-pattern "progress-iteration"` — Type: test

---

## Ticket 6: Fix `token-parser.js` Known Token Validation

**Priority**: P1
**Files**: `lib/token-parser.js`, `tests/token-parser.test.js`

### Problem
`extractTokensFromContent` returns any string inside `<promise>...</promise>` tags. No validation against `KNOWN_TOKENS`. Hallucinated tokens would be accepted.

### Fix
Add `validateTokens(tokens)` that filters to known tokens only. `parseAutoDump` returns only validated tokens. Export `KNOWN_TOKENS` for consumer reference.

### Acceptance Criteria
- [ ] Unknown tokens filtered out — Verify: `node --test tests/token-parser.test.js --test-name-pattern "unknown-token-rejected"` — Type: test
- [ ] Known tokens pass through — Verify: `node --test tests/token-parser.test.js --test-name-pattern "known-token-accepted"` — Type: test
- [ ] `parseAutoDump` returns only known tokens — Verify: `node --test tests/token-parser.test.js --test-name-pattern "autodump-validated"` — Type: test

---

## Ticket 7: Fix `microverse-judge.md` Persona Contradiction

**Priority**: P1
**Files**: `.forge/agents/microverse-judge.md`

### Problem
Judge agent has "Output text before every tool call" rule, contradicting PRD spec that judge should "output ONLY a single number on the LAST line."

### Fix
Remove "Output text before every tool call" from judge. Add "Do NOT output explanatory text. Your entire response should be a single number."

### Acceptance Criteria
- [ ] Judge agent has no "text before tool call" rule — Verify: `node --test tests/persona.test.js --test-name-pattern "judge-no-text-rule"` — Type: test
- [ ] Judge agent has "single number" instruction — Verify: `grep -q "single number" .forge/agents/microverse-judge.md` — Type: lint

---

## Ticket 8: Improve Test Coverage Gaps

**Priority**: P1
**Files**: `tests/tmux-runner.test.js`, `tests/smoke/tmux-layout.sh`

### Problem
1. `EXISTENCE_IS_PAIN` token not tested in tmux-runner
2. Unrecognized step default not tested
3. Smoke tmux-layout checks >= 1 pane, PRD says 4
4. No parallel worker tests

### Fix
Add missing test cases. Fix smoke test pane count assertion.

### Acceptance Criteria
- [ ] Test: EXISTENCE_IS_PAIN triggers review-clean classification — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "existence-is-pain"` — Type: test
- [ ] Test: unknown step defaults to pickle-manager — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "unknown-phase"` — Type: test
- [ ] Smoke: tmux layout checks for 4 panes — Verify: `bash tests/smoke/tmux-layout.sh runner && grep -q "panes -ge 4" tests/smoke/tmux-layout.sh` — Type: test
- [ ] Test: parallel workers spawn, complete, cherry-pick — Verify: `node --test tests/tmux-runner.test.js --test-name-pattern "parallel"` — Type: test

---

## Verification Strategy

**Test runner**: `node --test tests/*.test.js`
**Gate**: All existing 249 tests still pass + new tests pass + zero P0 issues remaining.

```bash
# Gap fix gate
node --test tests/state-manager.test.js && \
node --test tests/circuit-breaker.test.js && \
node --test tests/token-parser.test.js && \
node --test tests/tmux-runner.test.js && \
node --test tests/git-utils.test.js && \
node --test tests/handoff.test.js && \
node --test tests/persona.test.js && \
bash tests/smoke/tmux-layout.sh runner && \
echo "PHASE 1 GAP FIX: PASS"
```

## Implementation Order

1. Ticket 2 (git-utils security fix) — blocks everything that uses rollback
2. Ticket 1 (state-manager transaction ordering) — isolated fix
3. Ticket 5 (circuit-breaker iteration tracking) — isolated fix
4. Ticket 6 (token-parser validation) — isolated fix
5. Ticket 7 (judge persona fix) — trivial
6. Ticket 3 (handoff rewrite) — needed by Ticket 4
7. Ticket 4 (tmux-runner hardening) — depends on Tickets 2, 3, 6
8. Ticket 8 (test coverage) — after all fixes, validate everything
