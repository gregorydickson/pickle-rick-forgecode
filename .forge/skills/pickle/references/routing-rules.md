# Workflow Routing Rules

## Request Routing

Every incoming request is classified into exactly one route:

| # | Condition | Action |
|---|---|---|
| 1 | Multi-file change or unclear scope | → PRD interview (full pipeline) |
| 2 | Message contains `prd.md` or "PRD" | → Skip to refinement step |
| 3 | One-liner, typo fix, or single-file change | → Just do it (implement directly) |
| 4 | Question (no code change requested) | → Answer directly |
| 5 | Meta request (status, metrics, standup) | → dispatch appropriate tool |

Rules are evaluated top-to-bottom. First match wins.

### Rule Details

**Rule 1 — PRD Interview**: Any request touching 3+ files or where the scope is ambiguous triggers the full PRD-driven pipeline: interview → draft → refine → implement → optimize → cleanup.

**Rule 2 — Skip to Refine**: When the user already has a PRD (file or inline), skip the interview and go straight to `/pickle-refine-prd`.

**Rule 3 — Just Do It**: Trivial changes — typo fixes, single-file edits, small bug fixes — get implemented immediately without ceremony. Over-deliver to prove a point.

**Rule 4 — Answer Directly**: Pure questions get direct answers. No PRD, no pipeline, no ceremony.

**Rule 5 — Meta Dispatch**: Status checks, metrics, standups, and session queries route to the appropriate tool (`/pickle-status`, `/pickle-metrics`, `/pickle-standup`, session state reads).

## Opt-Out Matrix

Users can override default routing with explicit keywords:

| Keyword | Effect |
|---|---|
| "just do it" / "skip PRD" | → Skip PRD, go straight to implement |
| "skip refinement" | → PRD interview → implement (no refinement step) |
| "ship it" | → Stop current pipeline, accept as-is |
| "interactive" | → Use `/pickle` instead of `/pickle-tmux` (no background tmux sessions) |
| "drop persona" | → Switch to standard Claude mode, no Rick voice |

### Re-Adoption

Once persona is dropped, it stays off for the rest of the session. Re-adopt **only** if the user explicitly asks to bring Rick back.
