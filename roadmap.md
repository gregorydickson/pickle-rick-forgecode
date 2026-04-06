# Pickle Rick Roadmap — ForgeCode Edition

![Rick Roadmap](images/rick-roadmap.png)

> Tentative feature ideas. Status: brainstorm. Nothing here is committed — just portals worth investigating. ForgeCode-native where it counts.

## Implemented / In Progress

### Microverse Convergence Loop (P0)
Metric-driven optimization with three sub-modes: metric convergence, Anatomy Park (three-phase subsystem review), and Szechuan Sauce (principle-driven quality). Multi-provider agent selection — gap analysis on cheap models, implementation on expensive ones, judges on fast ones.

### tmux Runner (P0)
Context-clearing iteration loop. Fresh `forge -p` per iteration, circuit breaker, promise token detection via `auto_dump` role filtering, parallel Morty workers in git worktrees.

### PRD Pipeline (P0)
Interactive PRD drafting via `--cid` multi-turn chaining, readiness gate, refinement team (3 parallel analysts), synthesis + ticket decomposition.

### Persona System (P1)
AGENTS.md persona injection, workflow routing, per-agent model selection, tool restriction enforcement.

---

## Proposed Features

### /interdimensional-cable
Live-stream logs from multiple running services side-by-side in a TUI. Each pane is a "channel" you can flip through. ForgeCode edition: agents monitoring different service logs with per-channel alert agents on cheap models.

### /portal-fluid
Dependency graph visualizer. Shows how packages flow between repos like portal fluid through the gun. Highlights circular deps in toxic green. Could leverage ForgeCode's `sem_search` for cross-repo symbol resolution.

### /vindicators
Spin up N parallel ForgeCode agents that each solve the same problem differently, then a judge agent votes on the best solution. Each Vindicator gets a different model/provider — the mission succeeds when the strongest solution is chosen. ForgeCode's multi-provider support makes this trivial: one Vindicator on Claude, one on GPT, one on Gemini.

### /butter-robot
Single-purpose bot generator. Give it one task ("run lint on save" / "ping me when tests fail") and it creates a minimal daemon. ForgeCode edition: generates a `.forge/agents/` definition that does exactly one thing.

### /cronenberg
Mutation testing on steroids. Intentionally corrupts the codebase in horrifying ways and checks if the test suite catches it. If tests still pass, you've Cronenberg'd yourself. (See also: Project Mayhem, which already does this.)

### /tiny-rick
Minification and bundle analysis. Shrinks code down to its smallest, most energetic form.

### /plumbus
Auto-generates boilerplate that everyone needs but nobody wants to explain. ForgeCode edition: generates agent definitions, skill scaffolds, and forge.toml configs. Everyone has a plumbus.

### /squanch
Universal search-and-replace across the entire monorepo with preview, rollback, and regex support.

### /death-crystal
Predictive impact analysis. Shows all possible futures (code paths) affected by a current change. Builds on GitNexus impact analysis with forward-looking path exploration. ForgeCode agents could run parallel impact traces across different subsystems.

### /get-schwifty
Performance benchmarking suite. Runs load tests, profiles memory, judges code performance. Multi-provider: fast model runs the benchmarks, expensive model analyzes the results.

### /simple-rick
Strips a complex module down to its simplest possible implementation. Removes every abstraction, flattens every inheritance chain. A microverse sub-mode with "complexity score" as the metric.

### /gazorpazorp
Dependency spawner. One command creates a child package with all the right tsconfig inheritance, shared types, and build pipeline. Generates the ForgeCode agent definitions to maintain it.

### /fleeb-juice
Secret rotation and environment variable manager. Detects hardcoded secrets, extracts them, and rotates them on a schedule.

### /mr-poopybutthole
Companion agent that watches your coding session and periodically summarizes what you've done. Always honest, even when it hurts. ForgeCode edition: runs as a background agent on a cheap model, tailing your session logs.

