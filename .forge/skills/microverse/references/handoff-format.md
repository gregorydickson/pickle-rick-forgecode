# Handoff File Format

Canonical template for `handoff.txt` written by the orchestrator before each iteration. Agents read this file FIRST to understand current state.

Three variants share a common base; microverse and anatomy park extend it with domain-specific sections.

---

## Base Handoff (all modes)

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

## Instructions
{Phase-specific instructions for the agent}
```

### Field Reference

| Field | Source | Description |
|---|---|---|
| Iteration | `opts.iteration` | Current iteration number (1-indexed) |
| Current Phase | `opts.step` | Lifecycle step: `gap_analysis`, `iterating`, `converged`, `stalled` |
| Current Ticket | `opts.currentTicket` | Ticket ID being worked |
| Working Directory | `opts.workingDir` | Absolute path to target codebase |
| Session Root | `opts.sessionRoot` | Absolute path to session directory |
| Time elapsed | Computed from `opts.startTime` | Format: `Xh Ym Zs` |
| Tickets done | `opts.ticketsDone` | Array of completed ticket IDs |
| Tickets pending | `opts.ticketsPending` | Array of remaining ticket IDs |
| Instructions | `opts.instructions` | Phase-specific agent instructions |

---

## Metric Context (microverse / szechuan sauce)

Appended after base handoff when running metric-driven convergence.

```markdown
## Metric Context
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
```

### Field Reference

| Field | Source | Description |
|---|---|---|
| Metric | `opts.metric.description` | Human-readable metric name |
| Validation | `opts.metric.validation` | Shell command or LLM evaluation goal |
| Direction | `opts.metric.direction` | `higher` = bigger is better, `lower` = smaller is better |
| Baseline | `opts.metric.baseline` | Score at iteration 0 |
| Current | `opts.metric.current` | Score at previous iteration |
| Target | `opts.metric.target` | Convergence target score |
| Stall counter | `opts.stallCounter` / `opts.stallLimit` | Consecutive iterations without improvement |
| Recent history | `opts.recentHistory` (last 5) | Array of `{iteration, score, result}` |
| Failed approaches | `opts.failedApproaches` | Array of approach descriptions that regressed or stalled |

---

## Subsystem Context (anatomy park)

Appended after base handoff when running subsystem review rotation.

```markdown
## Subsystem Context
- Current subsystem: {path}
- Subsystem index: {N} / {total}
- Pass count: {N}
- Consecutive clean: {N}
- Previous findings: {summary}
```

### Field Reference

| Field | Source | Description |
|---|---|---|
| Current subsystem | `opts.subsystem` | Path to subsystem under review |
| Subsystem index | `opts.subsystemIndex` / `opts.subsystemTotal` | Position in rotation |
| Pass count | `opts.passCount` | Total review passes on this subsystem |
| Consecutive clean | `opts.consecutiveClean` | Passes with no findings (converges at 2) |
| Previous findings | `opts.previousFindings` | Summary from prior pass |

---

## Implementation Reference

The handoff is generated programmatically by `lib/handoff.js`:
- `buildHandoff(opts)` — base handoff
- `buildMicroverseHandoff(opts)` — base + metric context + history + failed approaches
- `buildAnatomyParkHandoff(opts)` — base + subsystem context
