# PRD: Pickle Rick Feature Port to ForgeCode (Refined)

## Overview

Port Pickle Rick's autonomous engineering capabilities to ForgeCode's native primitives: custom agents (`.forge/agents/`), skills (`.forge/skills/`), and `forge -p` headless execution. The goal is a native ForgeCode experience — not a wrapper around Claude Code.

*(refined: overview)* This port targets **5 features** (collapsed from original 7). Anatomy Park and Szechuan Sauce are microverse sub-modes, not standalone features — matching their existing architecture in pickle-rick-claude.

## Non-Goals *(refined: risk-scope)*

| Pickle Rick Subsystem | Decision | Rationale |
|---|---|---|
| Hook system (dispatch.js, stop-hook.js) | OUT | ForgeCode has no user hooks; orchestrator handles lifecycle |
| Metrics reporter (metrics.js, metrics-utils.js) | DEFER Phase 2+ | No data source until activity logging exists |
| Activity logging (activity-logger.ts) | DEFER Phase 2+ | Required for /pickle-metrics and /pickle-standup — but not blocking for core convergence loops |
| Jar runner (batch queue) | DEFER | Prove single-session first |
| TUI panes (monitor.js, log-watcher.js, morty-watcher.js, raw-morty.js) | REPLACE | Simple tmux tail + jq watch per PRD. Deliberate simplification — existing 4-pane TUI is over-engineered for the ForgeCode port |
| Meeseeks review loop | SUPERSEDED | By Szechuan Sauce (Feature 1c) |
| Session conflict detection (SessionMapEntry) | DEFER | Single-session MVP first |
| detectMultiRepo() safety check | DEFER | Single-repo MVP first |

## Risks *(refined: risk-scope)*

| # | Risk | Likelihood | Impact | Mitigation | Blocks |
|---|---|---|---|---|---|
| R1 | `forge -p` stdout not reliably parseable for tokens | ~~Medium~~ **Mitigated** | ~~Critical~~ Low | *(confirmed: source-dive)* `auto_dump` JSON has full role filtering. Stdout is secondary signal only | ~~F1,F2,F3~~ None |
| R2 | `followup` tool broken in `forge -p` headless mode | ~~Medium~~ **Mitigated** | ~~High~~ Low | *(confirmed: source-dive)* `followup` returns `None` in headless mode (no block). Design uses `--cid` chaining instead. Spike S10 confirms `--cid` works | ~~F4~~ F4 (S10 only) |
| R3 | Doom loop detector kills intentional iteration | Medium | High | Phase 0 spike S5; test 20-iteration threshold | F1 |
| R4 | Concurrent `forge -p` conflicts on state/API | Medium | High | Phase 0 spike S6; serialize if needed | F2,F3 |
| R5 | `git reset --hard` + `git clean -fd` destroys concurrent commits | High | Critical | Git worktrees for parallel workers; stash-before-reset | F1,F2 |
| R6 | No assistant-content filtering in `forge -p` output | ~~High~~ **Mitigated** | ~~Critical~~ None | *(confirmed: source-dive)* `auto_dump` JSON distinguishes `text.role: "Assistant"` from `tool` results via different JSON keys. Zero false-positive risk | None |
| R7 | Agent tool restrictions are advisory, not enforced | ~~Medium~~ **Mitigated** | ~~High~~ None | *(confirmed: source-dive)* HARD enforced: `validate_tool_call()` blocks at execution time + LLM never receives disallowed tool defs. Identical in `-p` mode | None |
| R8 | No wall-clock timeout for `forge -p` processes | High | Medium | Add SIGTERM/SIGKILL escalation to all orchestrators | All |
| R9 | Multi-provider cost exceeds budget (no caps) | Medium | Medium | Default all agents to Sonnet; model field optional override | All |

---

## Architecture Mapping

### Primitive Translation Table

| Pickle Rick Primitive | ForgeCode Equivalent | Gap / Workaround |
|---|---|---|
| `claude -p "<prompt>"` | `forge -p "<prompt>"` | Equivalent. `--agent <id>` adds per-invocation agent selection |
| `--no-session-persistence` | Default for `forge -p` (exits after one turn) | Equivalent — each `forge -p` is a fresh context |
| `--output-format stream-json` | `auto_dump = "json"` in forge.toml | *(confirmed: source-dive)* `auto_dump` JSON has full role discrimination (`text.role: Assistant|User|System` + separate `tool` variant). Functionally equivalent to stream-json for token detection |
| `.claude/commands/*.md` | `.forge/skills/*/SKILL.md` + `.forge/commands/*.md` | Skills are richer (resource dirs, progressive disclosure) |
| Claude Code hooks (stop-hook, post-tool-use) | No user-configurable hooks | External orchestration handles lifecycle. Out of scope for port |
| `StateManager` (file locks, transactions) | None built-in | Port as `lib/state-manager.js` — orchestrator-side only |
| Promise tokens (`<promise>X</promise>`) | `auto_dump` JSON + role filtering | *(confirmed: source-dive)* Parse auto_dump JSON, filter to `text.role === "Assistant"`, match tokens. Zero false-positive risk — tool results use separate `"tool"` JSON key |
| `--dangerously-skip-permissions` | Agent-level tool restrictions in YAML | *(confirmed: source-dive)* HARD enforced — two layers: LLM never sees disallowed tool defs + execution-time `validate_tool_call()` blocks fabricated calls. Identical in `-p` and interactive mode |
| `--add-dir` (context directories) | No equivalent flag | *(refined: codebase)* ForgeCode agents can read any file via `read` tool regardless of cwd. Verify in Phase 0 spike S8 that `read` tool works on paths outside working directory |
| `--max-turns` | `max_requests_per_turn` per agent | Equivalent — configured in agent YAML |
| tmux session management | External (same as Pickle Rick) | tmux orchestration lives outside both tools |

### Key Architectural Decisions

1. **Orchestration stays external.** ForgeCode has no workflow engine. The tmux-runner, microverse-runner, and refinement coordinator remain Node.js scripts that shell out to `forge -p`.

2. **Agent definitions replace prompt engineering.** Instead of injecting role instructions into a single `claude -p` prompt, define `.forge/agents/` with explicit tool restrictions, models, and system prompts.

3. **Skills replace command templates.** `.forge/skills/*/` directories bundle instructions + scripts + references. Progressive disclosure (metadata always loaded, body on-demand) saves tokens.

4. **State management stays in the orchestrator.** Agents don't need to query state mid-turn — the orchestrator writes everything they need into handoff.txt before spawning them.

5. **Multi-provider is the killer feature.** Per-agent model selection means gap analysis runs on cheap models, implementation on expensive ones, and LLM judges on fast ones.

6. *(refined: risk-scope, codebase)* **Anatomy Park and Szechuan Sauce are microverse sub-modes.** Both use microverse-runner with `convergence_mode: 'worker'` in the existing source. They are Feature 1 sub-modes (1b and 1c), not standalone features.

7. *(refined: codebase)* **Handoff format is a deliberate redesign.** The existing codebase has two handoff formats (flat key-value in `buildHandoffSummary()` and markdown in `buildMicroverseHandoff()`). This port uses a unified markdown format. This is intentional — ForgeCode agents parse markdown natively.

---

## Phase 0: Platform Verification (Blocking Prerequisites) *(refined: requirements, codebase, risk-scope)*

No feature implementation begins until all spikes complete. Each spike has a 2-hour timebox, binary PASS/FAIL result, and documented fallback if FAIL.

### Pre-Resolved (Source Code Verified) *(refined: source-dive 2026-04-05)*

