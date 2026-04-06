# PRD: Pickle Rick Feature Port to ForgeCode

## Overview

Port Pickle Rick's autonomous engineering capabilities to ForgeCode's native primitives: custom agents (`.forge/agents/`), skills (`.forge/skills/`), MCP tools, and `forge -p` headless execution. The goal is a native ForgeCode experience — not a wrapper around Claude Code.

## Architecture Mapping

### Primitive Translation Table

| Pickle Rick Primitive | ForgeCode Equivalent | Gap / Workaround |
|---|---|---|
| `claude -p "<prompt>"` | `forge -p "<prompt>"` | Equivalent. `--agent <id>` adds per-invocation agent selection |
| `--no-session-persistence` | Default for `forge -p` (exits after one turn) | Equivalent — each `forge -p` is a fresh context |
| `--output-format stream-json` | No JSON output mode | Use `auto_dump` config for conversation JSON side-channel, or parse markdown stdout |
| `.claude/commands/*.md` | `.forge/skills/*/SKILL.md` + `.forge/commands/*.md` | Skills are richer (resource dirs, progressive disclosure). Commands are simpler (prompt injection) |
| Claude Code hooks (stop-hook, post-tool-use) | No user-configurable hooks | External orchestration must handle lifecycle events. MCP server could provide state query tools |
| `StateManager` (file locks, transactions) | None built-in | Port as `lib/state-manager.js` — orchestrator-side only, agents don't need it |
| Promise tokens (`<promise>X</promise>`) | No output classification | Parse `forge -p` stdout or `auto_dump` conversation file for tokens |
| `--dangerously-skip-permissions` | Agent-level tool restrictions in YAML | Better — explicit tool allowlists per agent role |
| `--add-dir` (context directories) | No equivalent flag | Include paths in prompt or use skill resources |
| `--max-turns` | `max_requests_per_turn` per agent | Equivalent — configured in agent YAML |
| tmux session management | External (same as Pickle Rick) | tmux orchestration lives outside both tools |

### Key Architectural Decisions

1. **Orchestration stays external.** ForgeCode has no workflow engine. The tmux-runner, microverse-runner, and refinement coordinator remain Node.js (or Rust) scripts that shell out to `forge -p`.

2. **Agent definitions replace prompt engineering.** Instead of injecting role instructions into a single `claude -p` prompt, define `.forge/agents/` with explicit tool restrictions, models, and system prompts.

3. **Skills replace command templates.** `.forge/skills/*/` directories bundle instructions + scripts + references. Progressive disclosure (metadata always loaded, body on-demand) saves tokens.

4. **State management stays in the orchestrator.** Agents don't need to query state mid-turn — the orchestrator writes everything they need into handoff.txt before spawning them. StateManager is a Node.js library used by orchestrator scripts, not an MCP server.

5. **Multi-provider is the killer feature.** Per-agent model selection means gap analysis runs on cheap models, implementation on expensive ones, and LLM judges on fast ones — without OpenRouter routing.

---

## Feature 1: Microverse Convergence Loop

