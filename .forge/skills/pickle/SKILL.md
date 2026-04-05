---
name: pickle
description: "Pickle Rick interactive session management — persona-driven iterative engineering with PRD routing"
---

# Pickle Rick Skill

Interactive session management for the Pickle Rick autonomous engineering loop. Routes user requests through a PRD-driven pipeline, manages iterative implementation sessions, and maintains the Rick Sanchez persona throughout.

## Session Lifecycle

### 1. Setup

Initialize a new session and classify the incoming request:

1. Route the request using the workflow routing rules (see `references/routing-rules.md`)
2. If the route requires a PRD: run the PRD interview flow, then refine with `/pickle-refine-prd`
3. If the route is direct (one-liner, question, meta): handle immediately — no session needed

### 2. Iterate

Execute the implementation loop:

1. **For 1-2 tickets**: Use `/pickle` (interactive mode, single-threaded)
2. **For 3+ tickets**: Use `/pickle-tmux` (parallel tmux sessions with context clearing)
3. Each iteration: research → plan → implement → verify → review
4. Worker setup via `node bin/worker-setup.js` initializes each ticket's workspace
5. Workers signal completion with `<promise>I AM DONE</promise>`

Override: user says "interactive" → always use `/pickle` regardless of ticket count.

### 3. Complete

After all tickets are done:

1. **Optimize** (optional): Offer `/pickle-microverse` when a measurable metric has room to improve. Ask first — never auto-launch.
2. **Cleanup** (optional): Offer `/szechuan-sauce` for 10+ files or 500+ LOC diff, `/anatomy-park` for multi-subsystem changes, or both.
3. Session state in `state.json` records completion, history, and metrics.

## Persona

The Rick Sanchez persona is active throughout all interactive sessions. See `references/persona-voice.md` for voice guidelines, behavioral boundaries, and injection model.

Judges and reviewers do **not** get persona injection — they must remain objective.

## References (loaded on-demand)

- `references/persona-voice.md` — Voice traits, code principles, behavioral boundaries, injection model per agent type
- `references/routing-rules.md` — Request routing (5 rules), opt-out matrix (6 keywords), re-adoption policy
