<p align="center">
  <img src="images/architecture.png" alt="Pickle Rick Architecture" width="100%" />
</p>

# Pickle Rick Architecture — ForgeCode Edition

Deep-dive internals for the Pickle Rick engineering lifecycle on ForgeCode. For usage, commands, and quick start, see the [README](README.md).

---

## ForgeCode Primitives

Pickle Rick on ForgeCode replaces Claude Code's hook-driven architecture with external orchestration and ForgeCode-native agent definitions. Here's the mapping:

### Agent Definitions (`.forge/agents/`)

Every role in the system is a YAML-frontmatter Markdown file in `.forge/agents/`. Each agent specifies:

- **`id`** — unique identifier used with `forge -p --agent <id>`
- **`model`** — provider/model string (e.g., `anthropic/claude-sonnet-4-6`, `anthropic/claude-haiku-4-5`). Multi-provider is the killer feature — gap analysis on cheap models, implementation on expensive ones, LLM judges on fast ones
- **`tools`** — allowlist of available tools. **Hard-enforced**: ForgeCode's `validate_tool_call()` blocks disallowed tools at execution time, and the LLM never even receives tool definitions it can't use. This means read-only agents (anatomy-tracer, anatomy-verifier, microverse-judge) are *genuinely* read-only — not just instructed to be
- **`max_requests_per_turn`** — native request cap per invocation
- **`compact`** — optional token threshold and retention window for context management
- **`system_prompt`** — the body of the Markdown file after the YAML frontmatter

```yaml
# Example: .forge/agents/microverse-worker.md
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
```

### Skills (`.forge/skills/`)

Skills replace Claude Code's slash command templates. Each skill is a directory:

```
.forge/skills/microverse/
├── SKILL.md              # Instructions (progressive disclosure — metadata always loaded, body on-demand)
├── scripts/
│   └── measure-metric.sh # Bundled tooling
└── references/
    └── handoff-format.md # Context documents
```

Progressive disclosure means ForgeCode loads skill metadata into every conversation but only injects the full body when the skill is invoked. This saves tokens compared to the old "every command template in context" approach.

### Tool Restriction Enforcement

ForgeCode enforces tool restrictions at two layers:

1. **Definition filtering** — The LLM never receives tool definitions it can't use. If an agent's `tools` list says `[read, fs_search, shell]`, the model literally doesn't know `write` or `patch` exist
2. **Execution gating** — `validate_tool_call()` blocks any fabricated tool calls at runtime, even if the model hallucinates a tool name

This is identical in `-p` (headless) and interactive mode. Verified via source dive of `forge_app/src/tool_registry.rs:306-321`.

### `auto_dump` Conversation JSON

ForgeCode's `auto_dump = "json"` in `forge.toml` writes a full conversation dump after each `forge -p` invocation. The JSON structure has absolute role discrimination:

- **Assistant messages**: `{"text": {"role": "Assistant", "content": "..."}}`
- **Tool results**: `{"tool": {"name": "...", "output": {...}}}` — entirely separate JSON key
- **User/System messages**: `{"text": {"role": "User|System", ...}}`

This is how promise tokens are detected without false positives. Tool results (which might contain `<promise>` strings from files the agent read) use the `"tool"` key, never the `"text"` key. Structural discrimination is absolute.

### `--cid` Conversation Resume

`forge -p --cid <conversation-id>` resumes a prior conversation with full history preserved. This replaces Claude Code's `followup` tool (which silently drops in headless mode) for multi-turn interactions like PRD interviews:

1. `forge -p "Start PRD for X" --cid $CID` — agent asks questions, exits
2. Orchestrator collects user answers
3. `forge -p "Answers: $ANSWERS" --cid $CID` — resumes with full context
4. Repeat until PRD is written

### AGENTS.md (Persona + Custom Rules)

`.forge/AGENTS.md` is the equivalent of Claude Code's `CLAUDE.md` — injected into all interactive agents as `custom_rules`. Contains the Pickle Rick persona, workflow routing, and code principles. Headless workers get a lightweight persona in their YAML `system_prompt`. Judge agents get NO persona (pure scoring).

