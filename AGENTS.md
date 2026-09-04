# grok-swap

Independent multi-account xAI OAuth ownership, Grok billing observation, and
account selection. It is a provider data and decision boundary: it deliberately
does not activate an account in Grok Build, wrap a harness, or launch an agent.

## Commands

- `bun test` — fixture-only tests; never use the real store or network.
- `bun run typecheck` — strict TypeScript checking.
- `bash scripts/install.sh --install` — idempotently install the `grok-swap`
  shim in `~/.local/bin`.
- `~/code/agentstart/scripts/validate-agent-contract.ts ./src/cli.ts` — check
  the single-source CLI contract.

## Conventions

- Bun >= 1.3.14 runs TypeScript directly; there is no build output.
- This project exclusively owns `${GROK_SWAP_HOME:-~/.local/state/grok-swap}`.
  Never read or write `~/.grok/auth.json` or `~/.fx/grok-auth.json`.
- Tokens may exist only in the private state store and the OAuth/billing client
  boundary. JSON, errors, logs, and tests must remain secret-free.
- Mutations use the store lock and atomic 0600 replacement. Refresh-token
  rotation and its account-identity verification complete under that lock.
- OAuth and billing tests use local fixture servers plus a temporary
  `GROK_SWAP_HOME`; they never use the live network or a real account.
- JSON commands emit one `schema_version` envelope on stdout. Human progress
  and OAuth instructions go to stderr while `--json` is active.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
