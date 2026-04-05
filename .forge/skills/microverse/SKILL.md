---
name: microverse
description: "Metric-driven convergence loop — measure baseline, iterate improvements, rollback regressions, converge on target"
---

# Microverse Convergence Skill

Metric-driven optimization loop with three sub-modes:
- **Metric-Driven** (default) — measure → improve → verify → compare → rollback regressions → repeat
- **Anatomy Park** — three-phase subsystem review (trace → fix → verify) with rotation
- **Szechuan Sauce** — principle-driven quality convergence

## Invocation

### 1. Initialize

```bash
node bin/init-microverse.js <session-dir> <target-dir> \
  --convergence-target <number> \
  --metric-json '{"description":"...","validation":"...","type":"command","direction":"higher|lower","tolerance":0.5}'
```

Creates `<session-dir>/microverse.json` with initial state (`status: gap_analysis`, `baseline_score: 0`).

### 2. Run

```bash
node bin/microverse-runner.js <session-dir>
```

The runner:
1. **Gap analysis**: Spawns `forge -p --agent microverse-analyst` to analyze codebase
2. **Baseline**: Measures initial metric score, records in `microverse.json`
3. **Iteration loop**: Writes `handoff.txt` (see `references/handoff-format.md`), spawns `forge -p --agent microverse-worker`
4. **Compare**: Improved → accept. Regressed → `git reset --hard` to pre-SHA. Held → accept, increment stall counter
5. **Converge**: Exits when target reached or stall limit hit

### 3. Monitor

Watch the runner output for iteration summaries:
```
Iteration 7: 82% → 85% (accept)
Iteration 8: 85% → 85% (held, stall 1/3)
```

## Metric Measurement

Use `scripts/measure-metric.sh` to run metric validation standalone:

```bash
bash scripts/measure-metric.sh metric.json
# Outputs: numeric score to stdout
# Exits 1 if output is non-numeric
```

## Handoff Format

Each iteration writes a `handoff.txt` that workers read before acting. See `references/handoff-format.md` for the canonical template covering all three sub-modes.

## References (loaded on-demand)
- `scripts/measure-metric.sh` — Generic metric measurement wrapper; runs validation command, outputs numeric score
- `references/handoff-format.md` — Canonical handoff template with all sections: base, metric context, subsystem context