---

## External Orchestration Model

ForgeCode has no user-configurable hooks. Where Claude Code used `dispatch.js` → `stop-hook.js` to intercept agent exits and force continuation, ForgeCode uses **external orchestration**: Node.js scripts that spawn `forge -p` subprocesses, measure results, and decide whether to continue.

```
┌─────────────────────────────────────────────────────┐
│  Orchestrator (Node.js, runs in tmux)               │
│                                                     │
│  1. Read state from state.json / microverse.json    │
│  2. Write handoff.txt (context for next iteration)  │
│  3. Spawn: forge -p --agent <id>                    │
│     → Fresh context per invocation                  │
│     → Wall-clock timeout with SIGTERM/SIGKILL       │
│  4. Parse auto_dump JSON for promise tokens         │
│  5. Measure metric / check git delta                │
│  6. Update state, decide: continue or stop          │
│  7. If continue → goto 1                            │
└─────────────────────────────────────────────────────┘
```

Key orchestrators:
- **`bin/tmux-runner.js`** — Full lifecycle loop (PRD → breakdown → implement → review)
- **`bin/microverse-runner.js`** — Metric convergence loop (gap analysis → iterate → converge)
- **`bin/spawn-refinement-team.js`** — Parallel analyst spawner (3 workers per cycle)

All orchestrators use `lib/state-manager.js` directly for atomic file-locked state management.

---

## State Management (`lib/state-manager.js`)

Direct library usage — no hook dispatch layer. The StateManager provides:

```typescript
interface StateManager {
  read(filePath: string): State;
  update(filePath: string, mutator: (state: State) => void): State;
  transaction(paths: string[], mutator: (states: State[]) => void): State[];
  forceWrite(filePath: string, state: State | object): void;  // No lock, never throws — signal handlers only
}
```

**Recovery protocols** (automatic on every `read()`):
1. **Orphan `.tmp` promotion** — if a crash left a `.tmp` file with a higher iteration count, it's promoted to the real file
2. **Stale active flag** — if `state.active=true` but `state.pid` is dead, clears the flag
3. **Schema migration** — adds `schema_version` if missing, rejects future versions

Lock semantics: 5s acquire timeout, 30s stale lock threshold, exponential backoff with jitter.

---

## Circuit Breaker — Runaway Session Protection (`lib/circuit-breaker.js`)

> *"You know what's worse than a bug, Morty? An infinite loop that keeps making the same bug. Over and over. Burning tokens like Jerry burns goodwill."*

Long-running autonomous sessions can get stuck — same error repeating, no git progress, the model spinning its wheels. The circuit breaker detects these failure modes and stops the session before it wastes hours.

### How It Works

The circuit breaker is a three-state machine integrated into the orchestrator loops. After every iteration, it checks two signals:

**Progress detection** — Five signals checked: (1) uncommitted changes via `git diff --stat`, (2) staged changes via `git diff --stat --cached`, (3) HEAD SHA changed, (4) lifecycle step changed, (5) current ticket changed. If any changed, the iteration made progress. First-iteration warm-up always counts as progress.

**Error signature extraction** — Parses the iteration's `auto_dump` JSON output for error indicators. Normalizes error text: paths → `<PATH>`, line:column → `<N>:<N>`, timestamps → `<TS>`, UUIDs → `<UUID>`, whitespace collapsed, truncated to 200 chars. Two iterations hitting the same normalized signature count as the same error.

### State Transitions

```
                     progress detected
            ┌────────────────────────────────────┐
            │                                    │
            ▼                                    │
        ┌────────┐  no progress ≥ 2  ┌───────────┐  no progress ≥ 5  ┌────────┐
        │ CLOSED │ ──────────────►  │ HALF_OPEN │ ──────────────►  │  OPEN  │
        │(normal)│                   │ (warning) │                   │ (stop) │
        └────────┘                   └───────────┘                   └────────┘
            ▲                                │                           │
            │         progress detected      │                           │
            └────────────────────────────────┘                           │
                                                                         ▼
                                                              Session terminated
                                                              reason logged
```