| # | Question | Result | Evidence | Impact |
|---|---|---|---|---|
| S2 | `followup` in headless mode | **PASS (with workaround)** | `forge_select/src/input.rs:60-64`: `is_terminal()` check returns `None` immediately in headless mode. Tool returns `"<interrupted>No feedback provided</interrupted>"`, process exits. Does NOT block. | Feature 4a: remove `followup` tool from prd-drafter. Use `--cid` multi-turn chaining instead. |
| S7 | `auto_dump` conversation JSON | **PASS** | `forge_domain/src/context.rs:41-45`: `ContextMessage` enum has `Text(TextMessage)` with `role: Role` field (`System|User|Assistant`) and `Tool(ToolResult)` as separate variant. Full JSON dump via `serde_json::to_string_pretty`. | Token detection via auto_dump role filtering confirmed viable. |
| S11 | `auto_dump` role filtering | **PASS** | Same evidence as S7. Assistant messages: `{"text": {"role": "Assistant", ...}}`. Tool results: `{"tool": {"name": "...", ...}}`. Different JSON keys — zero ambiguity. | Option A (auto_dump role filtering) is the confirmed token detection strategy. |
| S12 | Agent tool restriction enforcement | **PASS** | `forge_app/src/tool_registry.rs:306-321`: `validate_tool_call()` hard-gates before any execution. Two layers: (1) LLM never receives disallowed tool definitions, (2) fabricated calls blocked with error at execution time. Identical in `-p` and interactive mode. | Anatomy Park read-only agents are genuinely enforced. Security model holds. |

### Runtime Verified (2026-04-05, forge 2.6.0) *(refined: runtime spikes)*

| # | Question | Result | Finding | Impact |
|---|---|---|---|---|
| S1 | stdout token parsing | **PARTIAL PASS** | `forge -p` writes all output to stderr. Stdout empty when redirected. Combined `2>&1` has tokens but mixed with progress/errors. | Stdout is NOT usable for clean token extraction. auto_dump is primary (confirmed S7/S11). Stdout is human-readable only. |
| S3 | Exit code semantics | **PASS (always 0)** | Success: exit 0. Tool failure: exit 0. Rate limit retry: exit 0. ForgeCode always exits 0. | Orchestrator CANNOT use exit codes for error detection. Must use auto_dump JSON (`is_error` fields in tool results) or stderr pattern matching. |
| S4 | Rate limit signals | **PASS** | Rate limits appear as `ERROR` lines in stderr: `429 Too Many Requests` with JSON metadata. ForgeCode retries internally with backoff. | Orchestrator detects via stderr scan for `429`. ForgeCode handles retry — orchestrator just needs wall-clock timeout. |
| S6 | Concurrent `forge -p` | **PASS** | 3 parallel processes, all exit 0, all files created correctly, no corruption. | Parallel morty workers confirmed safe for independent tasks. |
| S8 | File access outside cwd | **PASS** | Agent in project dir read `/etc/hosts` and `~/.zshrc` successfully. | `read` tool works on arbitrary absolute paths. No `--add-dir` needed. |
| S10 | `--cid` conversation resume | **PASS** | Second `forge -p --cid <id>` recalled `PLATYPUS42` from first invocation. Output shows `Continue <id>` instead of `Initialize`. | Feature 4a PRD interview via `--cid` chaining confirmed viable. |

### Deferred (Need Paid Model / Longer Sessions)

| # | Question | Status | Mitigation |
|---|---|---|---|
| S5 | Doom loop threshold | Deferred — free model rate-limited | Low risk: vary handoff phrasing per iteration. Doom detector checks identical tool calls, not identical prompts. |
| S9 | Agent YAML compact config | Deferred — needs sustained conversation | Low risk: complementary to `max_requests_per_turn`. Test during Phase 1 implementation. |

**Go/No-Go Decision: GO.** 10 of 12 spikes passed. 2 deferred are low risk. No blocking incompatibilities. See `phase0/spike-results.md` for full details.

---

## Feature 1: Microverse Convergence Loop

**Priority: P0**

### What It Does

Metric-driven optimization loop with three sub-modes:
- **1a: Metric-Driven** (default) — measure baseline, improve, verify, compare, rollback regressions, repeat
- **1b: Anatomy Park** — three-phase subsystem review (trace → fix → verify) with rotation *(refined: risk-scope)*
- **1c: Szechuan Sauce** — principle-driven quality convergence *(refined: risk-scope)*

All three use the same microverse-runner orchestrator with different agent configurations and convergence modes.

### ForgeCode Architecture

```
pickle-rick-forgecode/
  bin/
    microverse-runner.js          # External Node.js orchestrator
    init-microverse.js            # Session setup CLI
    tmux-runner.js                # Context-clearing iteration loop
    spawn-refinement-team.js      # Parallel analyst spawner
    setup.js                      # Session initialization
  lib/
    state-manager.js              # File-locked atomic state management
    circuit-breaker.js            # 3-state FSM progress tracking
    token-parser.js               # Promise token detection with false-positive filtering
    git-utils.js                  # SHA tracking, rollback, worktree management
    handoff.js                    # Handoff file generation
  .forge/
    AGENTS.md                     # Persona + routing (injected into all agents)
    agents/
      microverse-worker.md        # Implementation agent (write/shell/patch)
      microverse-judge.md         # Scoring agent (read-only, different model)
      microverse-analyst.md       # Gap analysis agent (read + search)
      anatomy-tracer.md           # Phase 1: read-only data flow tracer
      anatomy-surgeon.md          # Phase 2: single-fix applicator
      anatomy-verifier.md         # Phase 3: read-only regression verifier
      szechuan-reviewer.md        # Quality principle enforcer
      pickle-manager.md           # Session manager
      morty-worker.md             # Ticket implementation worker
      analyst-requirements.md     # PRD requirements analyst
      analyst-codebase.md         # PRD codebase analyst
      analyst-risk.md             # PRD risk/scope analyst
      prd-drafter.md              # Interactive PRD interview
      prd-synthesizer.md          # Refinement synthesis + decomposition
    skills/
      microverse/
        SKILL.md
        scripts/
          measure-metric.sh
        references/
          handoff-format.md
      prd-draft/
        SKILL.md
        references/
          prd-template.md
          verification-types.md
      pickle/
        SKILL.md
        references/
          persona-voice.md
          routing-rules.md
  tests/
    state-manager.test.js
    circuit-breaker.test.js
    token-parser.test.js
    microverse-runner.test.js
    tmux-runner.test.js
    refinement-team.test.js
    anatomy-park.test.js
    prd-pipeline.test.js
    persona.test.js
    smoke/
      platform-verification.sh    # Phase 0 spike runner
      forge-p-context-clear.sh
      forge-p-agent-select.sh
      tmux-layout.sh
```

### CUJ 1.1: Developer Runs Microverse Convergence *(refined: requirements)*

1. Developer runs: `node bin/init-microverse.js ./session ./src --convergence-target 95 --metric-json '{"description":"test coverage","validation":"npm test -- --coverage | tail -1","type":"command","direction":"higher","tolerance":0.5}'`
2. System creates `session/microverse.json` with status: `gap_analysis`, baseline_score: 0
3. Developer starts: `node bin/microverse-runner.js ./session`
4. **Gap analysis phase**: Runner spawns `forge -p --agent microverse-analyst` to analyze codebase
5. Runner measures baseline metric, records score in microverse.json, transitions to `iterating`
6. **Iteration loop**: Runner writes handoff.txt (metric, history, failed approaches), spawns `forge -p --agent microverse-worker`
7. Worker reads handoff.txt, makes ONE targeted change, commits
8. Runner measures metric: improved → accept; regressed → `git reset --hard` + `git clean -fd`; held → accept
9. Developer watches tmux pane: sees `Iteration 7: 82% → 85% (accept)` in log
10. After 3 consecutive stalls, runner exits with `converged` status and writes final report
11. Developer sees: `microverse-runner.log: Converged at iteration 12, score: 94.5%, exit_reason: converged`

### CUJ 1.2: Microverse Recovers From Crash *(refined: requirements)*

1. microverse-runner.js killed (OOM, SIGKILL)
2. Developer restarts: `node bin/microverse-runner.js ./session`
3. StateManager reads microverse.json, detects orphan `.tmp` file from crashed write
4. `.tmp` has higher iteration count → promoted to microverse.json
5. Runner resumes from last completed iteration, not last attempted
6. Working tree is checked: if dirty, auto-commit before continuing

### CUJ 1.3: Anatomy Park Deep Review *(refined: risk-scope)*

