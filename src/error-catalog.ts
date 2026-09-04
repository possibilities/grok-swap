export interface ErrorCatalogEntry {
  code: string;
  meaning: string;
  recovery?: string;
}

// Canonical public vocabulary for ok:false envelopes. Observation-only
// failures also appear inside an account's error field while the command can
// still return ok:true with last-good data.
export const ERROR_CODES: readonly ErrorCatalogEntry[] = [
  { code: "account_ambiguous", meaning: "An alias or email resolves to multiple accounts.", recovery: "Use the immutable accountKey." },
  { code: "account_disabled", meaning: "The requested account is disabled.", recovery: "Enable it explicitly or select another account." },
  { code: "account_exhausted", meaning: "Known included and applicable paid capacity are exhausted.", recovery: "Select another account or wait for reset." },
  { code: "account_exists", meaning: "The authenticated xAI identity is already stored.", recovery: "Use the existing immutable accountKey." },
  { code: "account_not_found", meaning: "No account matches the exact reference.", recovery: "Call list and use an accountKey." },
  { code: "account_reserved", meaning: "The requested account has a live short reservation.", recovery: "Wait for expiry or select another account." },
  { code: "alias_conflict", meaning: "The alias collides with another stable reference." },
  { code: "auth_unavailable", meaning: "The account has no currently valid session or xAI rejected it during billing observation.", recovery: "Force a refresh; sign in again if credential rotation also fails." },
  { code: "billing_http_error", meaning: "The billing endpoint returned an error status.", recovery: "Retain last-good data and retry after backoff." },
  { code: "billing_response_invalid", meaning: "The billing response was invalid or oversized." },
  { code: "billing_unavailable", meaning: "The billing endpoint could not be reached.", recovery: "Retain last-good data and retry after backoff." },
  { code: "endpoint_invalid", meaning: "A configured or stored service endpoint failed the HTTPS boundary." },
  { code: "home_unavailable", meaning: "No default state directory can be resolved because HOME is absent." },
  { code: "internal_error", meaning: "An unexpected error was redacted at the CLI boundary." },
  { code: "invalid_alias", meaning: "An alias is empty, too long, or contains control characters." },
  { code: "invalid_argument", meaning: "The invocation violates the command contract." },
  { code: "no_eligible_account", meaning: "Every account was rejected; details carries per-account reasons." },
  { code: "oauth_access_denied", meaning: "The human denied device authorization." },
  { code: "oauth_device_expired", meaning: "Device authorization expired." },
  { code: "oauth_device_request_failed", meaning: "The device authorization request failed or returned an invalid response." },
  { code: "oauth_device_response_invalid", meaning: "Device authorization returned unsafe or incomplete fields." },
  { code: "oauth_identity_changed", meaning: "A refresh resolved to another identity and was discarded.", recovery: "Sign in again; existing credentials were retained." },
  { code: "oauth_no_refresh_token", meaning: "OAuth did not issue an offline refresh token." },
  { code: "oauth_refresh_failed", meaning: "The refresh grant failed without exposing upstream response data.", recovery: "Sign in again if a later retry also fails." },
  { code: "oauth_token_exchange_failed", meaning: "The device token exchange failed." },
  { code: "oauth_token_response_invalid", meaning: "An OAuth token response omitted required fields." },
  { code: "oauth_userinfo_failed", meaning: "The authenticated identity lookup failed." },
  { code: "oauth_userinfo_invalid", meaning: "The authenticated identity response was unsafe or incomplete." },
  { code: "observation_failed", meaning: "An unexpected per-account observation failure was redacted while last-good data was retained." },
  { code: "store_busy", meaning: "Another process held the mutation lock past the wait bound." },
  { code: "store_corrupt", meaning: "Stored JSON failed validation and was not overwritten." },
  { code: "store_lock_failed", meaning: "The private mutation lock could not be acquired." },
  { code: "store_unavailable", meaning: "Private state could not be read or atomically written." },
  { code: "store_unsafe", meaning: "A state path or permission check failed closed." },
  { code: "unknown_command", meaning: "The command name is not supported." },
  { code: "usage_unknown", meaning: "No complete billing observation recent enough for a decision.", recovery: "Refresh usage or pass --allow-unknown explicitly." },
] as const;
