#!/usr/bin/env bun
import { publicAccount, publicObservation, observeAccount } from "./billing.ts";
import { CONTRACT, renderAgentHelp, renderAgentTeaser, renderHelp } from "./guide.ts";
import { login } from "./oauth.ts";
import { selectAccount, type SelectionMode } from "./select.ts";
import { readState, resolveAccount, validateAlias, withState } from "./store.ts";
import type { StoredAccount } from "./types.ts";
import { CliError, failure, success } from "./types.ts";
import { VERSION } from "./version.ts";

const rawArgs = process.argv.slice(2);
let json = rawArgs.includes("--json");
let command = "help";

try {
  json = removeBooleanFlag(rawArgs, "--json");
  command = commandName(rawArgs);
  if (removeBooleanFlag(rawArgs, "--agent-help")) {
    ensureNoArguments(rawArgs);
    process.stdout.write(`${renderAgentHelp()}\n`);
  } else if (removeBooleanFlag(rawArgs, "--agent-teaser")) {
    ensureNoArguments(rawArgs);
    process.stdout.write(`${renderAgentTeaser()}\n`);
  } else if (rawArgs[0] === "--version" || rawArgs[0] === "version") {
    command = "version";
    rawArgs.shift();
    ensureNoArguments(rawArgs);
    emit(command, VERSION);
  } else if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h" || rawArgs[0] === "help") {
    command = "help";
    if (rawArgs.length) rawArgs.shift();
    ensureNoArguments(rawArgs);
    process.stdout.write(`${renderHelp()}\n`);
  } else {
    command = rawArgs.shift()!;
    const data = await dispatch(command, rawArgs);
    emit(command, data);
  }
} catch (error) {
  const safe = error instanceof CliError
    ? error
    : new CliError("internal_error", "grok-swap could not complete the command");
  if (json) process.stdout.write(`${JSON.stringify(failure(command, safe))}\n`);
  else process.stderr.write(`grok-swap: ${safe.message}\n`);
  process.exitCode = safe.exitCode;
}

async function dispatch(name: string, args: string[]): Promise<unknown> {
  switch (name) {
    case "guide":
      ensureNoArguments(args);
      if (!json) return renderAgentHelp();
      return CONTRACT;
    case "list":
      ensureNoArguments(args);
      return readState().then((state) => ({ accounts: state.accounts.slice().sort(byOrdinal).map((account) => publicAccount(account)) }));
    case "add":
      return add(args);
    case "observe":
      ensureNoArguments(args);
      return observe(false, null);
    case "refresh": {
      const reference = takeValueFlag(args, "--account");
      ensureNoArguments(args);
      return observe(true, reference);
    }
    case "select":
      return select(args);
    case "remove":
      return remove(args);
    case "alias":
      return alias(args);
    case "enable":
      return setEnabled(args, true);
    case "disable":
      return setEnabled(args, false);
    default:
      throw new CliError("unknown_command", `Unknown command ${JSON.stringify(name)}`, undefined, 2);
  }
}