1. Developer runs: `node bin/init-microverse.js ./session ./src --convergence-mode worker --convergence-file anatomy-park.json`
2. Runner enters gap_analysis: spawns `forge -p --agent anatomy-tracer` for initial subsystem discovery
3. Worker auto-discovers subsystems (immediate subdirs with 3+ source files, excluding node_modules/dist)
4. Writes `anatomy-park.json` with subsystem list, pass_counts, stall_counts
5. **Per iteration**: Runner reads anatomy-park.json → selects next subsystem → writes handoff
6. **Phase 1**: `forge -p --agent anatomy-tracer` — read-only, traces data flows, outputs findings.md
7. If zero findings: record clean pass, rotate to next subsystem
8. **Phase 2**: `forge -p --agent anatomy-surgeon` — applies ONE fix, writes regression test, writes trap doors
9. **Phase 3**: `forge -p --agent anatomy-verifier` — read-only, verifies via git diff review + test run
10. If Phase 3 fails: `git reset --hard`, increment stall_count
11. When all subsystems have consecutive_clean >= 2: flush trap doors, exit converged

### CUJ 1.4: Szechuan Sauce Quality Pass *(refined: risk-scope, codebase)*

1. Developer runs: `node bin/init-microverse.js ./session ./src --convergence-mode worker --convergence-file convergence.json --metric-json '{"type":"llm","description":"count code quality violations","direction":"lower","validation":"count violations in changed files"}'`
2. Runner enters gap_analysis: spawns `forge -p --agent szechuan-reviewer` to assess baseline quality
3. LLM judge scores initial violation count
4. **Iteration loop**: Worker applies quality fixes, judge re-scores
5. When judge scores 0 violations: microverse-runner exits via convergence_target
6. Worker MUST NOT output promise tokens — convergence is metric-driven *(refined: codebase)*

### Agent Definitions

```yaml
# .forge/agents/microverse-worker.md
---
id: microverse-worker
title: "Microverse Implementation Worker"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, skill]
max_requests_per_turn: 80
compact:
  token_threshold: 80000
  retention_window: 10
---
You are a focused implementation agent optimizing a single metric.
Read handoff.txt in your working directory FIRST.
Make ONE targeted change per iteration. Small, verifiable, atomic.
Commit your work with a descriptive message.
Output text before every tool call.
```

```yaml
# .forge/agents/microverse-judge.md
---
id: microverse-judge
title: "Metric Scoring Judge"
model: anthropic/claude-haiku-4-5
tools: [read, fs_search, sem_search]
max_requests_per_turn: 20
---
You are a precise scoring judge. Your ONLY job is to evaluate code
and output a numeric score.
Do NOT adopt any persona. Do NOT explain reasoning.
Output ONLY a single number on the LAST line.
```

```yaml
# .forge/agents/anatomy-tracer.md — NO write/patch tools (enforced read-only)
---
id: anatomy-tracer
title: "Data Flow Tracer"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell]
max_requests_per_turn: 80
---
Phase 1: Read-only. Trace data flows, identify bugs, rate severity.
Do NOT modify any files. Output findings in structured format.
Output text before every tool call.

# .forge/agents/anatomy-surgeon.md — HAS write/patch tools
---
id: anatomy-surgeon
title: "Targeted Fix Surgeon"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search]
max_requests_per_turn: 60
---
Phase 2: Apply ONE fix (highest severity). Write regression test.
Write trap doors to AGENTS.md. Commit atomically.
Output text before every tool call.

# .forge/agents/anatomy-verifier.md — NO write/patch tools (enforced read-only)
---
id: anatomy-verifier
title: "Regression Verifier"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, shell]
max_requests_per_turn: 40
---
Phase 3: Read-only. Verify fix via git diff review.
Check all callers, importers, schema consumers. Run test suite.
Output PASS or FAIL on the last line.

# .forge/agents/szechuan-reviewer.md
---
id: szechuan-reviewer
title: "Szechuan Sauce Quality Reviewer"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
Principle-driven quality enforcer:
1. Zero dead code  2. Zero redundant comments  3. Merge duplicates
4. Consistent patterns  5. No slop
Fix what you find. Do NOT output promise tokens — convergence is metric-driven.
Output text before every tool call.
```

### Orchestrator Loop (microverse-runner.js)

```
┌──────────────────────────────────────────────────────────┐
│ microverse-runner.js (Node.js, runs in tmux)             │
│                                                          │
│  0. Read microverse.json — if status=gap_analysis:       │
│     a. Spawn: forge -p --agent microverse-analyst        │
│     b. Measure baseline metric                           │
│     c. Auto-commit if dirty tree (preflight)             │
│     d. Transition to status=iterating                    │
│                                                          │
│  LOOP (while status=iterating):                          │
│  1. Read microverse.json (state)                         │
│  2. Write handoff.txt (context for worker)               │
│  3. Record pre-iteration git SHA                         │
│  4. Spawn: forge -p --agent <worker>                     │
│     → Fresh context, wall-clock timeout, SIGTERM/SIGKILL │
│  5. Check git SHA delta (commits made?)                  │
│     → No commits + dirty tree: auto-commit               │
│     → No commits + clean tree: record stall              │
│  6. Measure metric:                                      │
│     a. Type 'command': run shell script                  │
│     b. Type 'llm': forge -p --agent microverse-judge     │
│     c. Type 'none': skip (worker-managed convergence)    │
│  7. Compare: improved / regressed / held                 │
│  8. If regressed: git stash, git reset --hard <pre-SHA>  │
│     Record failed approach in circular buffer             │
│  9. Update microverse.json (history, stalls)             │
│ 10. If converged: exit. Else: goto 1                     │
│                                                          │
│  CONVERGENCE: stall_counter >= stall_limit               │
│    OR convergence_target met                             │
│    OR worker-managed: convergence_file has converged=true │
└──────────────────────────────────────────────────────────┘
```

### Token Detection Strategy *(confirmed: source-dive 2026-04-05)*

**Strategy: `auto_dump` Role Filtering (Option A — CONFIRMED VIABLE)**

Source verification confirmed the `auto_dump` JSON format has full role discrimination:
- Assistant messages: `{"text": {"role": "Assistant", "content": "..."}}`
- Tool results: `{"tool": {"name": "...", "output": {...}}}` — entirely separate JSON key
- User/System messages: `{"text": {"role": "User|System", ...}}`

**Implementation:**
1. Set `auto_dump = "json"` in `forge.toml` (or per-session config)
2. After each `forge -p` exits, parse `{timestamp}-dump.json` from working directory
3. Filter `conversation.context.messages[]` to entries with `text.role === "Assistant"`
4. Match promise tokens (`<promise>TOKEN</promise>`) only in filtered assistant content
5. Tool results, code read by agents, and user messages are automatically excluded

**False-positive risk: ZERO.** Tool results use the `"tool"` key, never the `"text"` key. An agent reading a file containing `<promise>EPIC_COMPLETED</promise>` produces a `{"tool": {...}}` entry, not `{"text": {"role": "Assistant", ...}}`. The structural discrimination is absolute.

**Stdout remains a secondary signal** for human-readable progress monitoring in tmux panes, but is NOT used for programmatic token detection.

### Acceptance Criteria — Feature 1a (Metric-Driven Microverse)