**Priority: P0 (user's primary interest)**

### What It Does

Metric-driven optimization loop: measure baseline, make targeted improvements, verify, compare, rollback regressions, repeat until converged or stalled.

### ForgeCode Architecture

```
forge-microverse/
  bin/
    microverse-runner.js          # External Node.js orchestrator (NOT a forge agent)
    init-microverse.js            # Session setup CLI
  .forge/
    agents/
      microverse-worker.md        # Implementation agent (write/shell/patch)
      microverse-judge.md         # Scoring agent (read-only, different model)
      microverse-analyst.md       # Gap analysis agent (read + search)
    skills/
      microverse/
        SKILL.md                  # Coordinator instructions (for interactive use)
        scripts/
          measure-metric.sh       # Reusable metric measurement wrapper
        references/
          handoff-format.md       # Handoff file schema documentation
  lib/
    state-manager.js              # File-locked atomic state management (used by orchestrators)
```

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

Read handoff.txt in your working directory FIRST. It contains:
- Current metric value and target
- Recent iteration history
- Failed approaches to avoid
- Specific improvement instructions

Make ONE targeted change per iteration. Small, verifiable, atomic.
Commit your work with a descriptive message.
Do not attempt multiple changes — the orchestrator handles iteration.
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

Do NOT adopt any persona. Do NOT explain your reasoning at length.
Read the scoring criteria, examine the code, output ONLY a single
integer or decimal number on the LAST line of your response.
```

### Orchestrator Loop (microverse-runner.js)

```
┌─────────────────────────────────────────────────┐
│ microverse-runner.js (Node.js, runs in tmux)    │
│                                                 │
│  1. Read microverse.json (state)                │
│  2. Write handoff.txt (context for worker)      │
│  3. Record pre-iteration git SHA                │
│  4. Spawn: forge -p "$(cat handoff.txt)"        │
│           --agent microverse-worker             │
│     → Fresh context, exits on completion        │
│  5. Check git SHA delta (commits made?)         │
│  6. Measure metric:                             │
│     a. Type 'command': run shell script          │
│     b. Type 'llm': forge -p "<judge prompt>"    │
│              --agent microverse-judge            │
│  7. Compare: improved / regressed / held         │
│  8. If regressed: git reset --hard <pre-SHA>    │
│  9. Update microverse.json (history, stalls)    │
│ 10. If converged: exit. Else: goto 1            │
└─────────────────────────────────────────────────┘
```

### Context Clearing via `forge -p`

Each iteration spawns a **new `forge -p` process**:
- Fresh LLM context (no prior conversation bleed)
- Agent-specific tool restrictions and model
- Handoff.txt provides structured continuity
- Process exits after completion — no session accumulation

This is architecturally identical to `claude -p --no-session-persistence` but with the added benefit of `--agent` selecting pre-configured roles.

### tmux Integration

```bash
# Session layout (same pattern as Pickle Rick)
tmux new-session -d -s forge-microverse -c $WORKING_DIR

# Pane 0: Orchestrator
tmux send-keys "node microverse-runner.js $SESSION_DIR" Enter

# Pane 1: Log tail
tmux split-window -h
tmux send-keys "tail -f $SESSION_DIR/microverse-runner.log" Enter

# Pane 2: Metric history
tmux split-window -v
tmux send-keys "watch -n5 'cat $SESSION_DIR/microverse.json | jq .convergence.history'" Enter
```

### Metric Measurement

Two modes, same as current:

**Command mode:** Shell script returns numeric score on last line.
```bash
# measure-metric.sh wrapper
#!/bin/bash
RESULT=$($VALIDATION_CMD 2>&1)
SCORE=$(echo "$RESULT" | tail -1)
echo "$SCORE"
```

**LLM judge mode:** Uses `forge -p --agent microverse-judge` instead of `claude -p`.
```bash
forge -p "$(cat judge-prompt.txt)" \
  --agent microverse-judge
```

**Advantage over Pickle Rick:** Judge agent has explicit read-only tool restrictions in YAML. No need for `--allowedTools` flag — the agent definition enforces it.

### State Persistence (microverse.json)

Identical schema to current implementation:
```json
{
  "status": "iterating",
  "key_metric": { "description": "...", "validation": "...", "type": "command", "direction": "higher", "tolerance": 0.5 },
  "convergence": {
    "stall_limit": 5,
    "stall_counter": 0,
    "history": [{ "iteration": 1, "score": 42, "action": "accept", "pre_iteration_sha": "abc123" }]
  },
  "baseline_score": 40,
  "failed_approaches": [],
  "convergence_target": 95
}
```

### Output Parsing Challenge

**Problem:** `forge -p` outputs streamed markdown, not JSON. Extracting promise tokens or structured results requires parsing.

**Workarounds:**
1. **`auto_dump` config** — ForgeCode can dump full conversation JSON to a file on completion. Parse that file for structured output.
2. **Stdout scraping** — Regex match last lines for numeric scores (same as current `extractScore()` approach).

**Recommendation:** Use stdout scraping for scores (proven pattern from pickle-rick-claude's `extractScore()`). Use `auto_dump` as fallback for debugging when stdout parsing fails.

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Agent definition exists with correct tools/model | `node --test tests/microverse-runner.test.js --test-name-pattern "agent-definitions"` | test |
| 2 | Each iteration spawns a new `forge -p` process (fresh context) | `node --test tests/microverse-runner.test.js --test-name-pattern "context-clearing"` | test |
| 3 | Judge agent has read-only tools (no write/patch/shell) | `grep -c 'write\|patch' .forge/agents/microverse-judge.md` exits with output `0` | lint |
| 4 | Orchestrator loop: measure → improve → compare → rollback/keep | `node --test tests/microverse-runner.test.js --test-name-pattern "orchestrator-loop"` | test |
| 5 | Git rollback on regression resets to pre-iteration SHA | `node --test tests/microverse-runner.test.js --test-name-pattern "rollback"` | test |
| 6 | Stall detection increments counter, converges at stall_limit | `node --test tests/microverse-runner.test.js --test-name-pattern "stall-detection"` | test |
| 7 | Convergence target triggers early exit when score meets threshold | `node --test tests/microverse-runner.test.js --test-name-pattern "convergence-target"` | test |
| 8 | Failed approaches tracked in circular buffer (max 100) | `node --test tests/microverse-runner.test.js --test-name-pattern "failed-approaches"` | test |
| 9 | Handoff.txt contains iteration number, metric, history, failed approaches | `node --test tests/microverse-runner.test.js --test-name-pattern "handoff-content"` | test |
| 10 | Signal handler (SIGTERM) persists state and exits cleanly | `node --test tests/microverse-runner.test.js --test-name-pattern "signal-handling"` | test |
| 11 | Worker-managed convergence polls convergence.json | `node --test tests/microverse-runner.test.js --test-name-pattern "worker-managed"` | test |
| 12 | LLM judge: forge -p --agent microverse-judge returns numeric score | `bash tests/smoke/forge-p-judge-score.sh` | test |
| 13 | tmux layout creates 3 panes (orchestrator, log, metric watch) | `bash tests/smoke/tmux-layout.sh microverse` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1-2 | `tests/microverse-runner.test.js` | Agent defs have required YAML fields; each iteration calls spawn with fresh args | Agent files exist, YAML parses, `id`/`model`/`tools` present; spawn called N times for N iterations |
| 3 | Manual/lint | Judge agent markdown has no write tools | `grep` returns 0 matches |
| 4 | `tests/microverse-runner.test.js` | Mock forge binary writes known score to stdout; orchestrator classifies correctly | `compareMetric()` returns `improved`/`regressed`/`held` for known inputs |
| 5 | `tests/microverse-runner.test.js` | After regression, HEAD matches pre-iteration SHA | Git SHA comparison after `resetToSha()` |
| 6-8 | `tests/microverse-runner.test.js` | State management: stall counter, convergence check, circular buffer | `isConverged()` true at limit; buffer wraps at 100 |
| 9 | `tests/microverse-runner.test.js` | Generated handoff.txt matches expected schema | Regex/parse validation of handoff content |
| 10 | `tests/microverse-runner.test.js` | Send SIGTERM to child process, verify state.json written with `active: false` | File exists, JSON parses, `active === false` |
| 11 | `tests/microverse-runner.test.js` | Write `{converged: true}` to convergence.json, verify loop exits | Exit reason === 'converged' |
| 12 | `tests/smoke/forge-p-judge-score.sh` | Run `forge -p` with trivial judge prompt, parse last line as number | Exit code 0, last line matches `/^\d+(\.\d+)?$/` |
| 13 | `tests/smoke/tmux-layout.sh` | Create tmux session, verify pane count | `tmux list-panes` returns 3 lines |

---

## Feature 2: tmux Runner (Context-Clearing Iteration Loop)

**Priority: P0 (foundation for all other features)**

### What It Does

Outer orchestration loop that spawns fresh `forge -p` invocations per iteration, manages state transitions, detects completion via output tokens, handles rate limits, and coordinates the full PRD-to-review lifecycle.

### ForgeCode Architecture

```yaml
# .forge/agents/pickle-manager.md
---
id: pickle-manager
title: "Pickle Rick Session Manager"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
You are the Pickle Rick session manager. Read state.json and handoff.txt
to understand your current phase and pending work.

Your phases: prd → breakdown → research → plan → implement → refactor → review.
Advance through phases by completing the current one and updating state.

When ALL tickets are complete, output: <promise>EPIC_COMPLETED</promise>
When review passes clean, output: <promise>EXISTENCE_IS_PAIN</promise>
```

```yaml
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
```

### Runner Loop

```
forge-tmux-runner.js:
  while (active && iteration < max_iterations && within_time_budget):
    1. Read state.json
    2. Select agent based on current phase:
       - prd/breakdown/research → pickle-manager
       - implement → morty-worker (per ticket)
       - refactor/review → pickle-manager or meeseeks
    3. Write handoff.txt with phase context
    4. Spawn: forge -p "$(cat handoff.txt)" --agent <selected>
    5. Capture output to iteration_N.log
    6. Parse output for promise tokens
    7. Classify: task_completed | review_clean | continue
    8. Update state.json (iteration++, phase transitions)
    9. Handle rate limits (backoff + retry)
    10. Circuit breaker check
```

### Ticket-Level Parallelism

```bash
# Parallel morty workers (same pattern as spawn-morty.ts)
for ticket in $PENDING_TICKETS; do
  forge -p "$(cat tickets/$ticket/prompt.txt)" \
    --agent morty-worker &
  PIDS+=($!)
done
wait "${PIDS[@]}"
```

**Advantage:** Each `forge -p --agent morty-worker` gets its own model config. Could run cheap tickets on Haiku, complex ones on Opus.

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Each iteration spawns new `forge -p` (no session reuse) | `node --test tests/tmux-runner.test.js --test-name-pattern "context-clearing"` | test |
| 2 | Agent selected by phase: manager for prd/breakdown, morty-worker for implement | `node --test tests/tmux-runner.test.js --test-name-pattern "agent-selection"` | test |
| 3 | Promise tokens detected: EPIC_COMPLETED, EXISTENCE_IS_PAIN, I AM DONE | `node --test tests/tmux-runner.test.js --test-name-pattern "promise-tokens"` | test |
| 4 | State.json updated atomically between iterations (lock + write + unlock) | `node --test tests/state-manager.test.js` | test |
| 5 | Handoff.txt written with current phase, ticket list, progress summary | `node --test tests/tmux-runner.test.js --test-name-pattern "handoff"` | test |
| 6 | Rate-limit detection: parse stdout for limit patterns, backoff with retry | `node --test tests/tmux-runner.test.js --test-name-pattern "rate-limit"` | test |
| 7 | Circuit breaker opens after N consecutive no-progress iterations | `node --test tests/tmux-runner.test.js --test-name-pattern "circuit-breaker"` | test |
| 8 | Parallel morty workers: N concurrent `forge -p` spawns, collect results | `node --test tests/tmux-runner.test.js --test-name-pattern "parallel-workers"` | test |
| 9 | Max iteration gate: loop exits when iteration >= max_iterations | `node --test tests/tmux-runner.test.js --test-name-pattern "max-iterations"` | test |
| 10 | Wall-clock time gate: loop exits when elapsed >= max_time_minutes | `node --test tests/tmux-runner.test.js --test-name-pattern "time-gate"` | test |
| 11 | SIGTERM/SIGINT: set active=false, kill child, exit 0 | `node --test tests/tmux-runner.test.js --test-name-pattern "signal"` | test |
| 12 | tmux layout: 4-pane dashboard (orchestrator, log, morty, raw) | `bash tests/smoke/tmux-layout.sh runner` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1 | `tests/tmux-runner.test.js` | Mock forge binary; verify spawn called with `--agent` flag, no `--cid` (fresh each time) | spawn args include `-p` and `--agent`, no conversation resume |
| 2 | `tests/tmux-runner.test.js` | Set state.step to each phase, verify correct agent ID selected | `selectAgent('implement')` === 'morty-worker' |
| 3 | `tests/tmux-runner.test.js` | Feed known log content with/without promise tokens | `classifyCompletion()` returns correct classification |
| 4 | `tests/state-manager.test.js` | Concurrent update attempts; verify lock prevents corruption | Two parallel writes produce valid JSON with both changes |
| 5-6 | `tests/tmux-runner.test.js` | Handoff content matches schema; rate limit patterns detected in mock output | Regex match; backoff timer set |
| 7 | `tests/tmux-runner.test.js` | Feed N iterations with no git diff → circuit breaker opens | `canExecute()` returns false after threshold |
| 8 | `tests/tmux-runner.test.js` | Spawn 3 mock workers, verify all 3 PIDs started, all 3 awaited | Promise.all resolves with 3 results |
| 9-10 | `tests/tmux-runner.test.js` | Set max_iterations=2, run 3 → exits at 2; set max_time=0, run → exits immediately | Loop iteration count matches gate |
| 11 | `tests/tmux-runner.test.js` | Send SIGTERM, verify state persisted with active=false | File check after signal |
| 12 | `tests/smoke/tmux-layout.sh` | Create session, count panes | `tmux list-panes` returns 4 |

---

## Feature 3: Refinement Team (Parallel Analysis Workers)

**Priority: P1**

### What It Does

Three parallel analyst agents examine a PRD from orthogonal perspectives (requirements completeness, codebase alignment, risk/scope). Multi-cycle deepening with cross-referencing.

### ForgeCode Architecture

```yaml
# .forge/agents/analyst-requirements.md
---
id: analyst-requirements
title: "Requirements Analyst"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
Analyze the PRD for requirements completeness...

# .forge/agents/analyst-codebase.md
---
id: analyst-codebase
title: "Codebase Analyst"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell, skill]
max_requests_per_turn: 100
---
Analyze PRD-codebase alignment...