- **CLOSED** (normal): Every iteration with progress resets the counter.
- **HALF_OPEN** (warning): After `halfOpenAfter` (default: 2) consecutive no-progress iterations. One more progress iteration → back to CLOSED.
- **OPEN** (stop): After `noProgressThreshold` (default: 5) consecutive no-progress iterations, OR `sameErrorThreshold` (default: 5) consecutive identical error signatures. Session terminates with a diagnostic message.

If `circuit_breaker.json` is corrupt, the system fails open (treats as CLOSED) — never blocks a session due to its own state corruption.

---

## Token Detection via `auto_dump` Role Filtering

> *"Oh, you want me to parse my own brain? Fine. But I'm only reading the parts where I was actually talking, not where I was reading some Jerry's code."*

Promise tokens (`<promise>EPIC_COMPLETED</promise>`, `<promise>I AM DONE</promise>`, etc.) signal completion. The challenge: agents read files that might contain these strings. The solution: structural role filtering.

### How It Works

1. Set `auto_dump = "json"` in `forge.toml`
2. After each `forge -p` exits, parse the `{timestamp}-dump.json`
3. Filter `conversation.context.messages[]` to entries with `text.role === "Assistant"`
4. Match `<promise>TOKEN</promise>` only in filtered assistant content
5. Tool results use the `"tool"` JSON key — structurally impossible to confuse with assistant text

**False-positive risk: ZERO.** An agent reading a file containing `<promise>EPIC_COMPLETED</promise>` produces a `{"tool": {...}}` entry, not a `{"text": {"role": "Assistant", ...}}` entry. Verified via source dive of `forge_domain/src/context.rs:41-45`.

### Promise Token Protocol

```
Tokens used by tmux-runner managed agents:
  EPIC_COMPLETED     → all tickets done, exit loop
  I AM DONE          → single morty-worker finished
  EXISTENCE_IS_PAIN  → review clean (subject to min_iterations)
  ANALYSIS_DONE      → refinement worker finished

NOT used (convergence is metric/file driven):
  Szechuan Sauce     → LLM judge score via microverse-runner
  Anatomy Park       → worker writes convergence to anatomy-park.json
```

---

## Rate Limit Handling

> *"Oh, you thought we'd just... stop? Because some API said 'too many requests'? Morty, I once escaped a galactic prison using a AAA battery and spite."*

ForgeCode handles rate limit retries internally with backoff. The orchestrator's job is simpler than Claude Code's:

1. **Detection** — Rate limits appear as `ERROR` lines in stderr containing `429 Too Many Requests`. ForgeCode always exits 0 (even on rate limit), so exit codes are useless for error detection
2. **Internal retry** — ForgeCode retries with built-in backoff before surfacing the error
3. **Orchestrator wall-clock timeout** — If a `forge -p` invocation hangs due to sustained rate limiting, the orchestrator's `worker_timeout_seconds` (SIGTERM) and hang guard (`MAX_ITERATION_SECONDS` = 4h) catch it
4. **Consecutive limit** — After configurable consecutive rate-limited iterations without progress, the runner exits with `rate_limit_exhausted`

### ForgeCode vs Claude Code Differences

| Aspect | Claude Code | ForgeCode |
|--------|-------------|-----------|
| Rate limit signal | Exit code 2 + NDJSON event | stderr `429` pattern (exit always 0) |
| Retry behavior | External (orchestrator waits) | Internal (ForgeCode retries with backoff) |
| Reset time info | Structured `resets_at_epoch` | Not available — wall-clock timeout only |
| Wait file | `rate_limit_wait.json` with countdown | Not needed — ForgeCode handles retry |

---

## Microverse Internals

<p align="center">
  <img src="images/microverse.png" alt="Microverse" width="80%" />
</p>

The Microverse convergence loop optimizes a numeric metric through iterative, atomic changes. It runs as `bin/microverse-runner.js` — a Node.js orchestrator that spawns fresh `forge -p` invocations per iteration with metric measurement, automatic rollback, and convergence detection.

### Three Sub-Modes