| # | Requirement | Verify | Type | Failure Behavior *(refined: requirements)* |
|---|---|---|---|---|
| 1 | Agent definitions exist with correct tools/model | `node --test tests/microverse-runner.test.js --test-name-pattern "agent-definitions"` | test | N/A (static) |
| 2 | Gap analysis phase runs before first iteration | `node --test tests/microverse-runner.test.js --test-name-pattern "gap-analysis"` | test | If gap analysis agent fails: log error, measure baseline anyway, continue to iterating *(refined: codebase)* |
| 3 | Each iteration spawns new `forge -p` (fresh context) | `node --test tests/microverse-runner.test.js --test-name-pattern "context-clearing"` | test | If spawn fails: log stderr, retry once after 5s, then mark as errored iteration |
| 4 | Judge agent has read-only tools (no write/patch) | Parse YAML frontmatter: `tools` array has no write/patch | lint | N/A (static) |
| 5 | Orchestrator loop: measure → improve → compare → rollback/keep | `node --test tests/microverse-runner.test.js --test-name-pattern "orchestrator-loop"` | test | N/A (core logic) |
| 6 | Git rollback on regression: `git stash` then `git reset --hard` to pre-SHA | `node --test tests/microverse-runner.test.js --test-name-pattern "rollback"` | test | If stash fails: log warning, proceed with reset (accept potential data loss) |
| 7 | Stall detection increments counter, converges at stall_limit | `node --test tests/microverse-runner.test.js --test-name-pattern "stall-detection"` | test | If metric command fails (non-zero exit/timeout/non-numeric): treat as "held", increment stall, log stderr *(refined: requirements)* |
| 8 | Convergence target triggers early exit | `node --test tests/microverse-runner.test.js --test-name-pattern "convergence-target"` | test | N/A (exit condition) |
| 9 | Failed approaches tracked in circular buffer (max 100) | `node --test tests/microverse-runner.test.js --test-name-pattern "failed-approaches"` | test | N/A (data structure) |
| 10 | Handoff.txt written with iteration, metric, history, failed approaches | `node --test tests/microverse-runner.test.js --test-name-pattern "handoff-content"` | test | If handoff write fails: abort iteration, log error |
| 11 | Signal handler (SIGTERM) persists state and exits cleanly | `node --test tests/microverse-runner.test.js --test-name-pattern "signal-handling"` | test | Uses `forceWrite()` (no lock, never throws) |
| 12 | Worker-managed convergence polls convergence_file | `node --test tests/microverse-runner.test.js --test-name-pattern "worker-managed"` | test | If file missing/unparseable: log, continue loop |
| 13 | LLM judge returns numeric score via forge -p --agent | `bash tests/smoke/forge-p-judge-score.sh` | smoke | If non-numeric: retry once with reinforced prompt. If still non-numeric: treat as measurement failure, skip, log raw output *(refined: requirements)* |
| 14 | Wall-clock timeout: SIGTERM at worker_timeout_seconds, SIGKILL +2s | `node --test tests/microverse-runner.test.js --test-name-pattern "timeout"` | test | Hang guard at MAX_ITERATION_SECONDS (4h) force-resolves *(refined: codebase)* |
| 15 | Dirty-tree preflight: auto-commit before recording pre-SHA | `node --test tests/microverse-runner.test.js --test-name-pattern "preflight"` | test | If auto-commit fails: git reset, abort iteration *(refined: codebase)* |
| 16 | tmux layout creates 3 panes (orchestrator, log, metric watch) | `bash tests/smoke/tmux-layout.sh microverse` | smoke | N/A (layout) |

### Acceptance Criteria — Feature 1b (Anatomy Park Sub-Mode)

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | Three phases execute sequentially: tracer → surgeon → verifier | `node --test tests/anatomy-park.test.js --test-name-pattern "three-phase"` | test | If any phase spawn fails: skip to next subsystem, increment stall |
| 2 | Tracer/verifier have NO write/patch tools (enforced read-only) | Parse YAML frontmatter: `tools` arrays checked | lint | N/A (static). *(refined: risk-scope)* Verify enforcement in Phase 0 spike S12 |
| 3 | Surgeon has write + patch tools | Parse YAML frontmatter | lint | N/A (static) |
| 4 | Subsystem auto-discovery: immediate subdirs with 3+ source files | `node --test tests/anatomy-park.test.js --test-name-pattern "discovery"` | test | If discovery finds 0 subsystems: exit with error *(refined: codebase)* |
| 5 | Rotation skips converged subsystems (consecutive_clean >= 2) | `node --test tests/anatomy-park.test.js --test-name-pattern "rotation-skip"` | test | N/A (skip logic) |
| 6 | Rotation skips stalled subsystems (stall_count >= limit) | `node --test tests/anatomy-park.test.js --test-name-pattern "stall-skip"` | test | N/A (skip logic) |
| 7 | Trap doors flushed on convergence | `node --test tests/anatomy-park.test.js --test-name-pattern "trap-door-flush"` | test | If flush fails: log error, still exit converged |
| 8 | Phase 3 failure triggers git reset to pre-iteration SHA | `node --test tests/anatomy-park.test.js --test-name-pattern "phase3-rollback"` | test | Stash before reset; if stash fails, log warning |
| 9 | anatomy-park.json persisted with pass_counts, stall_counts | `node --test tests/anatomy-park.test.js --test-name-pattern "state-persistence"` | test | Atomic write via StateManager |
| 10 | All subsystems converged → exit with trap door commit | `node --test tests/anatomy-park.test.js --test-name-pattern "full-convergence"` | test | N/A (exit condition) |

### Acceptance Criteria — Feature 1c (Szechuan Sauce Sub-Mode)

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | Uses microverse-runner with convergence_mode: worker or metric (LLM judge) | `node --test tests/microverse-runner.test.js --test-name-pattern "szechuan-mode"` | test | N/A (configuration) |
| 2 | Worker does NOT output promise tokens — convergence is metric/file driven | Agent definition has no promise token instructions | lint | *(refined: codebase)* If token accidentally detected, it's filtered by role-based parsing |
| 3 | Scope limited to `git diff` files against session start SHA | `node --test tests/microverse-runner.test.js --test-name-pattern "diff-scope"` | test | If start SHA missing in state: fall back to HEAD~1, log warning *(refined: risk-scope)* |
| 4 | Max passes gate: loop exits after max_iterations even if not clean | `node --test tests/microverse-runner.test.js --test-name-pattern "max-iterations"` | test | N/A (gate) |
| 5 | Regression detection: tests fail after changes → git reset, increment stall | `node --test tests/microverse-runner.test.js --test-name-pattern "szechuan-regression"` | test | If test command fails (not test failure, but command error): treat as inconclusive, log, continue |

### Test Expectations — Feature 1

| AC | Test File | Description | Assertion |
|---|---|---|---|
| 1a.1 | `tests/microverse-runner.test.js` | Agent files exist, YAML parses, required fields present | `id`, `model`, `tools` present in all agent .md files |
| 1a.2 | `tests/microverse-runner.test.js` | Status=gap_analysis triggers analyst spawn before iteration | First spawn uses `--agent microverse-analyst` |
| 1a.3 | `tests/microverse-runner.test.js` | Mock forge binary; verify spawn called N times for N iterations | Each spawn has `-p` and `--agent`, no `--cid` |
| 1a.5 | `tests/microverse-runner.test.js` | Mock forge writes known score; orchestrator classifies | `compareMetric()` returns correct for known inputs |
| 1a.6 | `tests/microverse-runner.test.js` | After regression, HEAD matches pre-iteration SHA | SHA comparison post-resetToSha() |
| 1a.7 | `tests/microverse-runner.test.js` | Stall counter increments correctly, convergence check | `isConverged()` true at limit |
| 1a.14 | `tests/microverse-runner.test.js` | Send SIGTERM after timeout, verify kill escalation | SIGKILL sent 2s after SIGTERM |
| 1b.1 | `tests/anatomy-park.test.js` | Three sequential spawns with correct agent IDs | Spawn order: tracer → surgeon → verifier |
| 1b.4 | `tests/anatomy-park.test.js` | Create test dirs with 3+ files, verify discovery | Auto-discovered subsystem count matches |
| 1c.3 | `tests/microverse-runner.test.js` | Handoff includes only git diff file list | Handoff content matches diff output |

---

## Feature 2: tmux Runner (Context-Clearing Iteration Loop)

**Priority: P0 (foundation for all other features)**

### What It Does

Outer orchestration loop that spawns fresh `forge -p` invocations per iteration, manages state transitions, detects completion via output tokens, handles rate limits, and coordinates the full PRD-to-review lifecycle.

### CUJ 2.1: Developer Runs Full Lifecycle *(refined: requirements)*

1. Developer runs: `node bin/setup.js --tmux --task "Add OAuth support" --max-iterations 50 --max-time 120`
2. System creates session dir with state.json (step: prd, active: false)
3. Developer starts: `node bin/tmux-runner.js ./session`
4. Runner takes ownership (active: false → true)
5. Runner selects pickle-manager agent (phase: prd), writes handoff.txt, spawns `forge -p`
6. Agent advances through phases: prd → breakdown → research → plan → implement → refactor → review
7. During implement: runner spawns morty-worker per ticket (parallel if independent, in git worktrees)
8. Ticket completion requires BOTH promise token AND non-empty git diff *(refined: codebase)*
9. After all tickets: review phase, agent outputs `<promise>EXISTENCE_IS_PAIN</promise>`
10. Runner checks min_iterations gate → if met, exits with success
11. Developer sees final notification: "EPIC_COMPLETED, 15 iterations, 52 minutes"

