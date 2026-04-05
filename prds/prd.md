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
| `StateManager` (file locks, transactions) | None built-in | Port as standalone Node.js/Rust library, or as MCP server |
| Promise tokens (`<promise>X</promise>`) | No output classification | Parse `forge -p` stdout or `auto_dump` conversation file for tokens |
| `--dangerously-skip-permissions` | Agent-level tool restrictions in YAML | Better — explicit tool allowlists per agent role |
| `--add-dir` (context directories) | No equivalent flag | Include paths in prompt or use skill resources |
| `--max-turns` | `max_requests_per_turn` per agent | Equivalent — configured in agent YAML |
| tmux session management | External (same as Pickle Rick) | tmux orchestration lives outside both tools |

### Key Architectural Decisions

1. **Orchestration stays external.** ForgeCode has no workflow engine. The tmux-runner, microverse-runner, and refinement coordinator remain Node.js (or Rust) scripts that shell out to `forge -p`.

2. **Agent definitions replace prompt engineering.** Instead of injecting role instructions into a single `claude -p` prompt, define `.forge/agents/` with explicit tool restrictions, models, and system prompts.

3. **Skills replace command templates.** `.forge/skills/*/` directories bundle instructions + scripts + references. Progressive disclosure (metadata always loaded, body on-demand) saves tokens.

4. **MCP server for state management.** Expose StateManager as an MCP tool server so agents can read/update session state without file path conventions in prompts.

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
    mcp-servers/
      state-server/               # MCP server exposing session state as tools
        index.js
```

### Agent Definitions

```yaml
# .forge/agents/microverse-worker.md
---
id: microverse-worker
title: "Microverse Implementation Worker"
model: anthropic/claude-sonnet-4-6
tools: [read, write, patch, shell, fs_search, skill, mcp_state_*]
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
3. **MCP state server** — Worker writes results to state via MCP tool call. Orchestrator reads state file directly.

**Recommendation:** Use option 3 (MCP state server) for structured data, stdout for human-readable progress.

### Acceptance Criteria

- [ ] `forge -p --agent microverse-worker` executes with fresh context per iteration
- [ ] `forge -p --agent microverse-judge` scores with read-only tool restrictions
- [ ] Orchestrator loop: measure → improve → verify → compare → rollback/keep
- [ ] Git-based rollback on regression (`git reset --hard`)
- [ ] Stall detection with configurable stall_limit
- [ ] Convergence target early-exit
- [ ] Failed approach tracking (circular buffer, max 100)
- [ ] Handoff.txt written between iterations with metric history
- [ ] tmux layout with orchestrator + log tail + metric watch
- [ ] Rate-limit detection and configurable backoff
- [ ] Signal handling (SIGTERM/SIGINT) with clean state persistence
- [ ] Worker-managed convergence mode (convergence.json polling)
- [ ] LLM judge mode with separate agent/model for scoring

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
tools: [read, write, patch, shell, fs_search, sem_search, skill, mcp_state_*]
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

- [ ] Context-clearing: each iteration is a fresh `forge -p` invocation
- [ ] Phase-aware agent selection (manager vs worker vs reviewer)
- [ ] Promise token detection in stdout/log files
- [ ] State.json atomic updates between iterations
- [ ] Handoff.txt context bridging
- [ ] Rate-limit detection and configurable backoff
- [ ] Circuit breaker (consecutive no-progress detection)
- [ ] Parallel ticket workers via concurrent `forge -p` spawns
- [ ] tmux layout: orchestrator + log stream + state watch
- [ ] Signal handling with clean shutdown
- [ ] Max iteration and wall-clock time gates

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

- [ ] Three parallel `forge -p --agent analyst-*` invocations per cycle
- [ ] Cross-reference injection: cycle N reads cycle N-1 analyses
- [ ] Configurable cycle count (default 3)
- [ ] Per-role model selection via agent definitions
- [ ] `ANALYSIS_DONE` token detection per worker
- [ ] Fail-fast: if any worker fails, skip remaining cycles
- [ ] Manifest output (refinement_manifest.json)
- [ ] Archive per-cycle analysis files

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

