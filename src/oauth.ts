import type { Credentials } from "./types.ts";
import { CliError } from "./types.ts";

export const XAI_ISSUER = "https://auth.x.ai";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// Fx proves these six scopes are sufficient for its Grok account session. We
// intentionally omit Grok Build's conversation/workspace scopes: this tool
// observes billing and never acts as a conversation harness.
export const XAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
] as const;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// cli-chat-proxy version-gates this header as Grok Build semver. This is the
// current compatibility floor observed in xai-grok-version, not our version.
export const XAI_COMPAT_VERSION = "1.0.16";
const CLIENT_VERSION = XAI_COMPAT_VERSION;

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

export interface LoginResult {
  credentials: Credentials;
  userId: string;
  email: string | null;
}

export interface LoginOptions {
  openBrowser: boolean;
  onPrompt: (prompt: { verificationUri: string; userCode: string; expiresIn: number }) => void;
}

export function oauthIssuer(): string {
  return checkedEndpoint(process.env.GROK_SWAP_TEST_OAUTH_ISSUER || XAI_ISSUER, "OAuth issuer").replace(/\/$/u, "");
}

function tokenEndpoint(issuer: string): string {
  return `${issuer}/oauth2/token`;
}

function userInfoEndpoint(issuer: string): string {
  return process.env.GROK_SWAP_TEST_USERINFO_URL
    ? checkedEndpoint(process.env.GROK_SWAP_TEST_USERINFO_URL, "userinfo endpoint")
    : `${issuer}/oauth2/userinfo`;
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const issuer = oauthIssuer();
  const device = await requestDeviceCode(issuer);
  options.onPrompt({
    verificationUri: device.verificationUri,
    userCode: device.userCode,
    expiresIn: device.expiresIn,
  });
  if (options.openBrowser) {
    const openTarget = device.verificationUriComplete || device.verificationUri;
    void openBrowser(openTarget);
  }
  const token = await pollDeviceToken(issuer, device);
  if (!token.refreshToken) {
    throw new CliError("oauth_no_refresh_token", "xAI did not issue an offline refresh token; the account was not saved");
  }
  const identity = await fetchIdentity(issuer, token.accessToken);
  return {
    credentials: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAtMs: Date.now() + token.expiresIn * 1000,
      issuer,
      clientId: XAI_CLIENT_ID,
    },
    userId: identity.userId,
    email: identity.email,
  };
}

async function requestDeviceCode(issuer: string): Promise<DeviceCode> {
  const response = await boundedFetch(`${issuer}/oauth2/device/code`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-grok-client-version": CLIENT_VERSION,
      "x-grok-client-surface": "cli",
    },
    body: new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPES.join(" "),
      referrer: "grok-build",
    }),
  }, 15_000, "oauth_device_request_failed");
  const body = await boundedResponseJson(response, "oauth_device_request_failed", "xAI returned an invalid response");
  if (!response.ok) throw oauthResponseError("oauth_device_request_failed", "xAI rejected the device authorization request", body);
  const deviceCode = requiredString(body, "device_code", "oauth_device_response_invalid");
  const userCode = requiredString(body, "user_code", "oauth_device_response_invalid");
  if (!/^[A-Za-z0-9-]+$/u.test(userCode)) {
    throw new CliError("oauth_device_response_invalid", "xAI returned an invalid device user code");
  }
  const verificationUri = verificationUrl(requiredString(body, "verification_uri", "oauth_device_response_invalid"));
  const completeRaw = optionalString(body, "verification_uri_complete");
  const expiresIn = positiveNumber(body, "expires_in", "oauth_device_response_invalid");
  const intervalRaw = optionalNumber(body, "interval");
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: completeRaw ? verificationUrl(completeRaw) : null,
    expiresIn,
    interval: Math.max(1, Math.trunc(intervalRaw ?? 5)),
  };
}

async function pollDeviceToken(issuer: string, device: DeviceCode): Promise<TokenSet> {
  let intervalMs = device.interval * 1000;
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(intervalMs);
    if (Date.now() >= deadline) break;
    const response = await boundedFetch(tokenEndpoint(issuer), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-grok-client-version": CLIENT_VERSION,
        "x-grok-client-surface": "cli",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: XAI_CLIENT_ID,
      }),
    }, 15_000, "oauth_token_exchange_failed");
    const body = await boundedResponseJson(response, "oauth_token_exchange_failed", "xAI returned an invalid response");
    if (response.ok) return parseTokenSet(body, true);
    const errorCode = optionalString(body, "error");
    if (errorCode === "authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (errorCode === "access_denied") {
      throw new CliError("oauth_access_denied", "The xAI authorization request was denied", undefined, 2);
    }
    if (errorCode === "expired_token") {
      throw new CliError("oauth_device_expired", "The xAI device code expired before authorization completed", undefined, 2);
    }
    throw oauthResponseError("oauth_token_exchange_failed", "xAI rejected the token exchange", body);
  }
  throw new CliError("oauth_device_expired", "The xAI device code expired before authorization completed", undefined, 2);
}