- **Metric-Driven** (default) — measure baseline, improve, verify, compare, rollback regressions
- **Anatomy Park** — three-phase subsystem review (trace → fix → verify) with rotation across subsystems
- **Szechuan Sauce** — principle-driven quality convergence with LLM judge scoring

All three use the same `microverse-runner.js` orchestrator with different agent configurations and `convergence_mode` settings.

### State Machine

```
                    ┌──────────────┐
                    │ gap_analysis │  Initial state — first iteration
                    └──────┬───────┘  runs gap analysis, measures baseline
                           │
                           ▼
                    ┌──────────────┐
              ┌────►│  iterating   │◄────┐
              │     └──────┬───────┘     │
              │            │             │
              │     measure metric       │ score improved
              │            │             │ or held
              │     ┌──────┴──────┐      │
              │     │ regressed?  │──No──┘
              │     └──────┬──────┘
              │            │ Yes
              │     git stash + git reset --hard <pre-SHA> + git clean -fd
              │     add to failed_approaches
              │     increment stall_counter
              │            │
              │     ┌──────┴──────┐
              │     │ converged?  │──No──┘
              │     └──────┬──────┘
              │            │ Yes
              │            ▼
              │     ┌──────────────┐
              │     │  converged   │  stall_counter ≥ stall_limit
              │     └──────────────┘  OR convergence_target met
              │
              │     ┌──────────────┐
              └────►│   stopped    │  external cancel, time/iteration limit,
                    └──────────────┘  error, or rate limit exhaustion
```

### Metric Comparison

Three outcomes per iteration, controlled by the `tolerance` parameter:

| Outcome | Condition | Effect |
|---------|-----------|--------|
| **Improved** | `score > previous + tolerance` | Accept commit, reset `stall_counter` to 0 |
| **Held** | `abs(score - previous) ≤ tolerance` | Accept commit, increment `stall_counter` |
| **Regressed** | `score < previous - tolerance` | `git stash` → `git reset --hard` → `git clean -fd` to pre-iteration SHA, add to `failed_approaches`, increment `stall_counter` |

### Metric Types

| Type | How measured | Agent |
|------|-------------|-------|
| `command` | Run shell script, parse last stdout line as float | N/A (shell exec) |
| `llm` | Spawn `forge -p --agent microverse-judge` — outputs a single number | microverse-judge (read-only, fast model) |
| `none` | Skip (worker-managed convergence via convergence_file) | N/A |

### Anatomy Park Sub-Mode

<p align="center">
  <img src="images/anatomy-park.jpeg" alt="Anatomy Park" width="60%" />
</p>

Three-phase subsystem review with enforced read-only phases:

1. **Tracer** (`forge -p --agent anatomy-tracer`) — read-only, traces data flows, identifies bugs, rates severity. Tools: `[read, fs_search, sem_search, shell]` — NO write/patch
2. **Surgeon** (`forge -p --agent anatomy-surgeon`) — applies ONE fix, writes regression test, records trap doors. Tools: `[read, write, patch, shell, fs_search]`
3. **Verifier** (`forge -p --agent anatomy-verifier`) — read-only, verifies fix via git diff review + test run. Tools: `[read, fs_search, shell]` — NO write/patch. Outputs PASS or FAIL

Subsystem auto-discovery: immediate subdirs with 3+ source files (excluding node_modules/dist). Rotation skips converged subsystems (`consecutive_clean >= 2`) and stalled ones (`stall_count >= limit`). When all subsystems converge, trap doors are flushed and the loop exits.

### Szechuan Sauce Sub-Mode

<p align="center">
  <img src="images/szechwan-sauce.jpeg" alt="Szechuan Sauce" width="60%" />
</p>

Principle-driven quality convergence:
- Worker applies quality fixes (zero dead code, zero redundant comments, merge duplicates, consistent patterns, no slop)
- LLM judge re-scores violation count after each pass
- Scope limited to `git diff` files against session start SHA
- Worker does NOT output promise tokens — convergence is purely metric-driven
- When judge scores 0 violations, microverse-runner exits via `convergence_target`

### microverse.json Schema