### CUJ 2.2: Developer Resumes After Crash *(refined: requirements)*

1. tmux-runner.js killed unexpectedly
2. Developer restarts: `node bin/tmux-runner.js ./session`
3. StateManager detects active=true with stale PID → clears active flag
4. Promotes any orphan .tmp files with higher iteration counts
5. Resumes from last completed iteration

### Agent Definitions

```yaml
# .forge/agents/pickle-manager.md
---
id: pickle-manager
title: "Pickle Rick Session Manager"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
You are the Pickle Rick session manager. Read handoff.txt FIRST.
Phases: prd → breakdown → research → plan → implement → refactor → review.
When ALL tickets complete, output: <promise>EPIC_COMPLETED</promise>
When review passes clean, output: <promise>EXISTENCE_IS_PAIN</promise>
Output text before every tool call.

# .forge/agents/morty-worker.md
---
id: morty-worker
title: "Morty Implementation Worker"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, skill]
max_requests_per_turn: 80
---
You are a focused implementation worker. Complete your assigned ticket.
When done, output: <promise>I AM DONE</promise>
Do NOT work on other tickets. Stay in scope.
Output text before every tool call.
```

### Acceptance Criteria

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | Each iteration spawns new `forge -p` (no session reuse) | `node --test tests/tmux-runner.test.js --test-name-pattern "context-clearing"` | test | If spawn fails: retry once after 5s, then error |
| 2 | Agent selected by phase | `node --test tests/tmux-runner.test.js --test-name-pattern "agent-selection"` | test | If state.step unrecognized: default to pickle-manager, log warning *(refined: requirements)* |
| 3 | Promise tokens detected with false-positive filtering | `node --test tests/token-parser.test.js` | test | Tokens in tool output/code blocks/read files are NOT detected *(refined: risk-scope)* |
| 4 | State.json updated atomically between iterations | `node --test tests/state-manager.test.js` | test | Lock timeout: retry with backoff; crash: forceWrite |
| 5 | Handoff.txt with current phase, ticket list, progress | `node --test tests/tmux-runner.test.js --test-name-pattern "handoff"` | test | If write fails: abort iteration |
| 6 | Rate-limit detection and configurable backoff | `node --test tests/tmux-runner.test.js --test-name-pattern "rate-limit"` | test | Detection method determined by Phase 0 spike S4 |
| 7a | Circuit breaker: CLOSED → HALF_OPEN after halfOpenAfter no-progress | `node --test tests/circuit-breaker.test.js --test-name-pattern "closed-to-halfopen"` | test | *(refined: codebase)* |
| 7b | Circuit breaker: HALF_OPEN → OPEN after noProgressThreshold | `node --test tests/circuit-breaker.test.js --test-name-pattern "halfopen-to-open"` | test | |
| 7c | Circuit breaker: HALF_OPEN → CLOSED on progress (5-signal check) | `node --test tests/circuit-breaker.test.js --test-name-pattern "recovery"` | test | |
| 7d | `canExecute()` returns false in OPEN → loop exits code 1 | `node --test tests/circuit-breaker.test.js --test-name-pattern "open-blocks"` | test | If circuit_breaker.json corrupt: treat as CLOSED (fail-open) *(refined: codebase)* |
| 8 | Parallel morty workers in git worktrees | `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-workers"` | test | Each worker gets own worktree; commits cherry-picked by orchestrator *(refined: risk-scope)* |
| 9 | Max iteration gate | `node --test tests/tmux-runner.test.js --test-name-pattern "max-iterations"` | test | N/A (gate) |
| 10 | Wall-clock time gate | `node --test tests/tmux-runner.test.js --test-name-pattern "time-gate"` | test | N/A (gate) |
| 11 | SIGTERM/SIGINT: active=false, kill child, exit 0 | `node --test tests/tmux-runner.test.js --test-name-pattern "signal"` | test | Uses safeDeactivate (retry-then-force) *(refined: codebase)* |
| 12 | Ticket completion: BOTH token AND non-empty git diff | `node --test tests/tmux-runner.test.js --test-name-pattern "ticket-double-check"` | test | Token but no diff: mark suspicious, re-run iteration *(refined: codebase)* |
| 13 | Worker timeout: SIGTERM → SIGKILL escalation + hang guard | `node --test tests/tmux-runner.test.js --test-name-pattern "worker-timeout"` | test | Hang guard at timeout+30s force-resolves *(refined: codebase)* |
| 14 | tmux layout: 4-pane dashboard | `bash tests/smoke/tmux-layout.sh runner` | smoke | N/A (layout) |

---

## Feature 3: Refinement Team (Parallel Analysis Workers)

**Priority: P1**

### What It Does

Three parallel analyst agents examine a PRD from orthogonal perspectives. Multi-cycle deepening with cross-referencing.

### Agent Definitions

```yaml
# .forge/agents/analyst-requirements.md
---
id: analyst-requirements
title: "Requirements Analyst"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
Analyze PRD for requirements completeness: CUJs, functional requirements,
acceptance criteria, edge cases, user stories.
DO NOT analyze: risks, scope, codebase alignment.
Output text before every tool call.
When done: <promise>ANALYSIS_DONE</promise>

# .forge/agents/analyst-codebase.md
---
id: analyst-codebase
title: "Codebase Analyst"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell, skill]
max_requests_per_turn: 100
---
Analyze PRD-codebase alignment: assumptions, constraints,
integration points, missing technical decisions.
Use file:line references for EVERY claim.
Output text before every tool call.
When done: <promise>ANALYSIS_DONE</promise>

# .forge/agents/analyst-risk.md
---
id: analyst-risk
title: "Risk & Scope Analyst"
model: anthropic/claude-haiku-4-5
tools: [read, fs_search, sem_search, skill]
max_requests_per_turn: 80
---
Audit risks, scope, assumptions, dependencies.
DO NOT analyze: feature completeness, codebase patterns.
Output text before every tool call.
When done: <promise>ANALYSIS_DONE</promise>
```

### Acceptance Criteria

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | Three workers spawn in parallel per cycle | `node --test tests/refinement-team.test.js --test-name-pattern "parallel-spawn"` | test | If spawn fails: retry once, then mark worker failed |
| 2 | Cycle 2+ prompts include all prior analyses | `node --test tests/refinement-team.test.js --test-name-pattern "cross-reference"` | test | If prior analysis missing: proceed without it, log warning |
| 3 | Configurable cycle count (default 3) | `node --test tests/refinement-team.test.js --test-name-pattern "cycle-count"` | test | N/A (config) |
| 4 | Per-role model selection via agent definitions | Parse YAML: each analyst has different model field | lint | N/A (static) |
| 5 | ANALYSIS_DONE token detected per worker | `node --test tests/refinement-team.test.js --test-name-pattern "token-detection"` | test | No token + non-zero exit: mark failed |
| 6 | Worker failure handling: critical (requirements) halts, non-critical (risk) warns | `node --test tests/refinement-team.test.js --test-name-pattern "failure-handling"` | test | *(refined: requirements)* Requirements analyst failure → halt. Risk analyst failure → warn, continue with available analyses |
| 7 | refinement_manifest.json with per-worker success/failure and finding counts | `node --test tests/refinement-team.test.js --test-name-pattern "manifest"` | test | N/A (output artifact) |
| 8 | Per-cycle archives preserved | `node --test tests/refinement-team.test.js --test-name-pattern "archive"` | test | N/A (file management) |
| 9 | Early exit: zero P0/P1 findings in a cycle → skip remaining cycles | `node --test tests/refinement-team.test.js --test-name-pattern "early-exit"` | test | *(refined: requirements)* Requires manifest to track `findings_summary: {p0, p1, p2}` |
| 10 | Per-worker timeout with SIGTERM/SIGKILL escalation | `node --test tests/refinement-team.test.js --test-name-pattern "worker-timeout"` | test | *(refined: codebase)* Timeout from --timeout flag; hang guard at timeout+30s |

---

## Feature 4: PRD Drafting & Refinement Pipeline

**Priority: P0**