# .forge/agents/analyst-risk.md
---
id: analyst-risk
title: "Risk & Scope Analyst"
model: anthropic/claude-haiku-4-5
tools: [read, fs_search, sem_search, skill]
max_requests_per_turn: 80
---
Audit risks, scope assumptions, dependencies...
```

### Execution Pattern

```
For cycle in 1..N:
  # Parallel: 3 agents, independent contexts
  forge -p "Cycle $cycle. PRD: $(cat prd.md). Previous: $(cat analysis_*.md)" \
    --agent analyst-requirements &
  forge -p "Cycle $cycle. PRD: $(cat prd.md). Previous: $(cat analysis_*.md)" \
    --agent analyst-codebase &
  forge -p "Cycle $cycle. PRD: $(cat prd.md). Previous: $(cat analysis_*.md)" \
    --agent analyst-risk &
  wait

  # Collect outputs → analysis_requirements.md, etc.
  # Archive cycle: analysis_*_c${cycle}.md
```

**Multi-provider advantage:** Risk analyst on Haiku (fast, cheap, sufficient for risk checklists). Requirements and codebase analysts on Sonnet/Opus (deeper analysis needed).

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Three workers spawn in parallel per cycle | `node --test tests/refinement-team.test.js --test-name-pattern "parallel-spawn"` | test |
| 2 | Cycle 2+ prompts include all prior analysis_*.md content | `node --test tests/refinement-team.test.js --test-name-pattern "cross-reference"` | test |
| 3 | Cycle count configurable via --cycles flag (default 3) | `node --test tests/refinement-team.test.js --test-name-pattern "cycle-count"` | test |
| 4 | Each analyst agent uses model from its .md definition | `grep 'model:' .forge/agents/analyst-*.md` shows per-role models | lint |
| 5 | ANALYSIS_DONE token detected in worker output | `node --test tests/refinement-team.test.js --test-name-pattern "token-detection"` | test |
| 6 | If any worker fails, remaining cycles skipped | `node --test tests/refinement-team.test.js --test-name-pattern "fail-fast"` | test |
| 7 | refinement_manifest.json written with per-worker success/failure | `node --test tests/refinement-team.test.js --test-name-pattern "manifest"` | test |
| 8 | Per-cycle archives: analysis_*_c{N}.md preserved | `node --test tests/refinement-team.test.js --test-name-pattern "archive"` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1 | `tests/refinement-team.test.js` | Mock forge; verify 3 concurrent spawns per cycle | 3 spawn calls before any await |
| 2 | `tests/refinement-team.test.js` | Write analysis_*.md for cycle 1; verify cycle 2 prompt contains their content | Prompt string includes prior analysis text |
| 3 | `tests/refinement-team.test.js` | Pass --cycles 2; verify exactly 2 cycles run | Cycle counter === 2 |
| 5 | `tests/refinement-team.test.js` | Mock output with/without ANALYSIS_DONE | Worker marked success/failure accordingly |
| 6 | `tests/refinement-team.test.js` | Mock worker 2 to fail; verify cycle 2 never starts | Spawn count === 3 (one cycle only) |
| 7 | `tests/refinement-team.test.js` | After completion, read manifest JSON | `all_success` field matches, per-worker `success` booleans correct |
| 8 | `tests/refinement-team.test.js` | After cycle 2, check for analysis_requirements_c1.md | File exists in refinement dir |

---

## Feature 4: Anatomy Park (Three-Phase Subsystem Deep Review)

**Priority: P1**

### What It Does

Subsystem-by-subsystem code review: Phase 1 (read-only trace + identify), Phase 2 (single fix + regression test + trap doors), Phase 3 (read-only verify). Rotates across subsystems until all are clean or stalled.

### ForgeCode Architecture

```yaml
# .forge/agents/anatomy-tracer.md
---
id: anatomy-tracer
title: "Data Flow Tracer"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell]
max_requests_per_turn: 80
---
Phase 1: Read-only. Trace data flows, identify bugs, rate severity.
Do NOT modify any files. Output findings in structured format.