### /unity
Monorepo sync tool. When you change a shared type or interface, Unity assimilates every consuming package to stay compatible. One mind, one type system. ForgeCode's multi-agent orchestration could run per-package adaptation in parallel.

### /evil-morty
Adversarial code reviewer. Deliberately tries to find exploits, injection vectors, and security holes in PRs. Thinks three steps ahead. Agent definition: read-only tools only, explicitly instructed to think like an attacker.

### /blips-and-chitz
Gamified test coverage. Assigns points for covering edge cases, achievement badges for hitting coverage thresholds. Roy: A Life Well Tested.

### /meseeks-box
Spawns disposable `forge -p` agents for one-shot tasks: "generate fixtures," "write migration," "stub this API." They exist to serve a single purpose, then poof. ForgeCode makes this native — every `forge -p` is already a disposable agent.

### /galactic-federation
Centralized audit log across all repos. Every deploy, PR merge, config change — tracked with federation-level bureaucracy.

### /story-train
Auto-generates changelogs and release notes from commit history by weaving commits into a coherent narrative. Each release is an "episode."

### /detoxifier
Tech debt remediation. Scans for code smells, complexity hotspots, and outdated patterns, then generates targeted refactoring tickets. Could feed directly into the microverse loop for automated cleanup.

### /jerry-detector
Identifies code that's trying too hard and accomplishing too little. Over-abstracted factories, unnecessary wrapper classes, enterprise-grade hello worlds.

### /birdperson
Long-running integration test orchestrator. Patient, methodical, reliable. Runs the slow E2E suites that nobody wants to wait for.

### /phoenix-person
Auto-resurrection for failed deployments. Detects a bad deploy, rolls back, and redeploys the last known good version.

### /ricks-garage
Local dev environment bootstrapper. One command sets up the entire local stack — databases, services, env files, seed data.

### /time-crystal
Build caching and incremental compilation optimizer. Analyzes what actually changed and skips everything that doesn't need rebuilding.

### /citadel
Multi-environment management. Spin up, tear down, and switch between dev/staging/prod configs like walking between dimensions.

### /scary-terry
Nightmare scenario generator for APIs. Fuzzes endpoints with malformed payloads, missing auth, absurd edge cases. ForgeCode agents with shell + write tools generating and executing fuzz payloads.

### /two-brothers
Pair programming mode. Two ForgeCode agents work the same file — one writes code, one writes tests. Different models for each. It's just two brothers. In a codebase.

### /memory-parasites
Detects and removes dead imports, unused variables, orphaned files, and zombie exports that are imported nowhere. Like Total Rickall — everything that can't prove it belongs gets eliminated.

### /ricks-flask
Schema evolution manager. Generates migration scripts when types, DB schemas, or API contracts change.

### /interdimensional-customs
Pre-merge validation that checks a PR against every downstream consumer repo. "Papers, please" — your change doesn't cross the border until all dependents pass.

### /morty-mindblowers
Extracts lessons from failed CI runs, reverted PRs, and rolled-back deploys into a searchable knowledge base. Every failure is a mind-blower worth remembering.

### /snake-jazz
Rhythm-based rate limiting and retry logic generator. Give it an API integration and it generates backoff strategies, circuit breakers, and retry patterns that groove.

### /doofus-rick
Intentionally dumbed-down code explainer. Takes complex code and rewrites it at a junior-dev reading level with heavy comments. Not the smartest Rick, but the most helpful. Agent definition: cheap model, no write tools, "explain like I'm Jerry" system prompt.

### /froopyland
Sandbox environment for running untrusted or experimental code. Spins up an isolated container, runs the code, captures output, tears it down. Nothing escapes Froopyland.

### /operation-phoenix
Clone detector across repos. Finds copy-pasted code between projects that should be a shared library. If you die in one repo, you wake up in another with the same code.

### /glorzo
"Glory to Glorzo" — monotask enforcer. Locks the session to ONE ticket/issue until it's done. No context switching, no tangents. Hive mind focus.

