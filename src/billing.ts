import type { AccountObservation, NormalizedBilling, StoredAccount } from "./types.ts";
import { CliError } from "./types.ts";
import { boundedResponseJson, checkedEndpoint, credentialsNeedRefresh, refreshCredentials, XAI_COMPAT_VERSION } from "./oauth.ts";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const FRESH_FOR_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

interface ObserveOptions {
  force: boolean;
  now?: number;
}

export async function observeAccount(account: StoredAccount, options: ObserveOptions): Promise<boolean> {
  const now = options.now ?? Date.now();
  if (!account.enabled) return false;
  if (!options.force && account.observation.nextAttemptAtMs !== null && account.observation.nextAttemptAtMs > now) {
    return false;
  }
  try {
    if (credentialsNeedRefresh(account.credentials, now) || account.observation.error?.code === "auth_unavailable") {
      const refreshed = await refreshCredentials(account.credentials, account.userId);
      account.credentials = refreshed.credentials;
      if (refreshed.email) account.email = refreshed.email;
      account.updatedAt = new Date(now).toISOString();
    }
    const billing = await fetchBilling(account);
    const observedAt = new Date(now).toISOString();
    account.observation = {
      lastGood: { ...billing, observedAt },
      lastAttemptAt: observedAt,
      failureCount: 0,
      nextAttemptAtMs: null,
      error: null,
    };
    account.updatedAt = observedAt;
    return true;
  } catch (error) {
    const previousAuthFailure = account.observation.error?.code === "auth_unavailable";
    const failureCount = account.observation.failureCount + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(10, failureCount - 1));
    account.observation.lastAttemptAt = new Date(now).toISOString();
    account.observation.failureCount = failureCount;
    account.observation.nextAttemptAtMs = now + delay;
    const nextError = observationError(error);
    account.observation.error = previousAuthFailure && nextError.code !== "auth_unavailable"
      ? { code: "auth_unavailable", message: "Account credentials remain unavailable; a recovery cycle has not succeeded" }
      : nextError;
    account.updatedAt = new Date(now).toISOString();
    return true;
  }
}