export async function refreshCredentials(credentials: Credentials, expectedUserId: string): Promise<{ credentials: Credentials; email: string | null }> {
  const issuer = checkedEndpoint(credentials.issuer, "stored OAuth issuer").replace(/\/$/u, "");
  if (credentials.clientId !== XAI_CLIENT_ID) {
    throw new CliError("auth_unavailable", "The stored OAuth client is not supported; sign in again");
  }
  const response = await boundedFetch(tokenEndpoint(issuer), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-grok-client-version": CLIENT_VERSION,
      "x-grok-client-surface": "headless",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
    }),
  }, 15_000, "oauth_refresh_failed");
  const body = await boundedResponseJson(response, "oauth_refresh_failed", "xAI returned an invalid response");
  if (!response.ok) throw oauthResponseError("oauth_refresh_failed", "xAI rejected the credential refresh", body);
  const token = parseTokenSet(body, false);
  const identity = await fetchIdentity(issuer, token.accessToken);
  if (identity.userId !== expectedUserId) {
    throw new CliError("oauth_identity_changed", "Refreshed credentials resolved to a different xAI account; the rotation was discarded");
  }
  return {
    credentials: {
      ...credentials,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || credentials.refreshToken,
      expiresAtMs: Date.now() + token.expiresIn * 1000,
    },
    email: identity.email,
  };
}

export function credentialsNeedRefresh(credentials: Credentials, now = Date.now()): boolean {
  return credentials.expiresAtMs <= now + 5 * 60_000;
}

async function fetchIdentity(issuer: string, accessToken: string): Promise<{ userId: string; email: string | null }> {
  const response = await boundedFetch(userInfoEndpoint(issuer), {
    headers: { authorization: `Bearer ${accessToken}`, "x-grok-client-version": CLIENT_VERSION },
  }, 10_000, "oauth_userinfo_failed");
  const body = await boundedResponseJson(response, "oauth_userinfo_failed", "xAI returned an invalid response");
  if (!response.ok) throw new CliError("oauth_userinfo_failed", "xAI rejected the authenticated identity lookup");
  const userId = requiredString(body, "sub", "oauth_userinfo_invalid");
  if (userId.length > 1024 || /[\x00-\x1f\x7f]/u.test(userId)) {
    throw new CliError("oauth_userinfo_invalid", "xAI returned an unsafe account identity");
  }
  return { userId, email: optionalString(body, "email") };
}

function parseTokenSet(body: Record<string, unknown>, requireRefresh: boolean): TokenSet {
  const accessToken = requiredString(body, "access_token", "oauth_token_response_invalid");
  const refreshToken = optionalString(body, "refresh_token");
  if (requireRefresh && !refreshToken) {
    throw new CliError("oauth_no_refresh_token", "xAI did not return a refresh token");
  }
  const expiresIn = positiveNumber(body, "expires_in", "oauth_token_response_invalid");
  return { accessToken, refreshToken, expiresIn };
}

async function openBrowser(url: string): Promise<void> {
  try {
    const child = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    await child.exited;
  } catch {
    // The URL and code have already been printed; browser launch is best effort.
  }
}

function verificationUrl(value: string): string {
  const url = new URL(value);
  const isFixture = process.env.GROK_SWAP_TEST_ALLOW_HTTP === "1" &&
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const trustedHost = url.protocol === "https:" && (url.hostname === "auth.x.ai" || url.hostname === "accounts.x.ai");
  if (!isFixture && !trustedHost) {
    throw new CliError("oauth_device_response_invalid", "xAI returned an untrusted verification URL");
  }
  return url.toString();
}

export function checkedEndpoint(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError("endpoint_invalid", `${label} is not a valid URL`); }
  if (url.username || url.password) throw new CliError("endpoint_invalid", `${label} must not contain credentials`);
  const fixtureHttp = process.env.GROK_SWAP_TEST_ALLOW_HTTP === "1" && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !fixtureHttp) throw new CliError("endpoint_invalid", `${label} must use HTTPS`);
  return url.toString().replace(/\/$/u, "");
}

async function boundedFetch(url: string, init: RequestInit, timeoutMs: number, code: string): Promise<Response> {
  try {
    return await fetch(checkedEndpoint(url, "xAI endpoint"), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new CliError(code, "The xAI authentication service could not be reached");
  }
}

export async function boundedResponseJson(response: Response, code: string, invalidMessage: string): Promise<Record<string, unknown>> {
  const maximumBytes = 1_000_000;
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > maximumBytes) throw new CliError(code, "xAI returned an oversized response");
  if (!response.body) throw new CliError(code, invalidMessage);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CliError(code, "xAI returned an oversized response");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new CliError(code, invalidMessage); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(code, invalidMessage);
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string, code: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new CliError(code, `xAI response omitted ${key}`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(body: Record<string, unknown>, key: string, code: string): number {
  const value = optionalNumber(body, key);
  if (value === null || value <= 0) throw new CliError(code, `xAI response omitted ${key}`);
  return value;
}

function oauthResponseError(code: string, fallback: string, body: Record<string, unknown>): CliError {
  const oauthCode = optionalString(body, "error");
  // Deliberately do not forward error_description or the raw body. Some IdPs
  // reflect request data, and this boundary must never put a token in output.
  return new CliError(code, oauthCode ? `${fallback} (${oauthCode})` : fallback);
}