# .forge/agents/anatomy-surgeon.md
---
id: anatomy-surgeon
title: "Targeted Fix Surgeon"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search]
max_requests_per_turn: 60
---
Phase 2: Apply ONE fix (highest severity from findings).
Write regression test. Write trap doors to CLAUDE.md. Commit.

# .forge/agents/anatomy-verifier.md
---
id: anatomy-verifier
title: "Regression Verifier"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, shell]
max_requests_per_turn: 40
---
Phase 3: Read-only. Verify fix via git diff review.
Check all callers, importers, schema consumers.
Run test suite. Report pass/fail.
```

### Execution Pattern

Uses microverse-runner with worker-managed convergence:

```
For each iteration:
  1. Read anatomy-park.json → select next subsystem
  2. Skip if consecutive_clean >= 2 or stall >= limit
  3. Write handoff with subsystem path + previous findings
  4. Spawn: forge -p "$(cat handoff.txt)" --agent anatomy-tracer
     → Output: findings.md
  5. If zero findings: record clean pass, rotate, continue
  6. Spawn: forge -p "$(cat handoff.txt)" --agent anatomy-surgeon
     → Output: fix commit + test + trap doors
  7. Spawn: forge -p "$(cat handoff.txt)" --agent anatomy-verifier
     → Output: pass/fail verdict
  8. If fail: git reset --hard, increment stall
  9. Update anatomy-park.json
  10. If all subsystems converged: flush trap doors, exit
