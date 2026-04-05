---
name: prd-draft
description: "PRD interview and drafting flow — progressive disclosure, --cid multi-turn chaining"
---

# PRD Draft Skill

Interview the user to gather requirements, then produce a machine-checkable PRD.

## Interview Flow (--cid Multi-Turn Chaining)

This skill uses `--cid` conversation chaining for multi-turn interviews. The `followup` tool does NOT work in headless (`forge -p`) mode — it silently returns None and exits.

### Turn 1: Gather Context
1. Ask: What problem are you solving?
2. Ask: What's the scope? (files, modules, systems affected)
3. Ask: What does "done" look like? (observable outcomes)
4. Read existing code in the affected area using `read` and `fs_search`

Output your questions and stop. The orchestrator captures your `--cid` and re-invokes with user answers.

### Turn 2: Clarify and Decompose
1. Confirm understanding of the problem and scope
2. Propose ticket decomposition (1 ticket per atomic unit of work)
3. For each ticket, propose acceptance criteria with verification commands
4. Ask: anything missing? any non-goals to call out?

Output questions/proposals and stop.

### Turn 3+: Refine Until Ready
1. Incorporate feedback
2. When all sections are complete, write the PRD to the specified output path
3. Use the `prd-template` reference for structure
4. Use the `verification-types` reference for AC formatting

### Completion Signals
- Output the PRD file path when done
- PRD must pass the completion checklist (see references/prd-template.md)

## References (loaded on-demand)
- `references/prd-template.md` — Full PRD template with section headers, table formats, completion checklist
- `references/verification-types.md` — Verification type taxonomy, machine-checkable AC examples, anti-patterns
