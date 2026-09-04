import { publicAccount } from "./billing.ts";
import type { Reservation, SelectionTier, StoreState, StoredAccount } from "./types.ts";
import { CliError } from "./types.ts";
import { resolveAccount } from "./store.ts";

const MAX_DECISION_AGE_MS = 24 * 60 * 60_000;

export type SelectionMode = "best" | "next-available" | "exact";

export interface SelectOptions {
  mode: "best" | "next-available";
  account: string | null;
  allowUnknown: boolean;
  dryRun: boolean;
  reserveSeconds: number;
  now?: number;
}

interface Candidate {
  account: StoredAccount;
  tier: SelectionTier;
  remainingIncludedPercent: number | null;
  remainingDollars: number | null;
  tierRank: number;
  reason: string;
}

export interface SelectionResult {
  mode: SelectionMode;
  account: ReturnType<typeof publicAccount>;
  reason: string;
  score: {
    tier: SelectionTier;
    remainingIncludedPercent: number | null;
    remainingDollars: number | null;
  };
  dryRun: boolean;
  reservation: { id: string; createdAt: string; expiresAt: string } | null;
}

export function selectAccount(state: StoreState, options: SelectOptions): SelectionResult {
  const now = options.now ?? Date.now();
  validateReservationSeconds(options.reserveSeconds);
  const activeReservations = state.reservations.filter((item) => item.expiresAtMs > now);
  const reservations = new Set(activeReservations.map((item) => item.accountKey));
  let selectionMode: SelectionMode = options.account ? "exact" : options.mode;
  let chosen: Candidate;

  if (options.account) {
    const account = resolveAccount(state, options.account);
    chosen = candidateFor(account, reservations, options.allowUnknown, now, true);
  } else {
    const candidates: Candidate[] = [];
    const rejected: Array<{ accountKey: string; reason: string }> = [];
    for (const account of state.accounts) {
      try {
        candidates.push(candidateFor(account, reservations, options.allowUnknown, now, false));
      } catch (error) {
        rejected.push({ accountKey: account.accountKey, reason: error instanceof CliError ? error.code : "ineligible" });
      }
    }
    if (candidates.length === 0) {
      throw new CliError("no_eligible_account", "No Grok account is currently eligible for selection", { candidates: rejected }, 3);
    }
    if (options.mode === "next-available") {
      candidates.sort((left, right) => left.account.ordinal - right.account.ordinal);
      const cursor = state.nextAvailableCursor;
      chosen = candidates.find((candidate) => cursor === null || candidate.account.ordinal > cursor) ?? candidates[0]!;
    } else {
      candidates.sort(compareCandidates);
      chosen = candidates[0]!;
    }
  }

  let reservation: SelectionResult["reservation"] = null;
  if (!options.dryRun) {
    state.reservations = activeReservations;
    const stored: Reservation = {
      id: crypto.randomUUID(),
      accountKey: chosen.account.accountKey,
      createdAtMs: now,
      expiresAtMs: now + options.reserveSeconds * 1000,
    };
    state.reservations.push(stored);
    state.nextAvailableCursor = chosen.account.ordinal;
    reservation = {
      id: stored.id,
      createdAt: new Date(stored.createdAtMs).toISOString(),
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
    };
  }

  return {
    mode: selectionMode,
    account: publicAccount(chosen.account, now),
    reason: chosen.reason,
    score: {
      tier: chosen.tier,
      remainingIncludedPercent: chosen.remainingIncludedPercent,
      remainingDollars: chosen.remainingDollars,
    },
    dryRun: options.dryRun,
    reservation,
  };
}

