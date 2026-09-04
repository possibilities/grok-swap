export const SCHEMA_VERSION = 1 as const;

export type AuthStatus = "valid" | "expired" | "missing" | "error";
export type BillingStatus = "fresh" | "stale" | "unknown" | "error";
export type SelectionTier = "included" | "prepaid" | "payg" | "unknown";

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  issuer: string;
  clientId: string;
}

export interface NormalizedBilling {
  included: {
    usedPercent: number | null;
    remainingPercent: number | null;
    periodType: string | null;
    periodStart: string | null;
    resetsAt: string | null;
  };
  prepaid: { balanceUsd: number | null };
  payg: {
    enabled: boolean | null;
    usedUsd: number | null;
    capUsd: number | null;
    remainingUsd: number | null;
  };
  subscriptionTier: string | null;
}

export interface ObservationError {
  code: string;
  message: string;
}

export interface StoredObservation {
  lastGood: (NormalizedBilling & { observedAt: string }) | null;
  lastAttemptAt: string | null;
  failureCount: number;
  nextAttemptAtMs: number | null;
  error: ObservationError | null;
}

export interface StoredAccount {
  accountKey: string;
  displayName: string;
  ordinal: number;
  alias: string | null;
  email: string | null;
  userId: string;
  enabled: boolean;
  credentials: Credentials;
  observation: StoredObservation;
  createdAt: string;
  updatedAt: string;
}

export interface Reservation {
  id: string;
  accountKey: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface StoreState {
  version: 1;
  nextOrdinal: number;
  nextAvailableCursor: number | null;
  accounts: StoredAccount[];
  reservations: Reservation[];
}

export interface PublicAccount {
  accountKey: string;
  displayName: string;
  ordinal: number;
  alias: string | null;
  email: string | null;
  enabled: boolean;
  authStatus: AuthStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountObservation extends PublicAccount {
  billingStatus: BillingStatus;
  included: NormalizedBilling["included"];
  prepaid: NormalizedBilling["prepaid"];
  payg: NormalizedBilling["payg"];
  subscriptionTier: string | null;
  observedAt: string | null;
  lastGoodAt: string | null;
  stale: boolean;
  error: ObservationError | null;
}

export interface SuccessEnvelope<T> {
  schema_version: typeof SCHEMA_VERSION;
  ok: true;
  command: string;
  provider: "grok";
  generatedAt: string;
  data: T;
  error: null;
}

export interface FailureEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  ok: false;
  command: string;
  provider: "grok";
  generatedAt: string;
  data: null;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function success<T>(command: string, data: T): SuccessEnvelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    provider: "grok",
    generatedAt: new Date().toISOString(),
    data,
    error: null,
  };
}

export function failure(command: string, error: CliError): FailureEnvelope {
  const base: FailureEnvelope = {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    provider: "grok",
    generatedAt: new Date().toISOString(),
    data: null,
    error: { code: error.code, message: error.message },
  };
  if (error.details !== undefined) base.error.details = error.details;
  return base;
}
