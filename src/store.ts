import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { StoreState, StoredAccount } from "./types.ts";
import { CliError } from "./types.ts";

const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 50;
const DEAD_LOCK_AGE_MS = 5 * 60_000;

export function storeRoot(): string {
  const configured = process.env.GROK_SWAP_HOME;
  if (configured) return resolve(configured);
  const home = process.env.HOME;
  if (!home) throw new CliError("home_unavailable", "HOME is not set", undefined, 1);
  const xdgState = process.env.XDG_STATE_HOME;
  const base = xdgState?.startsWith("/") ? xdgState : join(home, ".local", "state");
  return join(base, "grok-swap");
}

export function statePath(): string {
  return join(storeRoot(), "state.json");
}

function emptyState(): StoreState {
  return { version: 1, nextOrdinal: 1, nextAvailableCursor: null, accounts: [], reservations: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertState(value: unknown): asserts value is StoreState {
  if (
    !isRecord(value) || value.version !== 1 ||
    !Number.isSafeInteger(value.nextOrdinal) || (value.nextOrdinal as number) < 1 ||
    !(value.nextAvailableCursor === null || Number.isSafeInteger(value.nextAvailableCursor)) ||
    !Array.isArray(value.accounts) || !Array.isArray(value.reservations)
  ) {
    throw new CliError("store_corrupt", "The grok-swap state file is invalid; it was not overwritten");
  }
  const keys = new Set<string>();
  const ordinals = new Set<number>();
  const identities = new Set<string>();
  let maximumOrdinal = 0;
  for (const account of value.accounts) {
    if (!isRecord(account)) corrupt("account store");
    const ordinal = account.ordinal;
    const accountKey = account.accountKey;
    const userId = account.userId;
    if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 1 ||
      accountKey !== `grok-${ordinal as number}` || account.displayName !== accountKey ||
      typeof userId !== "string" || userId.length < 1 || userId.length > 1024 || /[\x00-\x1f\x7f]/u.test(userId) ||
      !(account.alias === null || typeof account.alias === "string") ||
      !(account.email === null || typeof account.email === "string") || typeof account.enabled !== "boolean" ||
      !validIso(account.createdAt) || !validIso(account.updatedAt)
    ) corrupt("account store");
    if (keys.has(accountKey as string) || ordinals.has(ordinal as number) || identities.has(userId as string)) corrupt("account identities");
    keys.add(accountKey as string);
    ordinals.add(ordinal as number);
    identities.add(userId as string);
    maximumOrdinal = Math.max(maximumOrdinal, ordinal as number);
    const credentials = account.credentials;
    if (!isRecord(credentials) || typeof credentials.accessToken !== "string" || typeof credentials.refreshToken !== "string" ||
      typeof credentials.issuer !== "string" || typeof credentials.clientId !== "string" ||
      typeof credentials.expiresAtMs !== "number" || !Number.isFinite(credentials.expiresAtMs)) corrupt("credential store");
    assertObservation(account.observation);
  }
  if ((value.nextOrdinal as number) <= maximumOrdinal) corrupt("next account ordinal");
  const reservationIds = new Set<string>();
  for (const reservation of value.reservations) {
    if (!isRecord(reservation) || typeof reservation.id !== "string" || typeof reservation.accountKey !== "string" ||
      typeof reservation.createdAtMs !== "number" || !Number.isFinite(reservation.createdAtMs) ||
      typeof reservation.expiresAtMs !== "number" || !Number.isFinite(reservation.expiresAtMs) ||
      reservation.expiresAtMs <= reservation.createdAtMs) corrupt("reservation store");
    if (!keys.has(reservation.accountKey) || reservationIds.has(reservation.id)) corrupt("reservation identities");
    reservationIds.add(reservation.id);
  }
}

function assertObservation(value: unknown): void {
  if (!isRecord(value) || !(value.lastAttemptAt === null || validIso(value.lastAttemptAt)) ||
    typeof value.failureCount !== "number" || !Number.isSafeInteger(value.failureCount) || value.failureCount < 0 ||
    !(value.nextAttemptAtMs === null || (typeof value.nextAttemptAtMs === "number" && Number.isFinite(value.nextAttemptAtMs))) ||
    !(value.error === null || (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"))) {
    corrupt("observation store");
  }
  if (value.lastGood === null) return;
  if (!isRecord(value.lastGood) || !validIso(value.lastGood.observedAt) ||
    !isRecord(value.lastGood.included) || !nullableNumber(value.lastGood.included.usedPercent) || !nullableNumber(value.lastGood.included.remainingPercent) ||
    !nullableString(value.lastGood.included.periodType) || !nullableString(value.lastGood.included.periodStart) || !nullableString(value.lastGood.included.resetsAt) ||
    !isRecord(value.lastGood.prepaid) || !nullableNumber(value.lastGood.prepaid.balanceUsd) ||
    !isRecord(value.lastGood.payg) || !(value.lastGood.payg.enabled === null || typeof value.lastGood.payg.enabled === "boolean") ||
    !nullableNumber(value.lastGood.payg.usedUsd) || !nullableNumber(value.lastGood.payg.capUsd) || !nullableNumber(value.lastGood.payg.remainingUsd) ||
    !nullableString(value.lastGood.subscriptionTier)) corrupt("last-good observation");
}

function nullableNumber(value: unknown): boolean { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function validIso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function corrupt(label: string): never { throw new CliError("store_corrupt", `The grok-swap ${label} is invalid; it was not overwritten`); }

async function secureRoot(): Promise<void> {
  const root = storeRoot();
  await validateExistingComponents(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await validateExistingComponents(root);
  const rootStat = await lstat(root);
  assertSecureRoot(rootStat);
  await chmod(root, 0o700);
}

function assertSecureRoot(rootStat: Stats): void {
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CliError("store_unsafe", "The grok-swap state root must be a real directory, not a symlink");
  }
  if (process.getuid && rootStat.uid !== process.getuid()) throw new CliError("store_unsafe", "The grok-swap state root has a foreign owner");
  if ((rootStat.mode & 0o077) !== 0) throw new CliError("store_unsafe", "The grok-swap state root is not owner-only (expected mode 0700)");
}

async function validateExistingComponents(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new CliError("store_unsafe", "The grok-swap state root must be absolute");
  const parts = path.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let metadata;
    try { metadata = await lstat(current); } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw new CliError("store_unsafe", "A grok-swap state path component could not be inspected");
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current).catch(() => "");
      const darwinAlias = process.platform === "darwin" &&
        ((current === "/var" && (target === "private/var" || target === "/private/var")) ||
          (current === "/tmp" && (target === "private/tmp" || target === "/private/tmp")));
      if (darwinAlias) continue;
      throw new CliError("store_unsafe", `The grok-swap state path contains a symlink: ${current}`);
    }
    if (!metadata.isDirectory()) throw new CliError("store_unsafe", `The grok-swap state path contains a non-directory: ${current}`);
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid) {
      throw new CliError("store_unsafe", `The grok-swap state path has a foreign owner: ${current}`);
    }
    const worldWritable = (metadata.mode & 0o002) !== 0;
    const sticky = (metadata.mode & 0o1000) !== 0;
    if (worldWritable && !sticky) throw new CliError("store_unsafe", `The grok-swap state path is unsafely writable: ${current}`);
  }
}