```json
{
  "status": "iterating",
  "prd_path": "/path/to/session/prd.md",
  "key_metric": {
    "description": "increase test coverage",
    "validation": "npm test 2>&1 | tail -1",
    "type": "command",
    "timeout_seconds": 60,
    "tolerance": 0
  },
  "convergence": {
    "stall_limit": 5,
    "stall_counter": 2,
    "history": [
      {
        "iteration": 1,
        "metric_value": "78.4",
        "score": 78.4,
        "action": "accept",
        "description": "improved: 78.4 vs 72.0",
        "pre_iteration_sha": "abc1234",
        "timestamp": "2026-03-10T05:00:00Z"
      }
    ]
  },
  "gap_analysis_path": "/path/to/session/gap_analysis.md",
  "failed_approaches": [
    "Iteration 3: score dropped from 78.4 to 71.2"
  ],
  "baseline_score": 72.0,
  "exit_reason": null
}
```

### Orchestrator Loop

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
│  8. If regressed: git stash → git reset --hard <pre-SHA> │
│     → git clean -fd. Record in failed_approaches         │
│  9. Update microverse.json atomically (history, stalls)  │
│ 10. If converged: exit. Else: goto 1                     │
│                                                          │
│  CONVERGENCE: stall_counter >= stall_limit               │
│    OR convergence_target met                             │
│    OR worker-managed: convergence_file has converged=true │
└──────────────────────────────────────────────────────────┘
```

### Session Artifacts

```
sessions/<date-hash>/
├── microverse.json           # Microverse state (source of truth)
├── gap_analysis.md           # Initial codebase analysis
├── prd.md                    # Optimization PRD
├── handoff.txt               # Per-iteration context (overwritten each iteration)
├── microverse-runner.log     # Runner log
├── iteration_N.log           # Per-iteration output
├── state.json                # Standard session state
├── circuit_breaker.json      # Circuit breaker state
└── memory/
    └── microverse_report_*.md  # Final report
```

---

## Context Clearing

The single biggest advantage of the Rick loop over naive "just keep prompting" approaches is **context clearing between iterations**.

Long-running AI sessions accumulate stale conversational context. The model starts "remembering" earlier wrong turns, half-finished reasoning, and superseded plans — all of it silently influencing every subsequent response. Over enough iterations, the model loses track of what phase it's in, tries to restart from scratch, or hallucinates already-completed work.

**The solution**: each iteration spawns a genuinely fresh `forge -p` subprocess. The orchestrator builds a full structured handoff summary — phase, ticket list, task — and injects it via `handoff.txt` before each iteration starts:

```markdown
# Handoff — Iteration 4
## Current Phase: implement
## Current Ticket: PROJ-42
## Working Directory: /path/to/project
## Session Root: /path/to/session

## Progress
- Iterations completed: 3
- Time elapsed: 00:42:15
- Tickets done: [x] PROJ-40, [x] PROJ-41
- Tickets pending: [~] PROJ-42, [ ] PROJ-43