async function add(args: string[]): Promise<{ account: ReturnType<typeof publicAccount> }> {
  const aliasRaw = takeValueFlag(args, "--alias");
  const openBrowser = !removeBooleanFlag(args, "--no-open");
  ensureNoArguments(args);
  const accountAlias = aliasRaw === null ? null : validateAlias(aliasRaw);
  const signedIn = await login({
    openBrowser,
    onPrompt(prompt) {
      process.stderr.write(
        `Open ${prompt.verificationUri}\nEnter code: ${prompt.userCode}\nWaiting for xAI authorization (expires in ${prompt.expiresIn}s)…\n`,
      );
    },
  });
  return withState((state) => {
    const duplicate = state.accounts.find((account) => account.userId === signedIn.userId);
    if (duplicate) {
      throw new CliError("account_exists", `That xAI account is already stored as ${duplicate.accountKey}`, { accountKey: duplicate.accountKey }, 2);
    }
    const ordinal = state.nextOrdinal;
    const accountKey = `grok-${ordinal}`;
    const collision = state.accounts.find((candidate) =>
      (accountAlias !== null && referenceMatches(candidate, accountAlias)) ||
      (signedIn.email !== null && candidate.alias === signedIn.email) ||
      candidate.alias === accountKey
    );
    if (collision) {
      throw new CliError("alias_conflict", `The new account would make references ambiguous with ${collision.accountKey}`, { accountKey: collision.accountKey }, 2);
    }
    state.nextOrdinal++;
    const now = new Date().toISOString();
    const account: StoredAccount = {
      accountKey,
      displayName: accountKey,
      ordinal,
      alias: accountAlias,
      email: signedIn.email,
      userId: signedIn.userId,
      enabled: true,
      credentials: signedIn.credentials,
      observation: { lastGood: null, lastAttemptAt: null, failureCount: 0, nextAttemptAtMs: null, error: null },
      createdAt: now,
      updatedAt: now,
    };
    state.accounts.push(account);
    return { result: { account: publicAccount(account) }, changed: true };
  });
}

async function observe(force: boolean, reference: string | null): Promise<{ accounts: ReturnType<typeof publicObservation>[]; refreshed?: string[] }> {
  const initial = await readState();
  const targets = reference ? [resolveAccount(initial, reference)] : initial.accounts.filter((account) => account.enabled);
  if (reference && !targets[0]!.enabled) {
    throw new CliError("account_disabled", `Grok account ${targets[0]!.accountKey} is disabled`, { accountKey: targets[0]!.accountKey }, 3);
  }
  const refreshed: string[] = [];
  for (const target of targets) {
    await withState(async (state) => {
      const account = resolveAccount(state, target.accountKey);
      if (!account.enabled) return { result: null, changed: false };
      const accountChanged = await observeAccount(account, { force });
      if (accountChanged && account.observation.error === null) refreshed.push(account.accountKey);
      return { result: null, changed: accountChanged };
    });
  }
  const finalState = await readState();
  const visible = reference ? [resolveAccount(finalState, targets[0]!.accountKey)] : finalState.accounts;
  const accounts = visible.slice().sort(byOrdinal).map((account) => publicObservation(account));
  return force ? { accounts, refreshed } : { accounts };
}

async function select(args: string[]): Promise<ReturnType<typeof selectAccount>> {
  const accountFlag = takeValueFlag(args, "--account");
  const modeFlag = takeValueFlag(args, "--mode");
  const allowUnknown = removeBooleanFlag(args, "--allow-unknown");
  const dryRun = removeBooleanFlag(args, "--dry-run");
  const secondsRaw = takeValueFlag(args, "--reserve-seconds");
  const positional = args.shift() ?? null;
  ensureNoArguments(args);
  const selectors = Number(accountFlag !== null) + Number(modeFlag !== null) + Number(positional !== null);
  if (selectors > 1) throw new CliError("invalid_argument", "Use only one of a positional strategy, --mode, or --account", undefined, 2);

  let account = accountFlag;
  let mode: Exclude<SelectionMode, "exact"> = "best";
  const requested = modeFlag ?? positional;
  if (requested === "best" || requested === "next-available") mode = requested;
  else if (requested !== null) account = requested;
  if (modeFlag !== null && modeFlag !== "best" && modeFlag !== "next-available") {
    throw new CliError("invalid_argument", "--mode must be best or next-available", undefined, 2);
  }
  const reserveSeconds = secondsRaw === null ? 30 : Number(secondsRaw);
  const options = { mode, account, allowUnknown, dryRun, reserveSeconds };
  if (dryRun) return selectAccount(await readState(), options);
  return withState((state) => ({ result: selectAccount(state, options), changed: true }));
}

async function remove(args: string[]) {
  const reference = requiredPositional(args, "account");
  ensureNoArguments(args);
  return withState((state) => {
    const account = resolveAccount(state, reference);
    state.accounts = state.accounts.filter((candidate) => candidate !== account);
    state.reservations = state.reservations.filter((reservation) => reservation.accountKey !== account.accountKey);
    return { result: { account: publicAccount(account), removed: true }, changed: true };
  });
}

