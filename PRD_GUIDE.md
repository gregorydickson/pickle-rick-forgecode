# How to Write a PRD for Pickle Rick

![Writing PRDs for Your Project](images/prd-rick.png)

*Most PRDs are garbage — wishes sprinkled with corporate jargon. This guide tells you how to write one my system can turn into working code.*

---

## Four Ways to Start

**A: Just talk** — Describe what you want in a ForgeCode session. I'll ask questions, poke holes, write the PRD. Save as `.md`, hand it to the refinement skill or the main loop.

**B: PRD drafter skill** — Structured interview. Why, Who, What, How, plus verification drilling (how to verify each requirement automatically). I write the PRD and initialize a session. ForgeCode advantage: the drafter runs as a dedicated agent with `--cid` multi-turn chaining, so the conversation persists across turns without blowing context.

**C: Write it yourself** — Hand a `.md` to the refinement skill. Three parallel analysts refine it, cross-reference your codebase, produce tickets.

**D: Wing it** — Describe your task and let the main loop handle it. I draft a PRD from one sentence. Fine for small stuff, gambling for anything complex.

---

## What Goes in a PRD

🔴 = critical, 🟡 = recommended, 🟢 = optional. Write for a hyper-intelligent pickle who's short on patience.

### 1. Title & Summary — 🔴
```markdown
# [Feature] PRD
One sentence: what it does and why.
```
"Improve performance" = useless. "Add Redis caching to loan-status API" = useful.

### 2. Problem Statement — 🔴
```markdown
## Problem
**Current Process**: | **Users**: | **Pain Points**: | **Importance**:
```
Skip this and I'm solving the wrong problem brilliantly.

### 3. Objective & Scope — 🔴
```markdown
## Scope
**Objective**: Single measurable goal | **Done looks like**:
### In-scope
### Not-in-scope
```
Not-in-scope is more important. Without it, I'll keep adding features you didn't ask for.

### 4. User Journeys — 🟡
Step-by-step flows. These become acceptance criteria. "User clicks Edit Profile → changes email → Save → sees toast → new email in header" — that's verifiable.

### 5. Functional Requirements — 🟡
```markdown
| Priority | Requirement | Verification |
|:---------|:------------|:-------------|
| P0       | Cached results <50ms | `curl -w '%{time_total}' /api/status` |
| P1       | Cache invalidates on change | `npm test -- cache-invalidation.test` |
```
Every requirement needs a Verification column — a machine-checkable command, test, or assertion. The spec IS the review.

### 6. Interface Contracts — 🟡
```markdown
## Interface Contracts
| Endpoint | Input | Output | Error |
|:---------|:------|:-------|:------|
```
Exact shapes at boundaries — field names, types. If your feature crosses module/service boundaries, this is required. N/A with justification otherwise.

### 7. Verification Strategy — 🟡
How conformance is checked automatically:
- **Type**: project type checker passes (tsc/mypy/equivalent)
- **Test**: all acceptance tests pass
- **Contract**: interface shapes match impl signatures
- **LLM**: agent reads impl, quotes code, PASS/FAIL (behavioral reqs only)

ForgeCode advantage: the LLM judge can be a cheap, fast model (e.g., Gemini Flash) via per-agent model selection, keeping verification costs low while implementation agents run on heavier models.

### 8. Test Expectations — 🟡
```markdown
| Requirement | Test File | Description | Assertion |
|:------------|:----------|:------------|:----------|
```
Specified BEFORE implementation. Small features (<3 files) can consolidate into requirements table.

### 9. Technical Constraints — 🟡
What I *can't* do. Boundaries make me more creative.

### 10. Codebase Context — ⭐
File paths, function names, existing patterns. My refinement team greps your repo, but pointing at the right files up front makes tickets *significantly* better.

### 11. Assumptions / Risks / Impact — 🟢
Things to verify before building, risk mitigations, success metrics.

---

## Minimum Viable PRD

```markdown
# [Feature] PRD

## Problem
[2-3 sentences: what's broken and who cares]

## Goal
[1 sentence: what "done" looks like]

## Scope
### In
- [What to build]
### Out
- [What NOT to build]

## Requirements
| Priority | Requirement | Verification |
|:---------|:------------|:-------------|
| P0       | [Must have] | [command/test] |
| P1       | [Should have] | [command/test] |

## Context
- Key files: [paths]
- Patterns to follow: [examples]
```

Five sections. Refinement fills the gaps.

---

## Good vs. Bad PRD Signals

**Good**: Specific verbs (Add/Replace/Remove), measurable outcomes (under 200ms), file references, explicit boundaries, concrete user flows, machine-checkable verification.

**Bad**: Vague aspirations ("world-class"), no scope boundaries, requirements that are implementation details, zero codebase context, multiple unrelated features, subjective acceptance criteria ("looks good").

---

## How the System Uses Your PRD

1. **Verification Readiness** — Checks for interface contracts, verification strategy, test expectations, machine-checkable criteria. Missing/vague → interactive interview. Under-specified PRDs can't auto-run.
2. **Refinement** — 3 parallel analysts × 3 cycles against your codebase. Requirements, codebase context, risk/scope. Each analyst is a `forge -p` worker with enforced tool restrictions — read-only codebase access, no writes.
3. **Decomposition** — Atomic tickets (<30min, <5 files, <4 criteria). Self-contained with embedded contracts, tests, conformance checks.
4. **Execution** — 8 phases per ticket: Research → Review → Plan → Review → Implement → **Spec Conformance** → Code Review → Simplify. Conformance runs every acceptance criterion and checks contracts before subjective review.

**Your PRD is the source of truth AND the review mechanism.** Precise spec = automated verification. Graphite is the audit trail, not the bottleneck.

---

## Quick Reference

| Skill / Command | Use When |
|:----------------|:---------|
| PRD drafter | Want guided interview → PRD |
| Refinement skill | Have a draft → refine + tickets |
| Refinement skill `--run` | Ready to let it rip |
| Main loop (single task) | Small/clear task, one shot |
| `--resume` with tmux runner | Picking up where you left off |