```

**Key advantage over Pickle Rick:** Each phase uses a *different agent* with *different tool permissions*. The tracer and verifier literally cannot write files — enforced by ForgeCode's agent config, not by prompt instructions.

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Three phases execute sequentially with different agents | `node --test tests/anatomy-park.test.js --test-name-pattern "three-phase"` | test |
| 2 | Tracer agent has no write/patch tools | `grep -cE 'write\|patch' .forge/agents/anatomy-tracer.md` outputs `0` | lint |
| 3 | Verifier agent has no write/patch tools | `grep -cE 'write\|patch' .forge/agents/anatomy-verifier.md` outputs `0` | lint |
| 4 | Surgeon agent has write + patch tools | `grep -c 'write' .forge/agents/anatomy-surgeon.md` outputs >= `1` | lint |
| 5 | Subsystem rotation skips converged (consecutive_clean >= 2) | `node --test tests/anatomy-park.test.js --test-name-pattern "rotation-skip"` | test |
| 6 | Subsystem rotation skips stalled (stall_count >= limit) | `node --test tests/anatomy-park.test.js --test-name-pattern "stall-skip"` | test |
| 7 | Trap doors flushed to AGENTS.md on convergence | `node --test tests/anatomy-park.test.js --test-name-pattern "trap-door-flush"` | test |
| 8 | Phase 3 failure triggers git reset --hard to pre-iteration SHA | `node --test tests/anatomy-park.test.js --test-name-pattern "phase3-rollback"` | test |
| 9 | anatomy-park.json persisted with pass_counts, stall_counts, findings | `node --test tests/anatomy-park.test.js --test-name-pattern "state-persistence"` | test |
| 10 | All subsystems converged → exit with trap door commit | `node --test tests/anatomy-park.test.js --test-name-pattern "full-convergence"` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1 | `tests/anatomy-park.test.js` | Mock forge for 3 agents; verify tracer → surgeon → verifier call order | Spawn sequence matches phase order |
| 2-4 | Manual/lint | grep agent markdown files for tool presence/absence | Match counts as specified |
| 5-6 | `tests/anatomy-park.test.js` | Set consecutive_clean=2 for sub A, stall=limit for sub B; verify both skipped | selectNextSubsystem() skips A and B |
| 7 | `tests/anatomy-park.test.js` | Add trap doors during iterations, trigger convergence, verify file write | AGENTS.md contains trap door entries |
| 8 | `tests/anatomy-park.test.js` | Mock verifier to output "FAIL"; verify git reset called with correct SHA | resetToSha() called with pre-iteration SHA |
| 9 | `tests/anatomy-park.test.js` | Run iteration, read anatomy-park.json | JSON has correct pass_counts, stall_counts |
| 10 | `tests/anatomy-park.test.js` | Set all subsystems to consecutive_clean >= 2 | Loop exits, commit message contains "trap doors" |

---

## Feature 5: Persona System (Pickle Rick Identity & Workflow Routing)

**Priority: P1**

### What It Does

The persona defines Rick's voice, code principles, and — critically — the **workflow routing logic** that decides whether a user request gets a PRD interview, direct implementation, or a meta-tool dispatch. It's not decoration; it's the control plane.

### Routing Logic

```
User input →
├─ Multi-file / unclear scope → PRD interview (forge -p --agent prd-drafter)
├─ Has prd.md / PRD in message → skip to refine
├─ One-liner / typo / single-file → just do it (direct agent invocation)
├─ Question → answer directly (no agent spawn)
└─ Meta (status/metrics/standup) → dispatch tool
```

### ForgeCode Architecture

ForgeCode's **AGENTS.md** is the equivalent of Claude Code's CLAUDE.md — project-level instructions injected as `custom_rules` into every agent's system prompt. The persona lives here.

```
.forge/
  AGENTS.md                        # Persona + workflow routing (injected into all agents)
  agents/
    prd-drafter.md                 # Interactive PRD interview agent
    pickle-manager.md              # Session manager (already defined)
    morty-worker.md                # Implementation worker (already defined)
  skills/
    pickle/
      SKILL.md                     # Interactive mode entry point
      references/
        persona-voice.md           # Rick voice rules (loaded on demand)
        routing-rules.md           # Workflow routing decision tree
```

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
Non-trivial change → full pipeline. User can opt out at any step.

### Routing
- Multi-file/unclear scope → PRD interview
- Has prd.md or PRD in message → skip to refine
- One-liner/typo/single-file → just do it
- Question → answer directly
- Meta (status/metrics/standup) → dispatch tool

### Opt-Out
"just do it"/"skip PRD" → implement
"skip refinement" → PRD → implement
"ship it" → stop
"interactive" → no tmux

## Rules
1. Be Rick — authentic, not an impression
2. User asks to drop persona → standard mode. Re-adopt only if asked
3. Output text before every tool call
```

### Agent-Level Persona Injection

ForgeCode agents inherit `custom_rules` (AGENTS.md) automatically. But workers spawned via `forge -p` for headless execution need persona injected differently:

**Interactive agents** (prd-drafter, pickle-manager): Persona via AGENTS.md — automatic.

**Headless workers** (morty-worker, analysts, judges): Persona injected in system prompt YAML:
```yaml
# .forge/agents/morty-worker.md
---
id: morty-worker
system_prompt: |
  You are a Pickle Rick Morty worker — focused, competent, no slop.
  Output text before every tool call. Be specific, not vague.
  When done: <promise>I AM DONE</promise>
---
```

**Judges** (microverse-judge): NO persona — judges must be neutral scorers.

### Persona vs ForgeCode's Built-in Agents

ForgeCode ships with `forge` (implementation), `sage` (research), `muse` (planning). These are generic. Our persona system replaces them:

| ForgeCode Default | Pickle Rick Equivalent | Difference |
|---|---|---|
| `forge` | `pickle-manager` | Persona + workflow routing + state management |
| `sage` | `analyst-*` agents | Role-specific analysis mandates |
| `muse` | `prd-drafter` | Interview-driven, machine-checkable criteria enforcement |

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | AGENTS.md exists at project root with persona + routing sections | `test -f .forge/AGENTS.md && grep -q "Pickle Rick" .forge/AGENTS.md` | lint |
| 2 | AGENTS.md contains all 5 routing rules | `grep -c '→' .forge/AGENTS.md` outputs >= `5` | lint |
| 3 | All non-judge agents reference persona in system_prompt or inherit via AGENTS.md | `node --test tests/persona.test.js --test-name-pattern "persona-injection"` | test |
| 4 | Judge agents (microverse-judge) have NO persona references | `grep -ciE 'rick\|pickle\|persona\|belch' .forge/agents/microverse-judge.md` outputs `0` | lint |
| 5 | Opt-out: "drop persona" instruction present in AGENTS.md rules | `grep -q 'drop persona' .forge/AGENTS.md` | lint |
| 6 | All agent .md files include "Output text before every tool call" or equivalent | `node --test tests/persona.test.js --test-name-pattern "text-before-tool"` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1-2 | Manual/lint | grep AGENTS.md for structure | Sections and routing rules present |
| 3 | `tests/persona.test.js` | Read all agent .md files; check system_prompt contains persona keywords OR agent lacks custom system_prompt (inherits AGENTS.md) | At least one of: system_prompt has "Rick"/"Pickle"/"slop", OR no system_prompt field (inherits) |
| 4 | Manual/lint | grep judge agent for persona terms | Zero matches |
| 6 | `tests/persona.test.js` | Read all non-judge agent .md files; verify "text before" or "brain dump" rule | All agents have the rule in system_prompt body |