### /nimbus
Cloud cost analyzer. Scans IaC (CDK, Terraform, CloudFormation) and estimates monthly cost impact of infrastructure changes before they deploy.

### /rickmobile
Mobile-first responsive audit. Runs a page through viewport sizes, checks touch targets, font scaling, and layout breakpoints.

### /wendys
"We're not going back to Bendigo!" — Rollback guard. Before any destructive migration, snapshots the current state and generates a verified rollback script.

### /morty-smith-database
Type-safe mock data generator. Reads your schemas (Drizzle, Prisma, Zod, JSON Schema) and generates realistic, referentially-intact seed data.

### /ghost-in-a-jar
Wraps any long-running process in a persistent container that survives terminal disconnects. Ghost in a jar can't die — reconnect anytime and pick up where you left off.

### /pickle-pipeline
DAG-based task orchestrator for multi-step data pipelines. Define steps as nodes, dependencies as edges. Retry failed nodes without re-running the whole pipeline. It's a pickle pipeline, Morty.

### /wubba-lubba-dub-dub
Burndown and velocity tracker. Reads ticket history, commit velocity, and PR merge rate to generate a "pain index."

### /ants-in-my-eyes-johnson
Accessibility auditor. Scans UI code for ARIA violations, contrast failures, keyboard navigation gaps, and screen reader incompatibilities.

---

## ForgeCode-Native Roadmap

These features leverage ForgeCode capabilities that have no Claude Code equivalent.

### /council-of-ricks — Multi-Provider Ensemble
Run the same task across multiple LLM providers simultaneously (Claude, GPT, Gemini, Llama) and a judge agent picks the best output. ForgeCode's per-agent `model` field makes this trivial — each Rick is a different provider. Useful for: code review (ensemble consensus), implementation (best-of-N), and cost optimization (find the cheapest model that passes acceptance criteria).

### /agent-marketplace
Shareable agent definitions. Publish `.forge/agents/*.md` files as packages. Import community agents: `forge install agent @pickle-rick/security-auditor`. Each agent is just a Markdown file with YAML frontmatter — zero infrastructure needed.

### /provider-roulette
Automatic model fallback and cost optimization. Define a priority chain: try Sonnet first, fall back to Haiku if rate-limited, escalate to Opus for complex failures. Per-iteration model selection based on task complexity scoring.

### /mcp-portal-network
MCP tool integration hub. Connect any MCP server as a ForgeCode tool source. Agents automatically discover available tools. Current targets: Linear (tickets), GitHub (PRs), Slack (notifications), Supabase (database), Chrome DevTools (E2E testing).

### /custom-provider-forge
Add any OpenAI-compatible API as a ForgeCode provider. One TOML config block, zero code. Targets: local models (Ollama, vLLM), fine-tuned endpoints, custom inference servers. Enables fully offline Pickle Rick sessions.

### /skill-composer
Visual skill builder. Drag-and-drop skill composition from existing skills + agent definitions. Generates the `.forge/skills/` directory structure with progressive disclosure metadata. Because even Rick needs a GUI sometimes.

### /dimension-hopper — Cross-Agent Memory
Persistent memory that travels between agent invocations. Unlike `--cid` (which replays conversation), dimension-hopper distills key facts into a compact memory blob injected into every agent's handoff. Survives session boundaries. Implementation: memory agent on a cheap model that summarizes after each session.

### /infinite-morty — Adaptive Worker Scaling
Dynamic worker count based on task complexity and rate limit headroom. Start with 1 Morty, scale to N when the work is embarrassingly parallel (independent tickets), scale back to 1 when sequential dependencies appear. Git worktree pool management.

### /rickbot-as-a-service
Expose Pickle Rick sessions as an HTTP API. POST a PRD, GET back progress updates, webhook on completion. Enables CI/CD integration: PR opened → Pickle Rick reviews → comments posted automatically.