async function readStateUnlocked(): Promise<StoreState> {
  try {
    const path = statePath();
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new CliError("store_unsafe", "The grok-swap state path is not a regular file");
    }
    if (process.getuid && fileStat.uid !== process.getuid()) throw new CliError("store_unsafe", "The grok-swap state file has a foreign owner");
    if (fileStat.nlink !== 1) throw new CliError("store_unsafe", "The grok-swap state file must not be hardlinked");
    if ((fileStat.mode & 0o077) !== 0) throw new CliError("store_unsafe", "The grok-swap state file is not owner-only (expected mode 0600)");
    if (fileStat.size > 10_000_000) throw new CliError("store_corrupt", "The grok-swap state file is too large; it was not overwritten");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    assertState(parsed);
    return parsed;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState();
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) {
      throw new CliError("store_corrupt", "The grok-swap state file contains invalid JSON; it was not overwritten");
    }
    throw new CliError("store_unavailable", "The grok-swap state file could not be read");
  }
}

export async function readState(): Promise<StoreState> {
  const root = storeRoot();
  await validateExistingComponents(root);
  try {
    assertSecureRoot(await lstat(root));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState();
    throw error;
  }
  return readStateUnlocked();
}

async function writeStateUnlocked(state: StoreState): Promise<void> {
  const path = statePath();
  const temp = join(dirname(path), `.state.json.tmp.${process.pid}.${crypto.randomUUID()}`);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new CliError("store_unavailable", "The grok-swap state file could not be written");
  }
}

interface LockInfo { pid: number; createdAtMs: number }

async function acquireLock(): Promise<() => Promise<void>> {
  await secureRoot();
  const lockPath = join(storeRoot(), ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), {
        mode: 0o600,
        flag: "wx",
      });
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new CliError("store_lock_failed", "Could not acquire the grok-swap state lock");
      }
      const lockStat = await lstat(lockPath).catch(() => null);
      if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isDirectory())) {
        throw new CliError("store_unsafe", "The grok-swap lock path is unsafe");
      }
      if (lockStat && process.getuid && lockStat.uid !== process.getuid()) throw new CliError("store_unsafe", "The grok-swap lock has a foreign owner");
      if (await lockIsDead(lockPath)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError("store_busy", "Another grok-swap process still holds the state lock");
      }
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
}

async function lockIsDead(lockPath: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockInfo;
    if (!Number.isInteger(raw.pid) || !Number.isFinite(raw.createdAtMs)) return false;
    try {
      process.kill(raw.pid, 0);
      return false;
    } catch (error) {
      if (isNodeError(error, "EPERM")) return false;
      return Date.now() - raw.createdAtMs > DEAD_LOCK_AGE_MS;
    }
  } catch {
    try {
      const lockStat = await lstat(lockPath);
      return Date.now() - lockStat.mtimeMs > DEAD_LOCK_AGE_MS;
    } catch {
      return false;
    }
  }
}

export async function withState<T>(operation: (state: StoreState) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T> {
  const release = await acquireLock();
  try {
    const state = await readStateUnlocked();
    const { result, changed } = await operation(state);
    if (changed) await writeStateUnlocked(state);
    return result;
  } finally {
    await release();
  }
}

export function resolveAccount(state: StoreState, reference: string): StoredAccount {
  const exact = state.accounts.filter((account) =>
    account.accountKey === reference || account.displayName === reference || account.alias === reference || account.email === reference
  );
  if (exact.length === 0) {
    throw new CliError("account_not_found", `No Grok account matches ${JSON.stringify(reference)}`, { accountKey: reference }, 2);
  }
  if (exact.length > 1) {
    throw new CliError("account_ambiguous", `More than one Grok account matches ${JSON.stringify(reference)}`, {
      accountKey: reference,
      matches: exact.map((account) => account.accountKey),
    }, 2);
  }
  return exact[0]!;
}

export function validateAlias(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length < 1 || trimmed.length > 80 || /[\x00-\x1f\x7f]/u.test(trimmed)) {
    throw new CliError("invalid_alias", "Alias must be 1-80 characters without control characters", undefined, 2);
  }
  return trimmed;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