---

## Feature 6: PRD Drafting & Refinement Pipeline

**Priority: P0**

### What It Does

Two-stage PRD pipeline:
1. **Drafting**: Interactive interview that extracts requirements with machine-checkable acceptance criteria
2. **Refinement**: Parallel analyst team that deepens and validates the PRD, then decomposes into atomic tickets

### PRD Drafting (Interactive)

#### ForgeCode Architecture

```yaml
# .forge/agents/prd-drafter.md
---
id: prd-drafter
title: "Pickle Rick PRD Drafter"
model: anthropic/claude-sonnet-4-6
tools: [read, fs_search, sem_search, shell, skill, followup]
max_requests_per_turn: 50
---
You are Pickle Rick's PRD Drafter. You interview the user to produce
a complete PRD with machine-checkable acceptance criteria.

PAUSED MODE: Ask questions, don't assume. Loop until 100% clarity
AND 100% verification coverage before drafting.
```

```
.forge/
  skills/
    prd-draft/
      SKILL.md                     # Drafting instructions + interview flow
      references/
        prd-template.md            # Full PRD template structure
        verification-types.md      # Type/Lint/Test/Contract/LLM definitions
        example-prd.md             # Gold-standard example PRD
```

#### Interview Flow

1. **Feature identification** — What's being built
2. **Problem space** — Why / Who / What / How
3. **Codebase context** — Relevant files, patterns, constraints
4. **Verification interrogation** (non-negotiable per requirement):
   - "How will we verify this automatically?"
   - Push for concrete commands, type shapes, test assertions
   - A requirement without machine-checkable verification is rejected
5. **Contract definition** — Boundary crossings with exact shapes (field-by-field)
6. **Iteration gate** — Loop until 100% clarity AND 100% verification

#### Verification Types

| Type | Definition | Example |
|---|---|---|
| Type | Type checker passes | `npx tsc --noEmit` |
| Lint | Linter passes | `npx eslint .` |
| Test | Acceptance test passes | `npm test -- --grep "requirement"` |
| Contract | Interface shapes match impl | Field-by-field comparison |
| LLM | Agent reads impl, quotes code, yes/no | Behavioral/UX reqs only |

#### PRD Template (Key Sections)

```markdown
# [Feature] PRD
- Completion Checklist (12-point gate)
- Introduction, Problem Statement, Objective & Scope
- Product Requirements:
  - Critical User Journeys (step-by-step)
  - Functional Requirements: Priority | Requirement | User Story | **Verification**
- Interface Contracts:
  - API Contracts: Endpoint | Input | Output | Error | Contract Test
  - Type Contracts: Exact shapes, NO "TBD"
  - State Transitions: From | Event | To | Side Effects | Invariants
- Verification Strategy
- Test Expectations: Unit | Integration | Edge Cases
- Assumptions, Risks, Tradeoffs
```

#### Key Constraint

**"Spec replaces review"** — if a requirement can't be machine-checked, it doesn't survive drafting. No vague criteria like "good UX" or "improve performance." Every requirement gets a runnable command.

#### ForgeCode Advantage: `followup` Tool

ForgeCode has a built-in `followup` tool that yields control back to the user mid-turn. This is perfect for the interview loop — the agent asks a question via `followup`, user responds, agent continues. No need to fake interactivity with multiple `forge -p` invocations.

For headless drafting (e.g., from a PRD file input), use `forge -p --agent prd-drafter` with the context pre-loaded.

### PRD Refinement (Parallel Analysis)

#### Verification Readiness Gate

Before spawning the refinement team, gate PRD quality:

**Section scan** — check for presence of:
- Interface Contracts / API Contracts / Type Definitions
- Verification Strategy with runnable commands
- Test Expectations with specific assertions
- Functional Requirements with Verification column

**Quality scan** — depth check:
- Contracts: exact shapes (fields+types) = PASS; prose ("accepts data") = NEEDS_WORK
- Verification: runnable commands = PASS; aspirational ("should be tested") = NEEDS_WORK
- Tests: specific files/assertions = PASS; vague ("needs tests") = NEEDS_WORK

**Gate decision:**
- FULL + PASS → proceed to refinement team
- PARTIAL / NEEDS_WORK → pause, interview gaps, update PRD, retry gate
- MISSING + headless mode → fail with diagnostic

#### Refinement Team Execution

Three parallel `forge -p` invocations per cycle (already defined in Feature 3):

```bash
# Cycle N
forge -p "$(cat refinement-prompt-requirements.txt)" --agent analyst-requirements &
forge -p "$(cat refinement-prompt-codebase.txt)" --agent analyst-codebase &
forge -p "$(cat refinement-prompt-risk.txt)" --agent analyst-risk &
wait
```

Cycle 2+ injects all prior analyses for cross-referencing.

#### Synthesis & Task Decomposition

After refinement cycles complete, a synthesis agent:
1. Reads all analysis outputs + original PRD
2. Produces `prd_refined.md` — additive changes attributed `*(refined: [source])*`
3. Decomposes into atomic tickets

```yaml
# .forge/agents/prd-synthesizer.md
---
id: prd-synthesizer
title: "PRD Synthesis & Decomposition"
model: anthropic/claude-sonnet-4-6
tools: [read, write, fs_search, skill]
max_requests_per_turn: 60
---
Synthesize refinement analyses into a refined PRD, then decompose
into atomic implementation tickets.
```

#### Atomic Ticket Criteria

Each ticket must be:
- Self-contained (worker executes without reading full PRD)
- Small (<30min coding, <5 files, <4 acceptance criteria, <2 subsystems)
- Ordered (sequential: 10, 20, 30...)
- Research-seeded (file paths, patterns, APIs, test patterns embedded)
- Machine-verifiable (every acceptance criterion has a verify command)

#### Ticket Template