async function fetchBilling(account: StoredAccount): Promise<NormalizedBilling> {
  const configured = process.env.GROK_SWAP_TEST_BILLING_URL || BILLING_URL;
  let response: Response;
  try {
    response = await fetch(checkedEndpoint(configured, "billing endpoint"), {
      headers: {
        authorization: `Bearer ${account.credentials.accessToken}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-userid": account.userId,
        "x-grok-client-version": XAI_COMPAT_VERSION,
        "x-grok-client-mode": "headless",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError("billing_unavailable", "The xAI billing service could not be reached");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError("auth_unavailable", `xAI rejected the account credentials (HTTP ${response.status})`);
  }
  if (!response.ok) throw new CliError("billing_http_error", `xAI billing request failed (HTTP ${response.status})`);
  const body = await boundedResponseJson(response, "billing_response_invalid", "xAI returned an invalid billing response");
  return normalizeBilling(body);
}

export function normalizeBilling(value: unknown): NormalizedBilling {
  const top = record(value, "billing response");
  const config = nullableRecord(top.config);
  if (!config) throw new CliError("billing_response_invalid", "xAI billing response omitted config");

  const monthlyLimit = cents(config.monthlyLimit);
  const legacyUsed = cents(config.used);
  let usedPercent = finite(config.creditUsagePercent);
  if (usedPercent === null && monthlyLimit !== null && monthlyLimit > 0 && legacyUsed !== null) {
    usedPercent = (legacyUsed / monthlyLimit) * 100;
  }
  if (usedPercent !== null) usedPercent = clamp(usedPercent, 0, 100);
  const remainingPercent = usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);

  const period = nullableRecord(config.currentPeriod);
  const periodType = stringOrNull(period?.type);
  const periodStart = isoOrNull(period?.start) || isoOrNull(config.billingPeriodStart);
  const resetsAt = isoOrNull(period?.end) || isoOrNull(config.billingPeriodEnd);

  const prepaidBalance = cents(config.prepaidBalance);
  const onDemandUsed = cents(config.onDemandUsed);
  const onDemandCap = cents(config.onDemandCap);
  const enabledValue = typeof top.onDemandEnabled === "boolean" ? top.onDemandEnabled : null;
  // The legacy shape has no explicit enable flag. Grok Build treats a
  // positive cap as enabled; `{}` is proto3's zero Cent and must stay false.
  const paygEnabled = enabledValue ?? (onDemandCap !== null ? onDemandCap > 0 : null);

  return {
    included: { usedPercent, remainingPercent, periodType, periodStart, resetsAt },
    prepaid: { balanceUsd: dollars(prepaidBalance) },
    payg: {
      enabled: paygEnabled,
      usedUsd: dollars(onDemandUsed),
      capUsd: dollars(onDemandCap),
      remainingUsd: onDemandCap === null || onDemandUsed === null ? null : dollars(Math.max(0, onDemandCap - onDemandUsed)),
    },
    subscriptionTier: stringOrNull(top.subscriptionTier),
  };
}

export function publicObservation(account: StoredAccount, now = Date.now()): AccountObservation {
  const publicBase = publicAccount(account, now);
  const lastGood = account.observation.lastGood;
  const age = lastGood ? now - Date.parse(lastGood.observedAt) : Infinity;
  const stale = Boolean(lastGood) && (age > FRESH_FOR_MS || account.observation.error !== null);
  const billingStatus = !lastGood ? (account.observation.error ? "error" : "unknown") : stale ? "stale" : "fresh";
  return {
    ...publicBase,
    billingStatus,
    included: lastGood?.included ?? emptyBilling().included,
    prepaid: lastGood?.prepaid ?? emptyBilling().prepaid,
    payg: lastGood?.payg ?? emptyBilling().payg,
    subscriptionTier: lastGood?.subscriptionTier ?? null,
    observedAt: account.observation.lastAttemptAt,
    lastGoodAt: lastGood?.observedAt ?? null,
    stale,
    error: account.observation.error,
  };
}

export function publicAccount(account: StoredAccount, now = Date.now()) {
  const hasAccess = account.credentials.accessToken.length > 0;
  const hasRefresh = account.credentials.refreshToken.length > 0;
  const authStatus = !hasAccess || !hasRefresh
    ? "missing"
    : account.observation.error?.code === "auth_unavailable"
      ? "error"
      : account.credentials.expiresAtMs <= now ? "expired" : "valid";
  return {
    accountKey: account.accountKey,
    displayName: account.displayName,
    ordinal: account.ordinal,
    alias: account.alias,
    email: account.email,
    enabled: account.enabled,
    authStatus,
    expiresAt: Number.isFinite(account.credentials.expiresAtMs) ? new Date(account.credentials.expiresAtMs).toISOString() : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  } as const;
}

function emptyBilling(): NormalizedBilling {
  return {
    included: { usedPercent: null, remainingPercent: null, periodType: null, periodStart: null, resetsAt: null },
    prepaid: { balanceUsd: null },
    payg: { enabled: null, usedUsd: null, capUsd: null, remainingUsd: null },
    subscriptionTier: null,
  };
}

function observationError(error: unknown) {
  return error instanceof CliError
    ? { code: error.code, message: error.message }
    : { code: "observation_failed", message: "Grok usage observation failed" };
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = nullableRecord(value);
  if (!result) throw new CliError("billing_response_invalid", `xAI returned an invalid ${label}`);
  return result;
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cents(value: unknown): number | null {
  const object = nullableRecord(value);
  if (!object) return null;
  if (!("val" in object)) return Object.keys(object).length === 0 ? 0 : null;
  const amount = object.val;
  if (typeof amount === "number" && Number.isFinite(amount)) return amount;
  if (typeof amount === "string" && /^-?\d+$/u.test(amount)) return Number(amount);
  return null;
}

function dollars(value: number | null): number | null {
  return value === null ? null : Math.round(value) / 100;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
