# grok-swap

[![CI](https://github.com/possibilities/grok-swap/actions/workflows/ci.yml/badge.svg)](https://github.com/possibilities/grok-swap/actions/workflows/ci.yml)

`grok-swap` is an independent multi-account store for xAI OAuth sessions. It
observes each account's Grok coding allowance and paid-credit state, preserves
the last good result through transient failures, and makes deterministic,
reservation-aware account selections for callers such as AgentUsage.

> [!IMPORTANT]
> This first release intentionally stops at the data and decision boundary. It
> **cannot activate a selected account in Grok Build, wrap or launch a Grok
> harness, or integrate that activation with AgentLaunch**. Its OAuth and
> billing implementations are fixture-tested against contracts inferred from
> the first-party Grok Build and Fx source trees; live-account validation still
> requires a human OAuth sign-in. The upstream compatibility surfaces may
> change.

Those are built-in gaps, not hidden promises. Contributions that move the
project toward the practical parity of `claude-swap` and `codex-swap`—especially
safe harness activation, broader live validation, and portable browser login—
are explicitly welcome.

This is an unofficial project and is not affiliated with, endorsed by, or
supported by xAI. Grok and xAI are trademarks of their respective owner.

## What it owns

The private store defaults to `~/.local/state/grok-swap/state.json` (override
the directory with `GROK_SWAP_HOME`). `grok-swap` never imports, reads, or
mutates Grok Build's `~/.grok/auth.json` or Fx's `~/.fx/grok-auth.json`.
Account credentials are written atomically with owner-only permissions.

Each successful login receives an immutable ordinal identity (`grok-1`,
`grok-2`, …). Removing an account does not recycle its ordinal. Aliases are
mutable conveniences; automation should retain `accountKey`.

## Install

Requires Bun 1.3.14 or newer.

```sh
bash scripts/install.sh --install
```

The installer creates a rerunnable shim at `~/.local/bin/grok-swap`. It does
not install Grok Build because observation talks directly to xAI's OAuth and
billing compatibility surfaces.

## Use

```sh
grok-swap add --alias personal
grok-swap list
grok-swap observe
grok-swap refresh --account grok-1
grok-swap select --mode best --reserve-seconds 30
grok-swap select --account grok-2 --dry-run
grok-swap disable grok-2
grok-swap alias grok-1 work
grok-swap remove grok-2
```

`add` uses the xAI OAuth device authorization flow, opens the verification URL
when possible, and prints the user code. Add `--no-open` to suppress the browser
attempt. Machine callers add `--json`; OAuth instructions remain on stderr and
stdout receives exactly one final envelope.

`observe` refreshes nearly-expired access tokens and fetches
`https://cli-chat-proxy.grok.com/v1/billing?format=credits`. Failed fetches
never erase a last-good observation; retries use bounded exponential backoff.
`refresh` forces the same operation, bypassing backoff.

Selection uses locally durable observations and never launches a harness.
`best` ranks remaining included allowance first, then prepaid dollars, then
PAYG headroom. `next-available` rotates over eligible accounts. Unknown usage
fails closed unless `--allow-unknown` is explicit. A last-good result remains
displayable indefinitely, but becomes ineligible for automatic decisions after
24 hours. Non-dry selections create a short reservation (30 seconds by default,
at most 300 seconds) so simultaneous callers do not choose the same account.

## Machine contract

All machine commands emit one envelope with `schema_version: 1`, `ok`,
`command`, `provider: "grok"`, `generatedAt`, `data`, and `error`. Secrets,
authorization URLs, and raw upstream bodies never appear. Inspect the complete
typed command and error vocabulary with:

```sh
grok-swap guide --json
grok-swap --agent-help
```

The provider-facing core is:

```sh
grok-swap list --json
grok-swap observe --json
grok-swap refresh --json [--account grok-N]
grok-swap select --json [--mode best|next-available | --account grok-N] \
  [--allow-unknown] [--dry-run] [--reserve-seconds 30]
```

Compatibility note: the xAI client identifier, issuer, scopes, refresh grant,
userinfo lookup, and billing request headers were inferred from xAI's Grok
Build and Fx implementations. They are not a documented stable public API.
