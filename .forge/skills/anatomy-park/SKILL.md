---
name: anatomy-park
description: "Three-phase subsystem deep review — tracer/surgeon/verifier rotation with convergence tracking"
---

# Anatomy Park Skill

Three-phase subsystem deep review. A microverse sub-mode that rotates through auto-discovered subsystems, running tracer → surgeon → verifier until all subsystems converge.

## Invocation

### Initialize

```bash
node bin/init-microverse.js <session-dir> <target-dir> \
  --convergence-mode worker \
  --convergence-file anatomy-park.json
```

Creates `anatomy-park.json` with initial state (`status: gap_analysis`).

### Run

```bash
node bin/microverse-runner.js <session-dir>
```

The runner handles gap analysis, subsystem rotation, phase sequencing, and convergence detection.

## Three Phases

Each subsystem passes through three sequential phases per iteration:

### Phase 1: Tracer (read-only)

Agent: `anatomy-tracer` — traces data flows, identifies bugs, rates severity. Outputs structured findings.

No write tools. If zero findings: record clean pass, rotate to next subsystem.

### Phase 2: Surgeon (write)

Agent: `anatomy-surgeon` — applies ONE fix (highest severity), writes a regression test, records trap doors to AGENTS.md. Commits atomically.

### Phase 3: Verifier (read-only)

Agent: `anatomy-verifier` — verifies fix via git diff review and full test suite run. Outputs PASS or FAIL.

No write tools. If FAIL: `git reset --hard` to pre-iteration SHA, increment stall count.

## Subsystem Discovery

During gap analysis, the tracer auto-discovers subsystems:

- Scans immediate subdirectories of the target directory
- Qualifies subdirs with 3+ source files
- Excludes `node_modules`, `dist`, and similar build artifacts
- Writes discovered subsystem list to `anatomy-park.json`

## Convergence

- **Per-subsystem**: Tracks `pass_count`, `consecutive_clean`, `stall_count`
- **Clean pass**: Zero findings from tracer → increment `consecutive_clean`
- **Converged subsystem**: `consecutive_clean >= 2` → skip in rotation
- **Stalled subsystem**: `stall_count >= limit` → skip in rotation
- **Full convergence**: All subsystems converged → flush accumulated trap doors, exit

## State (anatomy-park.json)

Managed by StateManager with atomic writes. Contains:

- Subsystem list with per-subsystem counters
- Current rotation index
- Global convergence status
- Trap door accumulation buffer