function candidateFor(account: StoredAccount, reservations: Set<string>, allowUnknown: boolean, now: number, exact: boolean): Candidate {
  const detail = { accountKey: account.accountKey };
  if (!account.enabled) throw new CliError("account_disabled", `Grok account ${account.accountKey} is disabled`, detail, exact ? 3 : 1);
  if (account.observation.error?.code === "auth_unavailable") {
    throw new CliError("auth_unavailable", `Grok account ${account.accountKey} was rejected by the billing service`, detail, exact ? 3 : 1);
  }
  if (!account.credentials.accessToken || !account.credentials.refreshToken || account.credentials.expiresAtMs <= now) {
    throw new CliError("auth_unavailable", `Grok account ${account.accountKey} does not have a currently valid session`, detail, exact ? 3 : 1);
  }
  if (reservations.has(account.accountKey)) {
    throw new CliError("account_reserved", `Grok account ${account.accountKey} is temporarily reserved`, detail, exact ? 3 : 1);
  }
  const billing = account.observation.lastGood;
  const age = billing ? now - Date.parse(billing.observedAt) : Infinity;
  if (!billing || !Number.isFinite(age) || age > MAX_DECISION_AGE_MS) {
    if (!allowUnknown) {
      throw new CliError("usage_unknown", `Grok account ${account.accountKey} has no decision-grade usage observation`, detail, exact ? 3 : 1);
    }
    return {
      account,
      tier: "unknown",
      remainingIncludedPercent: null,
      remainingDollars: null,
      tierRank: 3,
      reason: "Usage is unknown; selected only because --allow-unknown was explicit",
    };
  }
  const included = billing.included.remainingPercent;
  if (included === null) {
    if (allowUnknown) {
      return {
        account,
        tier: "unknown",
        remainingIncludedPercent: null,
        remainingDollars: null,
        tierRank: 3,
        reason: "Included capacity is unknown; selected only because --allow-unknown was explicit",
      };
    }
    throw new CliError("usage_unknown", `Grok account ${account.accountKey} has incomplete included-capacity data`, detail, exact ? 3 : 1);
  }
  if (included !== null && included > 0) {
    return {
      account,
      tier: "included",
      remainingIncludedPercent: included,
      remainingDollars: null,
      tierRank: 0,
      reason: `${format(included)}% of the included allowance remains`,
    };
  }
  const prepaid = billing.prepaid.balanceUsd;
  if (prepaid !== null && prepaid > 0) {
    return {
      account,
      tier: "prepaid",
      remainingIncludedPercent: included,
      remainingDollars: prepaid,
      tierRank: 1,
      reason: `Included allowance is exhausted; $${format(prepaid)} prepaid remains`,
    };
  }
  const paygRemaining = billing.payg.remainingUsd;
  const paygCapIncomplete = billing.payg.enabled === true && billing.payg.capUsd !== null && billing.payg.usedUsd === null;
  if (paygCapIncomplete) {
    if (allowUnknown) {
      return {
        account,
        tier: "unknown",
        remainingIncludedPercent: included,
        remainingDollars: null,
        tierRank: 3,
        reason: "PAYG cap usage is incomplete; selected only because --allow-unknown was explicit",
      };
    }
    throw new CliError("usage_unknown", `Grok account ${account.accountKey} has incomplete PAYG cap data`, detail, exact ? 3 : 1);
  }
  if (billing.payg.enabled === true && (billing.payg.capUsd === null || (paygRemaining !== null && paygRemaining > 0))) {
    return {
      account,
      tier: "payg",
      remainingIncludedPercent: included,
      remainingDollars: paygRemaining,
      tierRank: 2,
      reason: paygRemaining === null
        ? "Included allowance is exhausted; pay-as-you-go is enabled"
        : `Included allowance is exhausted; $${format(paygRemaining)} PAYG cap remains`,
    };
  }
  const capacityUnknown = billing.prepaid.balanceUsd === null || billing.payg.enabled === null;
  if (capacityUnknown) {
    if (allowUnknown) {
      return {
        account,
        tier: "unknown",
        remainingIncludedPercent: included,
        remainingDollars: null,
        tierRank: 3,
        reason: "Capacity is incomplete; selected only because --allow-unknown was explicit",
      };
    }
    throw new CliError("usage_unknown", `Grok account ${account.accountKey} has incomplete capacity data`, detail, exact ? 3 : 1);
  }
  throw new CliError("account_exhausted", `Grok account ${account.accountKey} has no remaining included or paid capacity`, detail, exact ? 3 : 1);
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.tierRank - right.tierRank ||
    (right.remainingIncludedPercent ?? -1) - (left.remainingIncludedPercent ?? -1) ||
    (right.remainingDollars ?? -1) - (left.remainingDollars ?? -1) ||
    left.account.ordinal - right.account.ordinal;
}

function validateReservationSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300) {
    throw new CliError("invalid_argument", "--reserve-seconds must be an integer from 1 through 300", undefined, 2);
  }
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}