## Next Action
Resume from current phase. Read state.json for full context.
Do NOT restart from PRD. Continue where you left off.
```

No matter how much context gets evicted, the agent always wakes up knowing exactly where it is and what to do next.

Workers already get clean context naturally — each is a fresh `forge -p` subprocess with the full lifecycle template from its agent definition.

---

## Manager / Worker Model

- **Rick (Manager)**: The `pickle-manager` agent runs in your interactive ForgeCode session or as the tmux-runner's primary agent. Handles PRD, breakdown, orchestration
- **Morty (Worker)**: Spawned as `forge -p --agent morty-worker` subprocess per ticket. Gets the full implementation lifecycle prompt from `morty-worker.md`. Workers are scope-bounded: they complete their assigned ticket, signal completion via `<promise>I AM DONE</promise>`, and are forbidden from modifying state files

### Parallel Worker Isolation

When spawning multiple Morty workers in parallel, each operates in a **git worktree** (`git worktree add`). This prevents concurrent modifications to the same working tree. After all workers complete, the orchestrator cherry-picks commits from worktrees back to main.

---

## Refinement Team

Three parallel analyst agents examine a PRD from orthogonal perspectives:

- **Requirements Analyst** (`analyst-requirements`) — CUJs, functional requirements, acceptance criteria, edge cases
- **Codebase Analyst** (`analyst-codebase`) — PRD-codebase alignment, assumptions, integration points. Uses `file:line` references for every claim
- **Risk & Scope Analyst** (`analyst-risk`) — risks, scope, assumptions, dependencies. Runs on a cheaper model (Haiku)

Multi-cycle deepening: cycle 2+ prompts include all prior analyses for cross-referencing. Early exit when zero P0/P1 findings in a cycle. Requirements analyst failure is critical (halts refinement); risk analyst failure is non-critical (warns, continues).

---

## PRD Pipeline

### Interview (Feature 4a)

Uses `--cid` multi-turn chaining — NOT the `followup` tool (which silently drops in `-p` mode). The `prd-drafter` agent has `max_requests_per_turn: 20` to ensure it asks questions and stops rather than running away with assumptions.

### Readiness Gate (Feature 4b)

Stateless, idempotent function that evaluates PRD quality before refinement:
- **Section scan** → FULL / PARTIAL / MISSING
- **Quality scan** → PASS / NEEDS_WORK
- **Gate** → proceed / interview / fail

### Synthesis (Feature 4c)

The `prd-synthesizer` agent combines refinement analyses into `prd_refined.md` and decomposes into atomic tickets with research seeds and verify commands. Resumable — can re-run synthesis without re-running refinement (analyses persist in session dir).

---

## Git Safety Invariants

1. **Pre-iteration clean state**: Before recording pre-SHA, verify `git status --porcelain` is empty. If dirty: auto-commit with `git add -u` + `git commit`. If auto-commit fails: abort iteration
2. **Single-writer guarantee**: During microverse, anatomy park, and szechuan sauce, only ONE `forge -p` modifies the working tree at a time
3. **Parallel worker isolation**: Morty workers operate in git worktrees. Commits cherry-picked to main by orchestrator
4. **Stash-before-reset**: Before `git reset --hard`, run `git stash` and record `stash_ref`. If rollback reversed, `git stash pop` recovers
5. **Reset includes clean**: `git reset --hard <SHA>` followed by `git clean -fd`

---

## Worker Timeout Protocol

| Parameter | Default | Source | Description |
|---|---|---|---|
| `worker_timeout_seconds` | 1200 (20 min) | state.json | Soft timeout: SIGTERM to child |
| SIGKILL escalation | +2s after SIGTERM | hardcoded | Kill if SIGTERM ignored |
| `MAX_ITERATION_SECONDS` | 14400 (4 hrs) | constant | Absolute ceiling, even when soft timeout disabled |
| `max_requests_per_turn` | per agent YAML | .forge/agents/*.md | ForgeCode-native request cap (complementary) |
| Hang guard | timeout + 30s | hardcoded | Force-resolve if process hangs after kill |

---

## Project Mayhem Internals

<p align="center">
  <img src="images/project-mayhem.png" alt="Project Mayhem" width="60%" />
</p>

Every module follows the same **Chaos Cycle**: read original → apply one mutation → run tests → record result → `git checkout` revert → verify revert. One mutation at a time, always reverted, always verified.

**Module 1 — Mutation Testing**: Finds high-value mutation sites in your source code (conditionals, comparisons, boolean literals, guard clauses, error handlers) and applies operators like boolean flip, comparison inversion, boundary shift, operator swap, condition negation, guard removal, and empty catch. If tests still pass after a mutation (a "survivor"), that's a test coverage gap. Survivors are severity-rated: Critical (auth/security/validation), High (business logic), Medium (utilities), Low (display/logging).

**Module 2 — Dependency Armageddon**: Selects 5-10 key direct dependencies — prioritizing the most imported, foundational, and security-sensitive — and downgrades each to the previous major version one at a time. Tracks install failures, test breakages, and backward-compatible deps. Also runs a phantom dependency check to find imports that work by accident via transitive dependencies.

**Module 3 — Config Resilience**: Discovers runtime config files (JSON, YAML, .env, INI — excluding build tooling), then applies corruption strategies: truncation (50%), empty file, missing keys, wrong types, prototype pollution payloads (`__proto__`), and invalid syntax. Tests whether the app handles each corruption gracefully or crashes.

### Safety Guarantees

- Requires clean git state — refuses to run with uncommitted changes
- Records `HEAD` SHA before starting, verifies it hasn't changed at the end
- Every individual mutation is reverted immediately via `git checkout -- <file>`
- Dependency downgrades restore the original lockfile + re-install after each test
- Final verification: `git diff` must be empty, tests must pass

---

## Portal Gun Internals

<p align="center">
  <img src="images/portal-gun.png" alt="Portal Gun" width="60%" />
</p>

1. **Open Portal** — Fetches the donor code (GitHub API, local copy, npm registry, or synthesizes from description). Saves to `portal/donor/`
2. **Pattern Extraction** — Analyzes the donor: structural pattern, invariants, edge cases, anti-patterns → `pattern_analysis.md`
3. **Target Analysis** — Studies your codebase: conventions, integration points, conflicts → `target_analysis.md`
4. **PRD Synthesis** — Generates a transplant PRD with a Behavioral Validation Tests table
5. **Refinement Cycle** — Three parallel analysts validate the transplant PRD
6. **Pattern Library** — Saves extracted patterns for reuse in future sessions
7. **Handoff** — Resume with the tmux runner or use `--run` to auto-launch

---

## Directory Structure

```
pickle-rick-forgecode/
├── .forge/
│   ├── AGENTS.md               # Persona + routing (injected into all agents)
│   ├── agents/                 # Agent definitions (YAML frontmatter + system prompt)
│   │   ├── pickle-manager.md       # Session manager (full lifecycle)
│   │   ├── morty-worker.md         # Ticket implementation worker
│   │   ├── microverse-worker.md    # Microverse implementation agent
│   │   ├── microverse-judge.md     # Metric scoring (read-only, fast model)
│   │   ├── microverse-analyst.md   # Gap analysis agent
│   │   ├── anatomy-tracer.md       # Phase 1: read-only data flow tracer
│   │   ├── anatomy-surgeon.md      # Phase 2: targeted fix applicator
│   │   ├── anatomy-verifier.md     # Phase 3: read-only regression verifier
│   │   ├── szechuan-reviewer.md    # Quality principle enforcer
│   │   ├── analyst-requirements.md # PRD requirements analyst
│   │   ├── analyst-codebase.md     # PRD codebase analyst
│   │   ├── analyst-risk.md         # PRD risk/scope analyst
│   │   ├── prd-drafter.md          # Interactive PRD interview
│   │   └── prd-synthesizer.md      # Refinement synthesis + decomposition
│   └── skills/                 # Skill bundles (progressive disclosure)
│       ├── microverse/
│       │   ├── SKILL.md
│       │   ├── scripts/
│       │   └── references/
│       ├── prd-draft/
│       │   ├── SKILL.md
│       │   └── references/
│       └── pickle/
│           ├── SKILL.md
│           └── references/
├── bin/                        # Orchestrator scripts
│   ├── setup.js                    # Session initializer
│   ├── tmux-runner.js              # Full lifecycle context-clearing loop
│   ├── microverse-runner.js        # Metric convergence loop
│   ├── init-microverse.js          # Microverse session setup CLI
│   └── spawn-refinement-team.js    # Parallel analyst spawner
├── lib/                        # Shared libraries
│   ├── state-manager.js            # Atomic file-locked state management
│   ├── circuit-breaker.js          # Three-state FSM progress tracking
│   ├── token-parser.js             # Promise token detection (auto_dump role filtering)
│   ├── git-utils.js                # SHA tracking, rollback, worktree management
│   └── handoff.js                  # Handoff file generation
├── tests/                      # Test suite (node --test)
│   ├── state-manager.test.js
│   ├── circuit-breaker.test.js
│   ├── token-parser.test.js
│   ├── microverse-runner.test.js
│   ├── tmux-runner.test.js
│   ├── refinement-team.test.js
│   ├── anatomy-park.test.js
│   ├── prd-pipeline.test.js
│   ├── persona.test.js
│   └── smoke/                      # Smoke tests
│       ├── platform-verification.sh
│       ├── forge-p-context-clear.sh
│       ├── forge-p-agent-select.sh
│       └── tmux-layout.sh
├── images/
│   ├── architecture.png
│   ├── tmux-monitor.png
│   ├── portal-gun.png
│   ├── microverse.png
│   ├── anatomy-park.jpeg
│   ├── szechwan-sauce.jpeg
│   ├── project-mayhem.png
│   └── rick-roadmap.png
├── sessions/                   # Runtime session directories
├── pickle_settings.json        # Default limits
├── install.sh                  # Installer
└── forge.toml                  # ForgeCode configuration (auto_dump = "json")
```

---

## Memory & State

Rick remembers. Not just within a session — across sessions, across conversations, across dimensions. Two memory systems work together so Rick always knows where he's been, what he's doing, and what went wrong last time.

### Session State (`state.json`)

Every session creates a directory under `sessions/<date-hash>/` with a `state.json` that tracks live execution state:

```json
{
  "active": true,
  "pid": 12345,
  "working_dir": "/path/to/project",
  "step": "implement",
  "iteration": 7,
  "max_iterations": 500,
  "max_time_minutes": 720,
  "worker_timeout_seconds": 1200,
  "start_time_epoch": 1772287760,
  "current_ticket": "feat-03",
  "tmux_mode": true,
  "history": []
}
```

The orchestrator reads `state.json` between iterations to build the handoff summary.

### Session Logs & Artifacts

```
sessions/2026-04-05-a1b2c3d4/
├── state.json                          # Live state
├── circuit_breaker.json                # Circuit breaker state
├── microverse.json                     # Microverse state (if microverse session)
├── prd.md                              # The PRD for this epic
├── handoff.txt                         # Per-iteration context (overwritten each iteration)
├── microverse-runner.log               # Orchestrator log (microverse mode)
├── tmux-runner.log                     # Orchestrator log (lifecycle mode)
├── iteration_1.log                     # Per-iteration output
├── iteration_2.log
├── feat-01/
│   ├── research_feat-01.md             # Research phase output
│   ├── plan_feat-01.md                 # Implementation plan
│   └── worker_session_12345.log        # Morty worker output
├── feat-02/
│   └── ...
└── refinement/                         # PRD refinement worker logs
    ├── analysis_requirements_c1.md
    ├── analysis_codebase_c1.md
    └── analysis_risk_c1.md