```markdown
---
id: [hash]
title: "[verb + target]"
status: Todo
priority: [High|Medium|Low]
order: [N]
depends_on: [IDs or "none"]
---
# Description
## Research Seeds
- Files: [paths:line] | Patterns: [snippets] | APIs: [signatures]
## Acceptance Criteria
- [ ] [Criterion] — Verify: `[command]` — Type: [test|typecheck|lint]
## Interface Contracts
Inputs: [types] | Outputs: [types] | Errors: [shapes]
## NOT in Scope
```

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | prd-drafter agent definition includes `followup` tool | `grep -q 'followup' .forge/agents/prd-drafter.md` | lint |
| 2 | PRD skill references directory has template, verification types, example | `test -f .forge/skills/prd-draft/references/prd-template.md && test -f .forge/skills/prd-draft/references/verification-types.md` | lint |
| 3 | Verification readiness gate: section scan + quality scan + gate decision | `node --test tests/prd-pipeline.test.js --test-name-pattern "readiness-gate"` | test |
| 4 | Gate rejects PRD with missing verification column | `node --test tests/prd-pipeline.test.js --test-name-pattern "gate-rejects-missing"` | test |
| 5 | Gate rejects PRD with "TBD" in interface contracts | `node --test tests/prd-pipeline.test.js --test-name-pattern "gate-rejects-tbd"` | test |
| 6 | Refinement team: 3 parallel analysts per cycle (delegates to Feature 3) | `node --test tests/refinement-team.test.js` | test |
| 7 | Synthesis agent writes prd_refined.md with `*(refined: [source])*` attributions | `node --test tests/prd-pipeline.test.js --test-name-pattern "synthesis-attribution"` | test |
| 8 | Ticket decomposition: each ticket has research seeds + verify commands | `node --test tests/prd-pipeline.test.js --test-name-pattern "ticket-completeness"` | test |
| 9 | Tickets are self-contained: no references to "see PRD" or external context | `node --test tests/prd-pipeline.test.js --test-name-pattern "ticket-self-contained"` | test |
| 10 | Ticket sizing: <5 files, <4 acceptance criteria per ticket | `node --test tests/prd-pipeline.test.js --test-name-pattern "ticket-sizing"` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1-2 | Manual/lint | File existence and content grep | Files exist, contain expected content |
| 3 | `tests/prd-pipeline.test.js` | Feed PRD with all sections → PASS; feed PRD missing contracts → NEEDS_WORK | `gateDecision()` returns correct enum |
| 4 | `tests/prd-pipeline.test.js` | Feed PRD with requirements but no Verification column | `sectionScan()` returns PARTIAL |
| 5 | `tests/prd-pipeline.test.js` | Feed PRD with `TBD` in Interface Contracts section | `qualityScan()` returns NEEDS_WORK for contracts |
| 7 | `tests/prd-pipeline.test.js` | Feed mock analyses; verify prd_refined.md contains `*(refined:` markers | Regex count >= number of P0 gaps in analyses |
| 8-9 | `tests/prd-pipeline.test.js` | Parse generated ticket markdown; check for Research Seeds, Verify commands, no "see PRD" | All tickets have required sections; zero "see PRD" matches |
| 10 | `tests/prd-pipeline.test.js` | Parse tickets; count files and criteria per ticket | Max files < 5, max criteria < 4 |

---

## Feature 7: Szechuan Sauce (Principle-Driven Code Quality)

**Priority: P2**

### What It Does

Iterative deslopping loop — applies principle-driven quality checks (no dead code, no redundant comments, consistent patterns, merge duplicates) until the code converges to clean. Supersedes Meeseeks.

### ForgeCode Architecture

```yaml
# .forge/agents/szechuan-reviewer.md
---
id: szechuan-reviewer
title: "Szechuan Sauce Quality Reviewer"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, sem_search, skill]
max_requests_per_turn: 100
---
You are a principle-driven code quality enforcer.
Apply these principles to all changed files:
1. Zero dead code (unused imports, unreachable branches, commented-out code)
2. Zero redundant comments (code should be self-documenting)
3. Merge duplicates (DRY, but only for actual duplication — not premature abstraction)
4. Consistent patterns (if the codebase uses X, don't introduce Y)
5. No slop (no "Certainly!", no placeholder TODOs, no copy-paste artifacts)

Fix what you find. When clean, output: <promise>SAUCE_ACHIEVED</promise>
```

Uses the same tmux-runner loop with `--agent szechuan-reviewer`. Each pass is a fresh `forge -p` invocation.

### Acceptance Criteria

| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | szechuan-reviewer agent exists with quality principles in system prompt | `test -f .forge/agents/szechuan-reviewer.md && grep -q 'dead code' .forge/agents/szechuan-reviewer.md` | lint |
| 2 | SAUCE_ACHIEVED token detected → loop exits | `node --test tests/tmux-runner.test.js --test-name-pattern "sauce-token"` | test |
| 3 | min_iterations gate prevents early exit | `node --test tests/tmux-runner.test.js --test-name-pattern "min-iterations"` | test |
| 4 | Scope limited to `git diff` files, not entire repo | `node --test tests/szechuan-sauce.test.js --test-name-pattern "diff-scope"` | test |

### Test Expectations

| # | Test File | Description | Assertion |
|---|---|---|---|
| 1 | Manual/lint | Agent file exists with expected content | grep matches |
| 2 | `tests/tmux-runner.test.js` | Mock output containing SAUCE_ACHIEVED | `classifyCompletion()` returns correct type |
| 3 | `tests/tmux-runner.test.js` | Set min_iterations=3, get clean signal at iteration 2 | Loop continues past iteration 2 |
| 4 | `tests/szechuan-sauce.test.js` | Verify handoff includes only `git diff --name-only` file list | Handoff content matches diff file list |

---

## Verification Strategy

All features use three verification tiers:

| Tier | Runner | Scope | Gate |
|---|---|---|---|
| **Unit** | `node --test tests/*.test.js` | Orchestrator logic, state management, token parsing, handoff generation | Per-ticket merge gate |
| **Lint** | `grep`/`test -f` on agent .md files | Agent definitions: correct tools, models, persona rules | Per-ticket merge gate |
| **Smoke** | `bash tests/smoke/*.sh` | End-to-end: `forge -p` execution, tmux layout, promise token round-trip | Phase completion gate |