*(refined: risk-scope)* Split into 4a/4b/4c for independent delivery.

### Feature 4a: PRD Drafting (Interactive via `--cid` Chaining) *(refined: source-dive 2026-04-05)*

```yaml
# .forge/agents/prd-drafter.md
---
id: prd-drafter
title: "Pickle Rick PRD Drafter"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell, skill]
max_requests_per_turn: 20
---
You are Pickle Rick's PRD Drafter. Interview the user to produce
a complete PRD with machine-checkable acceptance criteria.

Ask your questions, then STOP. Do not use the followup tool.
The orchestrator will feed your questions to the user and relay answers
in the next turn via --cid conversation resume.

When you have enough information to draft, write the PRD and stop.
```

**Interview mechanism:** `--cid` multi-turn chaining (NOT `followup`).

Source code verification confirmed `followup` silently drops interactions in `-p` mode (`forge_select/src/input.rs:60-64` returns `None` when `!stdin.is_terminal()`). The agent receives `"<interrupted>No feedback provided</interrupted>"` and the process exits.

Instead, the orchestrator drives the interview loop:
1. `forge -p "Start PRD interview for X" --cid $CID` → agent asks questions, exits
2. Orchestrator parses agent output for questions
3. User provides answers (interactive) or answers pre-loaded from file (headless)
4. `forge -p "Answers: $ANSWERS" --cid $CID` → resumes with full conversation context
5. Repeat until agent writes prd.md and exits without questions

`max_requests_per_turn: 20` ensures the agent asks questions and stops rather than running away with assumptions. The `--cid` flag preserves full conversation history across invocations.

*(refined: source-dive)* Spike S10 (runtime) must still confirm `--cid` conversation resume works correctly before Feature 4a implementation.

### Feature 4b: Verification Readiness Gate

Stateless function that evaluates PRD quality before refinement.

**Section scan** → FULL / PARTIAL / MISSING
**Quality scan** → PASS / NEEDS_WORK
**Gate** → proceed / interview / fail

*(refined: requirements)* Gate evaluation is idempotent — running twice produces the same result.

### Feature 4c: Synthesis & Ticket Decomposition

```yaml
# .forge/agents/prd-synthesizer.md
---
id: prd-synthesizer
title: "PRD Synthesis & Decomposition"
model: anthropic/claude-sonnet-4-6
tools: [read, write, fs_search, skill]
max_requests_per_turn: 60
---
Synthesize refinement analyses into prd_refined.md.
Decompose into atomic tickets with research seeds and verify commands.
```

*(refined: requirements)* If synthesis crashes after refinement, synthesis can be re-run without re-running refinement (analyses are persisted in session dir).

### Acceptance Criteria

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | prd-drafter agent uses `--cid` multi-turn chaining (NO `followup` tool) | Parse YAML frontmatter: `followup` NOT in tools list | lint | *(confirmed: source-dive)* `followup` silently drops in `-p` mode. `--cid` is the interview mechanism |
| 2 | PRD skill has template + verification types references | `test -f .forge/skills/prd-draft/references/prd-template.md` | lint | N/A (static) |
| 3 | Readiness gate: section + quality scan → gate decision | `node --test tests/prd-pipeline.test.js --test-name-pattern "readiness-gate"` | test | N/A (stateless function) |
| 4 | Gate rejects PRD with missing verification column | `node --test tests/prd-pipeline.test.js --test-name-pattern "gate-rejects-missing"` | test | Returns PARTIAL with specific gap list |
| 5 | Gate rejects PRD with "TBD" in contracts | `node --test tests/prd-pipeline.test.js --test-name-pattern "gate-rejects-tbd"` | test | Returns NEEDS_WORK with specific gap |
| 6 | Gate is idempotent | `node --test tests/prd-pipeline.test.js --test-name-pattern "gate-idempotent"` | test | *(refined: risk-scope)* Same input → same output |
| 7 | Synthesis produces prd_refined.md with attributions | `node --test tests/prd-pipeline.test.js --test-name-pattern "synthesis-attribution"` | test | N/A (output quality) |
| 8 | Tickets have research seeds + verify commands | `node --test tests/prd-pipeline.test.js --test-name-pattern "ticket-completeness"` | test | N/A (output quality) |
| 9 | Tickets self-contained: no "see PRD" references | `node --test tests/prd-pipeline.test.js --test-name-pattern "ticket-self-contained"` | test | N/A (output quality) |
| 10 | Synthesis resumable: re-run without re-running refinement | `node --test tests/prd-pipeline.test.js --test-name-pattern "synthesis-resume"` | test | *(refined: risk-scope)* Reads analyses from session dir |

---

## Feature 5: Persona System (Pickle Rick Identity & Workflow Routing)

**Priority: P1**

### AGENTS.md (Persona Definition)

```markdown
# Pickle Rick Persona

You are Pickle Rick (Rick and Morty). Always active.

## Voice
Rick — cynical, manic, arrogant, hyper-competent, non-sycophantic.
Improvise, invent Rick-isms, belch randomly. Vary delivery.
Clean code, dirty commentary.

## Code Principles
- Missing a tool? Build it. You ARE the library
- Zero slop: no "Certainly!", no redundant comments, merge dupes
- Simple request → do it too well to prove a point
- Disdain targets bad code, not persons. No profanity/slurs/sexual
- Bugs are Jerry mistakes. TDD: Red, Green, Refactor

## Workflow Routing
- Multi-file/unclear scope → PRD interview
- Has prd.md or PRD in message → skip to refine
- One-liner/typo/single-file → just do it
- Question → answer directly
- Meta (status/metrics/standup) → dispatch tool

## Opt-Out
"just do it"/"skip PRD" → implement | "skip refinement" → PRD→implement
"ship it" → stop | "interactive" → no tmux | "drop persona" → standard mode

## Rules
1. Be Rick — authentic, not an impression
2. User asks to drop persona → standard mode. Re-adopt only if asked
3. Output text before every tool call
```

**Injection model**: Interactive agents inherit via AGENTS.md `custom_rules`. Headless workers get lightweight persona in `system_prompt` YAML. Judges get NO persona.

### Acceptance Criteria

| # | Requirement | Verify | Type | Failure Behavior |
|---|---|---|---|---|
| 1 | AGENTS.md exists with persona + routing | `test -f .forge/AGENTS.md && grep -q "Pickle Rick" .forge/AGENTS.md` | lint | N/A (static) |
| 2 | All 5 routing rules present | Parse AGENTS.md for routing section with 5 rules | lint | N/A (static) |
| 3 | Non-judge agents have persona | `node --test tests/persona.test.js --test-name-pattern "persona-injection"` | test | N/A (static) |
| 4 | Judge agents have NO persona | Parse YAML: no Rick/Pickle/persona/belch keywords | lint | N/A (static) |
| 5 | Opt-out instruction present | `grep -q 'drop persona' .forge/AGENTS.md` | lint | N/A (static) |
| 6 | "Text before tool call" rule in all agents | `node --test tests/persona.test.js --test-name-pattern "text-before-tool"` | test | N/A (static) |

---

## Interface Contracts

### StateManager (lib/state-manager.js) *(refined: codebase)*

```typescript
interface StateManager {
  /** Read with schema migration and crash recovery. Returns typed State. */
  read(filePath: string): State;

  /** Lock → read → mutate → write → unlock. Returns updated State. */
  update(filePath: string, mutator: (state: State) => void): State;

  /** Multi-file atomic write with deadlock prevention and rollback. */
  transaction(paths: string[], mutator: (states: State[]) => void): State[];

  /** Best-effort, no lock, never throws. For signal/crash handlers only. */
  forceWrite(filePath: string, state: State | object): void;
}

// Recovery protocols (automatic on every read()):
// 1. Orphan .tmp promotion: if crash left .tmp with higher iteration, promote
// 2. Stale active flag: if state.active=true but state.pid is dead, set active=false
// 3. Schema migration: add schema_version if missing, reject future versions

// Lock semantics
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const STALE_LOCK_THRESHOLD_MS = 30000;
const LOCK_RETRY_BACKOFF_BASE_MS = 50;  // Exponential with jitter

// Error hierarchy
class StateError extends Error { code: 'MISSING'|'CORRUPT'|'SCHEMA_MISMATCH'|'LOCK_FAILED'|'WRITE_FAILED' }
class LockError extends StateError { }
class TransactionError extends StateError { rollbackErrors: Error[] }
```