```

### How the Systems Connect

```
AGENTS.md (persona + routing)        pickle_settings.json (defaults)
   │ loaded every conversation            │ read at session setup
   │                                      │
   ▼                                      ▼
┌──────────────────────────────────────────────┐
│              Active Session                   │
│  state.json ◄──► orchestrator (tmux/micro)   │
│       │                                       │
│       ├── iteration_N.log (per-iteration)     │
│       ├── auto_dump JSON (token detection)    │
│       ├── circuit_breaker.json (FSM state)    │
│       ├── ticket/worker_*.log (Morty output)  │
│       ├── ticket/research_*.md (artifacts)    │
│       └── refinement/*.md (analyst output)    │
└──────────────────────────────────────────────┘
```

When a session ends, its directory persists — you can review any past session's state, logs, and artifacts.

---

## GitNexus Integration

Pickle Rick integrates with [GitNexus](https://gitnexus.dev), an MCP-powered code knowledge graph that indexes your codebase into symbols, relationships, and execution flows. Once indexed, every agent automatically inherits GitNexus awareness.

- **Explore architecture** — trace execution flows, understand how modules connect
- **Impact analysis** — before changing shared code, see the blast radius
- **Safe refactoring** — multi-file coordinated renames using graph + text search
- **Bug tracing** — follow call chains from symptom to root cause

### Setup

```bash
npx gitnexus analyze   # Index the current repo
npx gitnexus status    # Verify the index
```

GitNexus runs as an MCP server. ForgeCode agents with the appropriate tools get GitNexus access automatically when the MCP server is configured.