- [ ] Three-phase execution with separate agents per phase
- [ ] Read-only enforcement via agent tool restrictions (tracer, verifier)
- [ ] Write enforcement via agent tool restrictions (surgeon)
- [ ] Subsystem rotation with convergence tracking
- [ ] consecutive_clean counter (2 clean passes = done)
- [ ] stall_count with configurable limit
- [ ] Trap door cataloging and convergence flush
- [ ] Git-based rollback on Phase 3 failure
- [ ] anatomy-park.json state persistence

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

- [ ] AGENTS.md with full persona definition deployed to project root
- [ ] Workflow routing logic documented and testable
- [ ] Interactive agents inherit persona via AGENTS.md `custom_rules`
- [ ] Headless workers get persona via agent system_prompt
- [ ] Judges explicitly excluded from persona injection
- [ ] Opt-out mechanics functional ("drop persona" → neutral mode)
- [ ] "Text before every tool call" rule enforced in all agent definitions

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

- [ ] PRD drafter interview flow with verification interrogation per requirement
- [ ] `followup` tool used for interactive interview (yield control to user)
- [ ] Verification readiness gate before refinement team deployment
- [ ] 12-point PRD completion checklist enforced
- [ ] No "TBD" in interface contracts — gate until shapes are locked
- [ ] Three parallel analysts per cycle via `forge -p --agent analyst-*`
- [ ] Cross-reference injection in cycle 2+
- [ ] Synthesis agent produces `prd_refined.md` with attributed changes
- [ ] Atomic ticket decomposition with research seeds and verify commands
- [ ] Ticket self-containment: worker can execute without reading full PRD
- [ ] `ANALYSIS_DONE` token detection per refinement worker

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

- [ ] Iterative quality passes via `forge -p --agent szechuan-reviewer`
- [ ] `SAUCE_ACHIEVED` token detection for clean exit
- [ ] min_iterations gate before accepting clean signal
- [ ] Scope control: only reviews files in recent diff, not entire repo

---

## Feature 8: State Management MCP Server

**Priority: P0 (cross-cutting dependency)**

### What It Does

Exposes session state (state.json, microverse.json, anatomy-park.json) as MCP tools so forge agents can read/update state without hardcoded file paths.

### MCP Tools

```json
{
  "tools": [
    { "name": "state_read", "description": "Read current session state", "inputSchema": { "properties": { "file": { "enum": ["state", "microverse", "anatomy-park"] } } } },
    { "name": "state_update", "description": "Atomically update a state field", "inputSchema": { "properties": { "file": { "type": "string" }, "path": { "type": "string" }, "value": {} } } },
    { "name": "state_transition", "description": "Advance session phase", "inputSchema": { "properties": { "from": { "type": "string" }, "to": { "type": "string" } } } }
  ]
}
```

### Why MCP

- Agents don't need to know file paths or locking logic
- Atomic updates handled server-side
- Works with any forge agent regardless of tool restrictions (just add `mcp_state_*` to tools list)
- Orchestrator and agents share state through a consistent interface

### Acceptance Criteria

- [ ] MCP server implementing state_read, state_update, state_transition
- [ ] File-based locking (compatible with external orchestrator reads)
- [ ] `.mcp.json` registration for forge sessions
- [ ] Schema validation on updates

---

## Implementation Strategy

### Phase 1: Foundation (Persona + State + tmux Runner)
1. Write AGENTS.md persona definition with workflow routing
2. Port StateManager to standalone Node.js module (no Pickle Rick deps)
3. Build MCP state server
4. Write core agent definitions (pickle-manager, morty-worker)
5. Port tmux-runner to use `forge -p --agent` instead of `claude -p`
6. Port tmux layout scripts
7. Validate: context-clearing iteration loop with promise token detection

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
5. **MCP server lifecycle:** Who starts/stops the state MCP server? Tmux runner? Per-invocation?
6. **Doom loop detector interaction:** ForgeCode's built-in doom loop detection may interfere with intentionally repetitive patterns (e.g., "run tests" → "fix" → "run tests"). Need to test thresholds.