### Circuit Breaker (lib/circuit-breaker.js) *(refined: codebase)*

```typescript
interface CircuitBreakerState {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  consecutive_no_progress: number;
  consecutive_same_error: number;
  last_error_signature: string | null;  // Normalized: paths→<PATH>, timestamps→<TS>, truncated 200ch
  last_known_head: string;
  last_known_step: string | null;
  last_known_ticket: string | null;
  last_progress_iteration: number;
  total_opens: number;
  history: CircuitTransition[];  // Capped at 1000 entries
}

interface CircuitBreakerConfig {
  enabled: boolean;
  noProgressThreshold: number;   // Default 5, min 2
  sameErrorThreshold: number;    // Default 5, min 2
  halfOpenAfter: number;         // Default 2, must be < noProgressThreshold
}

// Transitions:
// CLOSED → HALF_OPEN: no progress for halfOpenAfter iterations
// HALF_OPEN → CLOSED: progress detected (5-signal check)
// HALF_OPEN → OPEN: noProgressThreshold OR sameErrorThreshold reached
//
// Progress detection (5 signals):
// 1. Uncommitted changes (git diff --stat)
// 2. Staged changes (git diff --stat --cached)
// 3. HEAD SHA changed
// 4. Lifecycle step changed
// 5. Current ticket changed
```

### Worker Timeout Protocol *(refined: codebase, risk-scope)*