async function alias(args: string[]) {
  const clear = removeBooleanFlag(args, "--clear");
  const reference = requiredPositional(args, "account");
  const aliasRaw = args.shift() ?? null;
  ensureNoArguments(args);
  if (clear === (aliasRaw !== null)) {
    throw new CliError("invalid_argument", "Supply exactly one of a new alias or --clear", undefined, 2);
  }
  const nextAlias = clear ? null : validateAlias(aliasRaw!);
  return withState((state) => {
    const account = resolveAccount(state, reference);
    if (nextAlias !== null) {
      const collision = state.accounts.find((candidate) => candidate !== account && referenceMatches(candidate, nextAlias));
      if (collision) throw new CliError("alias_conflict", `Alias is already used by ${collision.accountKey}`, { accountKey: collision.accountKey }, 2);
    }
    account.alias = nextAlias;
    account.updatedAt = new Date().toISOString();
    return { result: { account: publicAccount(account) }, changed: true };
  });
}

async function setEnabled(args: string[], enabled: boolean) {
  const reference = requiredPositional(args, "account");
  ensureNoArguments(args);
  return withState((state) => {
    const account = resolveAccount(state, reference);
    account.enabled = enabled;
    account.updatedAt = new Date().toISOString();
    if (!enabled) state.reservations = state.reservations.filter((reservation) => reservation.accountKey !== account.accountKey);
    return { result: { account: publicAccount(account) }, changed: true };
  });
}

function emit(name: string, data: unknown): void {
  if (json) process.stdout.write(`${JSON.stringify(success(name, data))}\n`);
  else if (typeof data === "string") process.stdout.write(`${data}\n`);
  else process.stdout.write(`${human(data)}\n`);
}

function human(data: unknown): string {
  if (typeof data !== "object" || data === null) return String(data);
  if ("accounts" in data && Array.isArray(data.accounts)) {
    if (data.accounts.length === 0) return "No Grok accounts.";
    return data.accounts.map((account) => {
      const row = account as Record<string, unknown>;
      const label = row.alias ? `${row.displayName} (${row.alias})` : row.displayName;
      const billing = row.billingStatus ? ` · billing ${row.billingStatus}` : "";
      return `${label} · ${row.enabled ? "enabled" : "disabled"} · auth ${row.authStatus}${billing}`;
    }).join("\n");
  }
  if ("account" in data) {
    const account = (data as { account: { displayName: string; alias: string | null } }).account;
    return account.alias ? `${account.displayName} (${account.alias})` : account.displayName;
  }
  return JSON.stringify(data, null, 2);
}

function commandName(args: string[]): string {
  return args.find((arg) => !arg.startsWith("-")) || "help";
}

function takeValueFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (args.indexOf(flag, index + 1) >= 0) throw new CliError("invalid_argument", `${flag} may be supplied only once`, undefined, 2);
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError("invalid_argument", `${flag} requires a value`, undefined, 2);
  args.splice(index, 2);
  return value;
}

function removeBooleanFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  if (args.indexOf(flag, index + 1) >= 0) throw new CliError("invalid_argument", `${flag} may be supplied only once`, undefined, 2);
  args.splice(index, 1);
  return true;
}

function requiredPositional(args: string[], label: string): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new CliError("invalid_argument", `${label} is required`, undefined, 2);
  return value;
}

function ensureNoArguments(args: string[]): void {
  if (args.length) throw new CliError("invalid_argument", `Unexpected argument ${JSON.stringify(args[0])}`, undefined, 2);
}

function byOrdinal(left: StoredAccount, right: StoredAccount): number {
  return left.ordinal - right.ordinal;
}

function referenceMatches(account: StoredAccount, reference: string): boolean {
  return account.accountKey === reference || account.displayName === reference || account.alias === reference || account.email === reference;
}
