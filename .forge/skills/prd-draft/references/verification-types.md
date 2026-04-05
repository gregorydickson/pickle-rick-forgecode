# Verification Types

Every acceptance criterion in a PRD must have a verification type and a concrete verify command.

## Type Taxonomy

| Type | When to Use | Automation | Example Verify Command |
|---|---|---|---|
| `test` | Behavior is testable with a unit/integration test | Fully automated | `node --test tests/foo.test.js --test-name-pattern "handles-empty"` |
| `lint` | Enforced by static analysis (types, linter rules, format) | Fully automated | `npx tsc --noEmit` or `npx eslint lib/foo.js` |
| `smoke` | Observable behavior that's hard to unit test (CLI output, file creation) | Semi-automated | `node bin/cli.js --help \| grep "Usage"` |
| `manual` | Requires human judgment (UX, readability, architecture) | Human review | "Review that error messages are user-friendly" |

## Machine-Checkable AC Examples

### Type: test
```
- [ ] Transaction returns states in caller-specified order — Verify: `node --test tests/state-manager.test.js --test-name-pattern "transaction-ordering"` — Type: test
- [ ] SHA validation rejects non-hex input — Verify: `node --test tests/git-utils.test.js --test-name-pattern "sha-validation"` — Type: test
- [ ] Stash returns ref string — Verify: `node --test tests/git-utils.test.js --test-name-pattern "stash-returns-ref"` — Type: test
```

### Type: lint
```
- [ ] No TypeScript errors in modified files — Verify: `npx tsc --noEmit` — Type: lint
- [ ] No ESLint violations in lib/ — Verify: `npx eslint lib/` — Type: lint
- [ ] Exports match public API surface — Verify: `node -e "import('./lib/index.js')"` — Type: lint
```

### Type: smoke
```
- [ ] CLI prints usage when invoked with --help — Verify: `node bin/cli.js --help | grep -q "Usage"` — Type: smoke
- [ ] Config file created in expected location — Verify: `ls -la .forge/skills/prd-draft/SKILL.md` — Type: smoke
- [ ] Process exits cleanly on valid input — Verify: `echo '{}' | node bin/process.js; echo $?` — Type: smoke
```

### Type: manual
```
- [ ] Error messages are actionable and user-friendly — Verify: "Review error output for clarity" — Type: manual
- [ ] PRD structure matches team conventions — Verify: "Compare against references/prd-template.md" — Type: manual
```

### Type: llm-conformance
```
- [ ] Agent system prompt instructs --cid chaining — Verify: "Read agent .md, confirm --cid instructions present" — Type: llm-conformance
- [ ] No followup tool in agent tools list — Verify: `grep -c 'followup' .forge/agents/prd-drafter.md` returns 0 — Type: llm-conformance
```

## Anti-Patterns

### Vague Criteria
**Bad**: `- [ ] It works correctly — Verify: TBD — Type: test`
- "Works correctly" is not observable
- "TBD" is not a command
- This will never be checked by anyone

**Good**: `- [ ] Returns empty array for zero results — Verify: \`node --test tests/search.test.js --test-name-pattern "empty-results"\` — Type: test`

### Missing Verify Command
**Bad**: `- [ ] API returns 200 on valid input — Type: test`
- No verify command. How does the implementer know when this passes?

**Good**: `- [ ] API returns 200 on valid input — Verify: \`node --test tests/api.test.js --test-name-pattern "valid-input-200"\` — Type: test`

### Wrong Type
**Bad**: `- [ ] Code is well-structured — Verify: \`npm test\` — Type: test`
- "Well-structured" is a human judgment, not a test assertion
- Using `npm test` as a proxy for structure is meaningless

**Good**: `- [ ] Code is well-structured — Verify: "Review for single responsibility, <3 levels of nesting" — Type: manual`

### Untestable as Written
**Bad**: `- [ ] Performance is acceptable — Verify: "Check that it's fast" — Type: manual`
- "Acceptable" and "fast" are not measurable

**Good**: `- [ ] P95 latency under 200ms for 1000 requests — Verify: \`node bench/latency.js --requests 1000 | grep "p95"\` — Type: smoke`

### Catch-All Test Commands
**Bad**: `- [ ] All tests pass — Verify: \`npm test\` — Type: test`
- Runs the entire suite. Doesn't verify the specific behavior.
- Passes even if the new test doesn't exist.

**Good**: `- [ ] Specific behavior verified — Verify: \`node --test tests/specific.test.js --test-name-pattern "exact-case"\` — Type: test`