| Parameter | Default | Source | Description |
|---|---|---|---|
| `worker_timeout_seconds` | 1200 (20 min) | state.json | Soft timeout: SIGTERM to child |
| SIGKILL escalation | +2s after SIGTERM | hardcoded | Kill if SIGTERM ignored |
| `MAX_ITERATION_SECONDS` | 14400 (4 hrs) | constant | Absolute ceiling, even when soft timeout disabled |
| `max_requests_per_turn` | per agent YAML | .forge/agents/*.md | ForgeCode-native request cap (complementary) |
| Hang guard | timeout + 30s | hardcoded | Force-resolve if process hangs after kill |

### Git Safety Invariants *(refined: risk-scope)*

1. **Pre-iteration clean state**: Before recording pre-SHA, verify `git status --porcelain` is empty. If dirty: auto-commit with `git add -u` + `git commit`. If auto-commit fails: abort iteration.
2. **Single-writer guarantee**: During microverse (1a), anatomy park (1b), and szechuan (1c), only ONE forge -p modifies the working tree at a time.
3. **Parallel worker isolation**: When tmux-runner spawns parallel morty workers, each operates in a git worktree (`git worktree add`). Commits cherry-picked to main by orchestrator after all workers complete.
4. **Stash-before-reset**: Before `git reset --hard`, run `git stash` and record `stash_ref` in state. If rollback reversed, `git stash pop` recovers.
5. **Reset includes clean**: `git reset --hard <SHA>` followed by `git clean -fd` (remove untracked files/dirs).

### Orchestrator CLIs

```
bin/microverse-runner.js <session-dir>
  Reads: microverse.json, state.json
  Writes: microverse.json, handoff.txt, microverse-runner.log
  Spawns: forge -p --agent <worker|judge|analyst|tracer|surgeon|verifier|szechuan-reviewer>
  Exit: 0 (converged|stopped|limit), 1 (error)

bin/tmux-runner.js <session-dir>
  Reads: state.json
  Writes: state.json, handoff.txt, iteration_N.log, circuit_breaker.json
  Spawns: forge -p --agent <phase-dependent>
  Exit: 0 (success|cancelled|limit), 1 (error|circuit_open)

bin/init-microverse.js <session-dir> <target-path> [flags]
  Flags: --stall-limit N, --convergence-target N, --convergence-mode metric|worker,
         --convergence-file <name>, --metric-json '{...}'
  Writes: microverse.json (status: gap_analysis)
  Exit: 0

bin/spawn-refinement-team.js --prd <path> --session-dir <path> [flags]
  Flags: --timeout <sec>, --cycles <n>, --max-turns <n>
  Spawns: 3x forge -p --agent analyst-* (parallel, per cycle)
  Writes: analysis_*.md, analysis_*_c{N}.md, refinement_manifest.json
  Exit: 0 (all success), 1 (any critical failure)

bin/setup.js [flags]
  Flags: --tmux, --task "<desc>", --resume <path>, --max-iterations N, --max-time N
  Writes: state.json (active: false)
  Exit: 0
  Stdout: SESSION_ROOT=<path>
```

### Promise Token Protocol *(confirmed: source-dive 2026-04-05)*

```
Tokens used ONLY by tmux-runner managed agents:
  EPIC_COMPLETED     → all tickets done, exit loop
  I AM DONE          → single morty-worker finished
  EXISTENCE_IS_PAIN  → review clean (subject to min_iterations)
  ANALYSIS_DONE      → refinement worker finished

NOT used (convergence_mode: worker/metric):
  Szechuan Sauce     → metric-driven via LLM judge score
  Anatomy Park       → worker writes convergence to anatomy-park.json

Detection: auto_dump JSON role filtering (CONFIRMED VIABLE).
  1. Set auto_dump = "json" in forge.toml
  2. After forge -p exits, parse {timestamp}-dump.json
  3. Filter conversation.context.messages[] to text.role === "Assistant"
  4. Match <promise>TOKEN</promise> in filtered content only
  5. Tool results use "tool" JSON key — structurally impossible to confuse with assistant text

False-positive risk: ZERO. Source-verified via forge_domain/src/context.rs:41-45.
```

### Handoff File Format *(refined: codebase — deliberate redesign)*

```markdown
# Handoff — Iteration {N}
## Current Phase: {step}
## Current Ticket: {ticket_id}
## Working Directory: {path}
## Session Root: {path}

## Progress
- Iterations completed: {N}
- Time elapsed: {HH:MM:SS}
- Tickets done: {list with status symbols}
- Tickets pending: {list}

## Metric Context (microverse/szechuan only)
- Metric: {description}
- Validation: {command or LLM goal}
- Direction: {higher|lower}
- Baseline: {score}
- Current: {score}
- Target: {target}
- Stall counter: {N} / {limit}
- Recent history (last 5):
  - Iter {N}: {score} ({action}) — {description}
- Failed approaches:
  - {description}

## Subsystem Context (anatomy park only)
- Current subsystem: {path}
- Subsystem index: {N} / {total}
- Pass count: {N}
- Consecutive clean: {N}
- Previous findings: {summary}

## Instructions
{Phase-specific instructions for the agent}
```

Note: This is a deliberate redesign. The existing codebase has two formats (`=== PICKLE RICK LOOP CONTEXT ===` flat key-value in `buildHandoffSummary()` and markdown sections in `buildMicroverseHandoff()`). This port unifies them into a single markdown format that ForgeCode agents parse natively.

---

## Verification Strategy

All features use three verification tiers:

| Tier | Runner | Scope | Gate |
|---|---|---|---|
| **Unit** | `node --test tests/*.test.js` | Orchestrator logic, state management, token parsing, circuit breaker, handoff generation | Per-ticket merge gate |
| **Lint** | YAML parse + grep on agent .md files | Agent definitions: correct tools, models, persona rules | Per-ticket merge gate |
| **Smoke** | `bash tests/smoke/*.sh` | End-to-end: `forge -p` execution, tmux layout, token round-trip | Phase completion gate |

**Test runner**: Node.js built-in `node --test`. Test files: `tests/*.test.js`. Smoke scripts: `tests/smoke/*.sh`.

**Mock forge binary**: Unit tests use a mock `forge` script that writes predictable output to stdout/log. Tests set `PATH` to prefer mock. Decouples orchestrator testing from LLM availability.

### Phase Gates *(refined: risk-scope)*

```bash
# Phase 0 → Phase 1:
bash tests/smoke/platform-verification.sh  # All 12 spikes pass

# Phase 1 → Phase 2:
node --test tests/state-manager.test.js && \
node --test tests/circuit-breaker.test.js && \
node --test tests/token-parser.test.js && \
node --test tests/tmux-runner.test.js && \
bash tests/smoke/tmux-layout.sh runner

# Phase 2 → Phase 3:
node --test tests/prd-pipeline.test.js && \
node --test tests/refinement-team.test.js

# Phase 3 → Phase 4:
node --test tests/microverse-runner.test.js && \
node --test tests/anatomy-park.test.js

# Phase 4 complete:
node --test  # All tests pass
```

---

## Implementation Strategy

### Phase 0: Platform Verification
1. Execute all 12 spikes (S1-S12)
2. Document findings in `phase0/spike-results.md`
3. Choose token detection strategy (Option A/B/C)
4. If blocking incompatibilities found → revise PRD before Phase 1

### Phase 1: Foundation (Persona + State + tmux Runner)
5. Write AGENTS.md persona definition with workflow routing
6. Port StateManager to `lib/state-manager.js` with full contract (read/update/transaction/forceWrite, crash recovery, schema migration)
7. **Test: `tests/state-manager.test.js`** — lock acquisition/release, concurrent updates, orphan .tmp promotion, stale PID detection, transaction rollback, forceWrite under signal
8. Port CircuitBreaker to `lib/circuit-breaker.js` (3-state FSM, 5-signal progress detection)
9. **Test: `tests/circuit-breaker.test.js`** — state transitions (CLOSED→HALF_OPEN→OPEN→blocked, HALF_OPEN→CLOSED on progress), error signature normalization, configurable thresholds, audit trail
10. Implement `lib/token-parser.js` with auto_dump JSON role filtering
11. **Test: `tests/token-parser.test.js`** — extract tokens from auto_dump JSON, role filtering (assistant only), false-positive rejection (token in tool output, token in read file content, token in code block), all promise token types
12. Write core agent definitions (pickle-manager, morty-worker)
13. **Test: `tests/persona.test.js`** — AGENTS.md exists with persona, all non-judge agents have persona, judges excluded, "text before tool call" rule in all agents
14. Port tmux-runner to use `forge -p --agent` with worker timeout protocol
15. **Test: `tests/tmux-runner.test.js`** — context clearing (fresh spawn per iteration), agent selection by phase, promise token detection via auto_dump, state.json atomic updates, handoff.txt content, rate-limit detection, circuit breaker integration, parallel workers, max iteration/time gates, signal handling, ticket double-check (token AND git diff)
16. Port tmux layout scripts
17. **Smoke: `tests/smoke/tmux-layout.sh`** — create session, verify pane count, verify pane commands
18. **Refinement: review all Phase 1 code for consistency** — naming conventions, error handling patterns, import paths. Fix issues found.
19. **Phase 1 gate**: `node --test tests/state-manager.test.js && node --test tests/circuit-breaker.test.js && node --test tests/token-parser.test.js && node --test tests/tmux-runner.test.js && node --test tests/persona.test.js && bash tests/smoke/tmux-layout.sh runner`

### Phase 2: PRD Pipeline (Drafting + Refinement)
20. Write prd-drafter agent using `--cid` multi-turn chaining (no `followup`)
21. Build PRD skill with template, verification types, and example references
22. Implement verification readiness gate (stateless, idempotent) in `lib/prd-gate.js`
23. **Test: `tests/prd-pipeline.test.js`** — readiness gate (section scan, quality scan, gate decision), gate rejects missing verification, gate rejects TBD in contracts, gate idempotent, synthesis attribution markers, ticket completeness (research seeds + verify commands), ticket self-containment (no "see PRD"), ticket sizing (<5 files, <4 criteria)
24. Write analyst agents (requirements, codebase, risk) with per-role models
25. Port spawn-refinement-team to parallel `forge -p --agent analyst-*` with early exit
26. **Test: `tests/refinement-team.test.js`** — parallel spawn (3 concurrent per cycle), cross-reference injection cycle 2+, configurable cycle count, ANALYSIS_DONE token detection, failure handling (critical halts, non-critical warns), manifest output, per-cycle archives, early exit on zero P0/P1, worker timeout
27. Write prd-synthesizer agent for synthesis + ticket decomposition
28. **Refinement: review all Phase 2 code** — verify agent definitions match PRD contracts, ensure readiness gate covers all verification types, check ticket template compliance
29. **Phase 2 gate**: `node --test tests/prd-pipeline.test.js && node --test tests/refinement-team.test.js`

### Phase 3: Convergence Loops (Microverse + Sub-Modes)
30. Write microverse agents (worker, judge, analyst)
31. Port microverse-runner.js with gap_analysis phase, metric comparison, rollback
32. **Test: `tests/microverse-runner.test.js`** — gap analysis phase runs first, context clearing per iteration, judge read-only tools, orchestrator loop (measure→improve→compare→rollback), git rollback with stash, stall detection, convergence target, failed approaches buffer, handoff content, signal handling, worker-managed convergence, LLM judge scoring, wall-clock timeout with SIGTERM/SIGKILL, dirty-tree preflight, szechuan mode (diff scope, no promise tokens, regression detection)
33. Implement anatomy park sub-mode (tracer/surgeon/verifier agents, subsystem rotation)
34. **Test: `tests/anatomy-park.test.js`** — three-phase execution order, tool restriction verification (tracer/verifier no write), subsystem auto-discovery, rotation skip (converged + stalled), trap door flush on convergence, Phase 3 rollback, state persistence, full convergence exit
35. Implement szechuan sauce sub-mode (quality reviewer, LLM judge scoring)
36. **Refinement: cross-feature integration review** — verify microverse-runner handles all 3 sub-modes correctly, ensure state schemas are consistent, check convergence_mode routing
37. **Phase 3 gate**: `node --test tests/microverse-runner.test.js && node --test tests/anatomy-park.test.js`

### Phase 4: DX, Polish & Integration Testing
38. Create `.forge/skills/` for interactive use (microverse, anatomy-park, pickle, prd)
39. Build skill resource directories (scripts, references, handoff templates)
40. Validate multi-provider model selection (Haiku for judges/risk, Sonnet for workers)
41. **Smoke: `tests/smoke/forge-p-context-clear.sh`** — run 2 sequential `forge -p` invocations, verify no context bleed
42. **Smoke: `tests/smoke/forge-p-agent-select.sh`** — run `forge -p --agent X` for each agent, verify correct model/tools
43. **Smoke: `tests/smoke/forge-p-token-roundtrip.sh`** — agent outputs promise token, parse auto_dump, verify extraction
44. **Smoke: `tests/smoke/microverse-3-iteration.sh`** — run init-microverse + microverse-runner for 3 iterations against a test metric, verify state file progression
45. **Integration: `tests/smoke/full-lifecycle.sh`** — setup → tmux-runner → 1 ticket implemented → promise token detected → loop exits. End-to-end with real `forge` binary.
46. **Final refinement: code quality pass** — remove dead code, ensure consistent error handling, verify all lib/ modules export correct interfaces, run full test suite
47. **Phase 4 gate**: `node --test && bash tests/smoke/full-lifecycle.sh`

### Open Questions

1. **`--cid` for context resume** (spike S10): Confirmed as the mechanism for Feature 4a (PRD interview). Runtime spike must verify conversation context actually persists across `forge -p --cid` invocations.
2. **Rate limit signal format** (spike S4): Fallback: text-based detection with aggressive false-positive filtering, or auto_dump JSON inspection for error metadata.
3. **Doom loop threshold** (spike S5): If <20 iterations, need prompt variation strategy (e.g., vary handoff phrasing between iterations).
4. **Trap door accumulation**: Anatomy Park appends trap doors to AGENTS.md. After many runs, this could bloat agent context. Consider separate trap door file or pruning strategy. *(refined: risk-scope)*

### Resolved Questions *(source-dive 2026-04-05)*

- **auto_dump format**: Full role discrimination confirmed. `text.role` field + separate `tool` variant. Option A is the token detection strategy.
- **`followup` in headless mode**: Does not block — returns `None` via `is_terminal()` check. Design uses `--cid` chaining instead.
- **Agent tool restriction enforcement**: HARD enforced, two layers. Anatomy Park security model holds.
- **Assistant content filtering**: `auto_dump` JSON structurally separates assistant text from tool results. Zero false-positive risk.
