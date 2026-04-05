# PRD Template

Use this template for all PRDs. Every section is required unless marked optional.

---

```markdown
# PRD: [Title]

## Overview

[1-3 sentences: what this PRD accomplishes and why it matters.]

## Scope

[What's in scope. Working directory, test runner, module format if relevant.]

**Working directory**: `<path>`
**Test runner**: `<command>`
**Module format**: ESM | CJS

## Non-Goals (optional)

| Item | Decision | Rationale |
|---|---|---|
| [Feature/subsystem] | OUT / DEFER | [Why] |

## Risks (optional)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | [Description] | Low/Medium/High | Low/Medium/High/Critical | [Action] |

---

## Ticket N: [Title]

**Priority**: P0 | P1 | P2
**Files**: `path/to/file.js`, `path/to/test.js`

### Problem
[What's wrong or missing. Be specific — reference file:line when possible.]

### Fix
[What to do. Implementation approach, not vague handwaving.]

### Interface Contract (if public API changes)

```language
functionName(params) → returnType
```

### Acceptance Criteria
- [ ] [Description] — Verify: `[shell command]` — Type: test
- [ ] [Description] — Verify: `[shell command]` — Type: lint
- [ ] [Description] — Verify: `[manual step]` — Type: smoke
- [ ] [Description] — Verify: `[human review step]` — Type: manual

### Test Expectations (optional)
- `test description` in `tests/file.test.js`

### Conformance Check (optional)
- `[additional verification command]`

---

*(repeat Ticket sections as needed)*
```

---

## Completion Checklist

Before finalizing a PRD, verify:

- [ ] Every ticket has Priority, Files, Problem, and Fix sections
- [ ] Every acceptance criterion has a `Verify:` command (not "TBD" or empty)
- [ ] Every acceptance criterion has a `Type:` (test, lint, smoke, or manual)
- [ ] Verify commands are actual shell commands that can be copy-pasted and run
- [ ] No time estimates anywhere in the document
- [ ] Interface contracts exist for any public API changes
- [ ] Non-goals table exists if scope was reduced from initial ask
- [ ] Risks table exists if implementation has unknowns
- [ ] File paths are concrete (not "the relevant file" or "wherever it lives")
- [ ] Working directory and test runner are specified in Scope