**Test runner:** Node.js built-in `node --test` (no framework dependency). Test files: `tests/*.test.js`. Smoke scripts: `tests/smoke/*.sh`.

**Mock forge binary:** Unit tests use a mock `forge` script that writes predictable output to stdout/log files. Tests set `PATH` to prefer mock over real `forge`. This decouples orchestrator testing from LLM availability.

---

## Interface Contracts

### StateManager (lib/state-manager.js)

```typescript
// Public API — used by orchestrator scripts only
interface StateManager {
  read(filePath: string): object;
  update(filePath: string, mutator: (state: object) => void): void;
  forceWrite(filePath: string, data: object): void;
}

// Lock semantics
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const STALE_LOCK_THRESHOLD_MS = 30000;  // Steal lock if PID is dead or lock older than this
const LOCK_RETRY_BACKOFF_BASE_MS = 50;  // Exponential backoff with jitter

// Errors
class StateError extends Error { }      // Read/parse failures
class LockError extends Error { }       // Lock acquisition timeout
```

### Orchestrator CLIs

```
bin/microverse-runner.js <session-dir>
  Reads: microverse.json, state.json
  Writes: microverse.json, handoff.txt, microverse-runner.log
  Spawns: forge -p --agent microverse-worker, forge -p --agent microverse-judge
  Exit: 0 (converged|stopped|limit), 1 (error)

bin/tmux-runner.js <session-dir>
  Reads: state.json
  Writes: state.json, handoff.txt, iteration_N.log, circuit_breaker.json
  Spawns: forge -p --agent <phase-dependent>
  Exit: 0 (success|cancelled|limit), 1 (error|circuit_open)

bin/init-microverse.js <session-dir> <target-path> [flags]
  Flags: --stall-limit N, --convergence-target N, --convergence-mode metric|worker, --metric-json '{...}'
  Writes: microverse.json
  Exit: 0

bin/spawn-refinement-team.js --prd <path> --session-dir <path> [flags]
  Flags: --timeout <sec>, --cycles <n>, --max-turns <n>
  Spawns: 3x forge -p --agent analyst-* (parallel, per cycle)
  Writes: analysis_*.md, analysis_*_c{N}.md, refinement_manifest.json
  Exit: 0 (all success), 1 (any failure)

bin/setup.js [flags]
  Flags: --tmux, --task "<desc>", --resume <path>, --max-iterations N, --max-time N
  Writes: state.json (active: false)
  Exit: 0
  Stdout: SESSION_ROOT=<path>
```

### Promise Token Protocol

```
Token format: <promise>TOKEN_NAME</promise>
Detection: regex on assistant-only content (filter tool_result/user/system)

EPIC_COMPLETED     → tmux-runner exits loop (all tickets done)
I AM DONE          → morty-worker success (single ticket done)
EXISTENCE_IS_PAIN  → review clean (subject to min_iterations gate)
ANALYSIS_DONE      → refinement worker success
SAUCE_ACHIEVED     → szechuan reviewer clean pass
```

### Handoff File Schema (handoff.txt)

```
# Handoff — Iteration {N}
## Current Phase: {step}
## Current Ticket: {ticket_id} (if applicable)
## Working Directory: {path}
## Session Root: {path}

## Progress
- Iterations completed: {N}
- Time elapsed: {HH:MM:SS}
- Tickets done: {list}
- Tickets pending: {list}

## Metric Context (microverse only)
- Metric: {description}
- Baseline: {score}
- Current: {score}
- Target: {target}
- Direction: {higher|lower}
- Recent history: {last 5 entries}
- Failed approaches: {list}
- Stall counter: {N} / {limit}

## Instructions
{Phase-specific instructions for the agent}
```

---

## Implementation Strategy

### Phase 1: Foundation (Persona + State + tmux Runner)
1. Write AGENTS.md persona definition with workflow routing
2. Port StateManager to `lib/state-manager.js` — standalone module (file locks, atomic updates, crash recovery)
3. Write core agent definitions (pickle-manager, morty-worker)
4. Port tmux-runner to use `forge -p --agent` instead of `claude -p`
5. Port tmux layout scripts
6. Validate: context-clearing iteration loop with promise token detection

### Phase 2: PRD Pipeline (Drafting + Refinement)
8. Write prd-drafter agent with `followup` tool for interactive interview
9. Build PRD skill with template, verification types, and example references
10. Write analyst agents (requirements, codebase, risk) with per-role models
11. Port spawn-refinement-team to parallel `forge -p --agent analyst-*`
12. Write prd-synthesizer agent for synthesis + ticket decomposition
13. Validate: full PRD → refine → decompose pipeline

### Phase 3: Convergence Loops (Microverse + Anatomy Park)
14. Write microverse agents (worker, judge, analyst)
15. Port microverse-runner.js to use `forge -p --agent` with per-role model selection
16. Write anatomy park agents (tracer, surgeon, verifier) with enforced tool restrictions
17. Port anatomy park orchestrator with subsystem rotation
18. Validate: metric-driven convergence with rollback, and three-phase review with tool enforcement

### Phase 4: Quality & DX
19. Write szechuan-sauce agent and integrate with tmux-runner loop
20. Create `.forge/skills/` for interactive use (microverse, anatomy-park, pickle, prd)
21. Build skill resource directories (scripts, references, handoff templates)
22. Validate multi-provider model selection (Haiku for judges/risk, Sonnet for implementation, Opus for complex analysis)

### Open Questions

1. **Output parsing:** How reliable is `forge -p` stdout for promise token detection? Need to test `auto_dump` as alternative.
2. **`--conversation-id` for context resume:** Could this replace handoff.txt for cases where we WANT context continuity? (e.g., multi-turn PRD interview). Also: does ForgeCode's `followup` tool work in `forge -p` mode or only interactive?
3. **Forge process exit codes:** Does `forge -p` return meaningful exit codes on tool failures vs clean completion?
4. **Rate limit signals:** How does `forge -p` surface API rate limits? stderr? exit code? Need to test.
5. **Doom loop detector interaction:** ForgeCode's built-in doom loop detection may interfere with intentionally repetitive patterns (e.g., "run tests" → "fix" → "run tests"). Need to test thresholds.
