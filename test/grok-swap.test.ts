import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeBilling, observeAccount, publicObservation } from "../src/billing.ts";
import { boundedResponseJson, refreshCredentials } from "../src/oauth.ts";
import { selectAccount } from "../src/select.ts";
import { withState } from "../src/store.ts";
import type { NormalizedBilling, StoreState, StoredAccount } from "../src/types.ts";
import { CliError } from "../src/types.ts";
import { ERROR_CODES } from "../src/error-catalog.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function billing(overrides: Partial<NormalizedBilling> = {}): NormalizedBilling {
  return {
    included: { usedPercent: 25, remainingPercent: 75, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodStart: "2026-09-01T00:00:00.000Z", resetsAt: "2026-09-08T00:00:00.000Z" },
    prepaid: { balanceUsd: 0 },
    payg: { enabled: false, usedUsd: 0, capUsd: 0, remainingUsd: 0 },
    subscriptionTier: "SuperGrok",
    ...overrides,
  };
}

function account(ordinal: number, observed: NormalizedBilling | null = billing(), now = Date.now()): StoredAccount {
  const key = `grok-${ordinal}`;
  return {
    accountKey: key,
    displayName: key,
    ordinal,
    alias: null,
    email: `user${ordinal}@example.test`,
    userId: `acct_${ordinal}`,
    enabled: true,
    credentials: {
      accessToken: `access-${ordinal}`,
      refreshToken: `refresh-${ordinal}`,
      expiresAtMs: now + 60 * 60_000,
      issuer: "https://auth.x.ai",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    },
    observation: {
      lastGood: observed ? { ...observed, observedAt: new Date(now).toISOString() } : null,
      lastAttemptAt: observed ? new Date(now).toISOString() : null,
      failureCount: 0,
      nextAttemptAtMs: null,
      error: null,
    },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

function state(accounts: StoredAccount[]): StoreState {
  return { version: 1, nextOrdinal: accounts.length + 1, nextAvailableCursor: null, accounts, reservations: [] };
}

describe("billing normalization", () => {
  test("normalizes modern cents, period, and PAYG fields", () => {
    expect(normalizeBilling({
      config: {
        creditUsagePercent: 37.5,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z" },
        prepaidBalance: { val: 1234 },
        onDemandUsed: { val: 250 },
        onDemandCap: { val: 1000 },
      },
      onDemandEnabled: true,
      subscriptionTier: "SuperGrok Heavy",
    })).toEqual({
      included: {
        usedPercent: 37.5,
        remainingPercent: 62.5,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodStart: "2026-09-01T00:00:00.000Z",
        resetsAt: "2026-09-08T00:00:00.000Z",
      },
      prepaid: { balanceUsd: 12.34 },
      payg: { enabled: true, usedUsd: 2.5, capUsd: 10, remainingUsd: 7.5 },
      subscriptionTier: "SuperGrok Heavy",
    });
  });

  test("supports tested legacy allowance fields and proto zero cents", () => {
    const result = normalizeBilling({
      config: {
        monthlyLimit: { val: 2000 }, used: { val: 500 }, prepaidBalance: {},
        billingPeriodStart: "2026-09-01T00:00:00Z", billingPeriodEnd: "2026-10-01T00:00:00Z",
      },
    });
    expect(result.included.usedPercent).toBe(25);
    expect(result.included.remainingPercent).toBe(75);
    expect(result.prepaid.balanceUsd).toBe(0);
    expect(result.included.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("treats a malformed cent object as unknown while preserving proto empty-object zero", () => {
    expect(normalizeBilling({ config: { creditUsagePercent: 10, prepaidBalance: {} } }).prepaid.balanceUsd).toBe(0);
    expect(normalizeBilling({ config: { creditUsagePercent: 10, prepaidBalance: { unexpected: true } } }).prepaid.balanceUsd).toBeNull();
  });

  test("legacy PAYG inference requires a positive cap", () => {
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandCap: {} } }).payg.enabled).toBeFalse();
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandUsed: { val: 1 } } }).payg.enabled).toBeNull();
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandCap: { val: 1 } } }).payg.enabled).toBeTrue();
  });
});

describe("selection", () => {
  test("prefers included allowance before prepaid and PAYG", () => {
    const now = Date.now();
    const included = account(1, billing({ included: { ...billing().included, remainingPercent: 1, usedPercent: 99 } }), now);
    const prepaid = account(2, billing({ included: { ...billing().included, remainingPercent: 0, usedPercent: 100 }, prepaid: { balanceUsd: 100 } }), now);
    const payg = account(3, billing({ included: { ...billing().included, remainingPercent: 0, usedPercent: 100 }, payg: { enabled: true, usedUsd: 1, capUsd: 100, remainingUsd: 99 } }), now);
    const result = selectAccount(state([payg, prepaid, included]), { mode: "best", account: null, allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
    expect(result.account.accountKey).toBe("grok-1");
    expect(result.score.tier).toBe("included");
    expect(result.reservation).toBeNull();
  });

  test("distinguishes incomplete capacity from known exhaustion", () => {
    const now = Date.now();
    const unknown = account(1, {
      included: { usedPercent: null, remainingPercent: null, periodType: null, periodStart: null, resetsAt: null },
      prepaid: { balanceUsd: null },
      payg: { enabled: null, usedUsd: null, capUsd: null, remainingUsd: null },
      subscriptionTier: null,
    }, now);
    expect(() => selectAccount(state([unknown]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now })).toThrow("incomplete included-capacity");
    expect(selectAccount(state([unknown]), { mode: "best", account: "grok-1", allowUnknown: true, dryRun: true, reserveSeconds: 30, now }).score.tier).toBe("unknown");

    const exhausted = account(2, billing({ included: { ...billing().included, usedPercent: 100, remainingPercent: 0 } }), now);
    try {
      selectAccount(state([exhausted]), { mode: "best", account: "grok-2", allowUnknown: true, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("account_exhausted");
    }
  });

  test("rotates next-available and creates short reservations", () => {
    const now = Date.now();
    const store = state([account(1, billing(), now), account(2, billing(), now)]);
    store.reservations.push({ id: "expired", accountKey: "grok-1", createdAtMs: now - 20_000, expiresAtMs: now - 10_000 });
    const first = selectAccount(store, { mode: "next-available", account: null, allowUnknown: false, dryRun: false, reserveSeconds: 10, now });
    const second = selectAccount(store, { mode: "next-available", account: null, allowUnknown: false, dryRun: false, reserveSeconds: 10, now: now + 1 });
    expect(first.account.accountKey).toBe("grok-1");
    expect(second.account.accountKey).toBe("grok-2");
    expect(first.reservation?.expiresAt).toBe(new Date(now + 10_000).toISOString());
    expect(store.reservations.some((reservation) => reservation.id === "expired")).toBeFalse();
  });

  test("last-good observations older than 24 hours are not decision-grade", () => {
    const now = Date.now();
    const old = account(1, billing(), now - 24 * 60 * 60_000 - 1);
    old.credentials.expiresAtMs = now + 60_000;
    try {
      selectAccount(state([old]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as CliError).code).toBe("usage_unknown");
    }
  });

  test("uses explicit PAYG availability without prepaid data but rejects incomplete capped PAYG", () => {
    const now = Date.now();
    const payg = account(1, billing({
      included: { ...billing().included, usedPercent: 100, remainingPercent: 0 },
      prepaid: { balanceUsd: null },
      payg: { enabled: true, usedUsd: 1, capUsd: 10, remainingUsd: 9 },
    }), now);
    expect(selectAccount(state([payg]), { mode: "best", account: null, allowUnknown: false, dryRun: true, reserveSeconds: 30, now }).score.tier).toBe("payg");

    payg.observation.lastGood!.payg = { enabled: true, usedUsd: null, capUsd: 10, remainingUsd: null };
    try {
      selectAccount(state([payg]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as CliError).code).toBe("usage_unknown");
    }
  });

  test("does not call known-disabled PAYG exhausted when prepaid capacity is unknown", () => {
    const now = Date.now();
    const incomplete = account(1, billing({
      included: { ...billing().included, usedPercent: 100, remainingPercent: 0 },
      prepaid: { balanceUsd: null },
      payg: { enabled: false, usedUsd: 0, capUsd: 0, remainingUsd: 0 },
    }), now);
    try {
      selectAccount(state([incomplete]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as CliError).code).toBe("usage_unknown");
    }
  });
});

describe("secure store", () => {
  test("writes state owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-store-"));
    process.env.GROK_SWAP_HOME = root;
    await withState((value) => {
      value.nextOrdinal = 2;
      return { result: null, changed: true };
    });
    expect((await stat(join(root, "state.json"))).mode & 0o777).toBe(0o600);
  });

  test("refuses a symlink state root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "grok-swap-link-root-"));
    const real = join(parent, "real");
    const linked = join(parent, "linked");
    await mkdir(real);
    await symlink(real, linked);
    process.env.GROK_SWAP_HOME = linked;
    await expect(withState(() => ({ result: null, changed: false }))).rejects.toMatchObject({ code: "store_unsafe" });
  });

  test("refuses an intermediate symlink before creating the state root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "grok-swap-intermediate-"));
    const real = join(parent, "real");
    const linked = join(parent, "linked");
    await mkdir(real);
    await symlink(real, linked);
    process.env.GROK_SWAP_HOME = join(linked, "nested");
    await expect(withState(() => ({ result: null, changed: false }))).rejects.toMatchObject({ code: "store_unsafe" });
  });

  test("refuses a group-readable state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-root-mode-"));
    await chmod(root, 0o755);
    process.env.GROK_SWAP_HOME = root;
    await expect(withState(() => ({ result: null, changed: false }))).rejects.toMatchObject({ code: "store_unsafe" });
  });

  test("refuses a symlink state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-link-file-"));
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify(state([])), { mode: 0o600 });
    await symlink(outside, join(root, "state.json"));
    process.env.GROK_SWAP_HOME = root;
    await expect(withState(() => ({ result: null, changed: false }))).rejects.toMatchObject({ code: "store_unsafe" });
  });

  test("refuses an insecure existing state file instead of chmodding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-mode-"));
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state([])), { mode: 0o600 });
    await chmod(path, 0o644);
    process.env.GROK_SWAP_HOME = root;
    await expect(withState(() => ({ result: null, changed: false }))).rejects.toMatchObject({ code: "store_unsafe" });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });
});

describe("OAuth and observation boundaries", () => {
  test("preserves an omitted rotated refresh token and verifies identity", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/oauth2/token") return Response.json({ access_token: "new-access", expires_in: 3600 });
        if (path === "/oauth2/userinfo") return Response.json({ sub: "acct_1", email: "new@example.test" });
        return new Response("missing", { status: 404 });
      },
    });
    try {
      process.env.GROK_SWAP_TEST_ALLOW_HTTP = "1";
      process.env.GROK_SWAP_TEST_USERINFO_URL = `http://127.0.0.1:${server.port}/oauth2/userinfo`;
      const refreshed = await refreshCredentials({
        accessToken: "old-access", refreshToken: "old-refresh", expiresAtMs: 0,
        issuer: `http://127.0.0.1:${server.port}`, clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      }, "acct_1");
      expect(refreshed.credentials.accessToken).toBe("new-access");
      expect(refreshed.credentials.refreshToken).toBe("old-refresh");
      expect(refreshed.email).toBe("new@example.test");
    } finally { server.stop(true); }
  });

  test("discards a refresh whose authenticated identity changes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname.endsWith("userinfo")
          ? Response.json({ sub: "acct_other" })
          : Response.json({ access_token: "new-access", refresh_token: "rotated", expires_in: 3600 });
      },
    });
    try {
      process.env.GROK_SWAP_TEST_ALLOW_HTTP = "1";
      process.env.GROK_SWAP_TEST_USERINFO_URL = `http://127.0.0.1:${server.port}/oauth2/userinfo`;
      await expect(refreshCredentials({
        accessToken: "old", refreshToken: "old-refresh", expiresAtMs: 0,
        issuer: `http://127.0.0.1:${server.port}`, clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      }, "acct_1")).rejects.toMatchObject({ code: "oauth_identity_changed" });
    } finally { server.stop(true); }
  });

  test("forced billing observation with a valid token does not call the token endpoint", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({ config: { creditUsagePercent: 10, currentPeriod: { end: "2026-10-01T00:00:00Z" } } });
      },
    });
    try {
      process.env.GROK_SWAP_TEST_ALLOW_HTTP = "1";
      process.env.GROK_SWAP_TEST_BILLING_URL = `http://127.0.0.1:${server.port}/billing?format=credits`;
      const target = account(1);
      const changed = await observeAccount(target, { force: true });
      expect(changed).toBeTrue();
      expect(paths).toEqual(["/billing"]);
      expect(target.credentials.refreshToken).toBe("refresh-1");
    } finally { server.stop(true); }
  });

  test("preserves last-good billing and sets backoff on a failed observation", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
    try {
      process.env.GROK_SWAP_TEST_ALLOW_HTTP = "1";
      process.env.GROK_SWAP_TEST_BILLING_URL = `http://127.0.0.1:${server.port}/billing`;
      const target = account(1);
      const previous = target.observation.lastGood;
      await observeAccount(target, { force: true });
      expect(target.observation.lastGood).toEqual(previous);
      expect(target.observation.error?.code).toBe("billing_http_error");
      expect(target.observation.nextAttemptAtMs).toBeGreaterThan(Date.now());
    } finally { server.stop(true); }
  });

  test("billing 401 and 403 retain last-good display data but revoke selection eligibility", async () => {
    let status = 401;
    const server = Bun.serve({ port: 0, fetch: () => new Response("denied", { status }) });
    try {
      process.env.GROK_SWAP_TEST_ALLOW_HTTP = "1";
      process.env.GROK_SWAP_TEST_BILLING_URL = `http://127.0.0.1:${server.port}/billing`;
      for (const deniedStatus of [401, 403]) {
        status = deniedStatus;
        const target = account(deniedStatus);
        target.credentials.issuer = `http://127.0.0.1:${server.port}`;
        const previous = target.observation.lastGood;
        await observeAccount(target, { force: true });
        expect(target.observation.lastGood).toEqual(previous);
        expect(target.observation.error).toMatchObject({ code: "auth_unavailable" });
        expect(publicObservation(target)).toMatchObject({ authStatus: "error", billingStatus: "stale", lastGoodAt: previous?.observedAt });
        try {
          selectAccount(state([target]), { mode: "best", account: target.accountKey, allowUnknown: true, dryRun: true, reserveSeconds: 30 });
          throw new Error("expected refusal");
        } catch (error) {
          expect((error as CliError).code).toBe("auth_unavailable");
        }
        await observeAccount(target, { force: true });
        expect(target.observation.error).toMatchObject({ code: "auth_unavailable" });
        expect(publicObservation(target).authStatus).toBe("error");
      }
    } finally { server.stop(true); }
  });

  test("rejects a chunked response over the actual one megabyte bound", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }));
    await expect(boundedResponseJson(response, "too_large", "invalid")).rejects.toMatchObject({ code: "too_large" });
  });

  test("does not invent unused PAYG headroom when usage is absent", () => {
    const result = normalizeBilling({ config: { creditUsagePercent: 100, onDemandCap: { val: 1000 } }, onDemandEnabled: true });
    expect(result.payg.capUsd).toBe(10);
    expect(result.payg.usedUsd).toBeNull();
    expect(result.payg.remainingUsd).toBeNull();
  });
});

describe("CLI contract", () => {
  test("emits one secret-free JSON envelope for list and failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-cli-"));
    const list = Bun.spawnSync(["bun", "src/cli.ts", "list", "--json"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, GROK_SWAP_HOME: root },
      stdout: "pipe", stderr: "pipe",
    });
    expect(list.exitCode).toBe(0);
    const envelope = JSON.parse(list.stdout.toString());
    expect(envelope).toMatchObject({ schema_version: 1, ok: true, command: "list", provider: "grok", data: { accounts: [] }, error: null });

    const refused = Bun.spawnSync(["bun", "src/cli.ts", "select", "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, GROK_SWAP_HOME: root }, stdout: "pipe", stderr: "pipe",
    });
    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout.toString())).toMatchObject({ schema_version: 1, ok: false, command: "select", error: { code: "no_eligible_account" } });
    expect(refused.stdout.toString().split("\n").filter(Boolean)).toHaveLength(1);

    const duplicateJson = Bun.spawnSync(["bun", "src/cli.ts", "list", "--json", "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, GROK_SWAP_HOME: root }, stdout: "pipe", stderr: "pipe",
    });
    expect(duplicateJson.exitCode).toBe(2);
    expect(JSON.parse(duplicateJson.stdout.toString())).toMatchObject({ schema_version: 1, ok: false, error: { code: "invalid_argument" } });
  });

  test("list against an absent store does not create it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "grok-swap-readonly-"));
    const root = join(parent, "absent");
    const listed = await runCli(["list", "--json"], { ...process.env, GROK_SWAP_HOME: root });
    expect(listed.data.accounts).toEqual([]);
    await expect(access(root)).rejects.toBeDefined();
  });

  test("installer is rerunnable and refuses a foreign target", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-swap-install-"));
    const bin = join(root, "bin");
    const installState = join(root, "state");
    const env = { ...process.env, GROK_SWAP_INSTALL_BIN_DIR: bin, GROK_SWAP_INSTALL_STATE_DIR: installState, GROK_SWAP_INSTALL_ALLOW_DIRTY: "1" };
    for (let run = 0; run < 2; run++) {
      const result = Bun.spawnSync(["bash", "scripts/install.sh", "--install"], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    }
    expect((await lstat(join(bin, "grok-swap"))).isSymbolicLink()).toBeTrue();
    expect(await readlink(join(bin, "grok-swap"))).toBe(join(import.meta.dir, "..", "src", "cli.ts"));
    expect(await readFile(join(bin, "grok-swap"), "utf8")).toContain("#!/usr/bin/env bun");
    expect(await readFile(join(installState, "deployed-sha"), "utf8")).toMatch(/^[0-9a-f]{40}\n$/u);
    await rm(join(bin, "grok-swap"));
    await writeFile(join(bin, "grok-swap"), "#!/bin/sh\n", { mode: 0o755 });
    const refused = Bun.spawnSync(["bash", "scripts/install.sh", "--install"], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("refusing foreign");
  });

  test("device login creates non-recycled ordinals and account controls remain secret-free", async () => {
    let tokenNumber = 0;
    let fixtureBaseUrl = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/oauth2/device/code") {
          const form = await request.formData();
          expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
          expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
          return Response.json({
            device_code: crypto.randomUUID(), user_code: "ABCD-1234",
            verification_uri: `${fixtureBaseUrl}/verify`, expires_in: 30, interval: 1,
          });
        }
        if (url.pathname === "/oauth2/token") {
          tokenNumber++;
          return Response.json({ access_token: `secret-access-${tokenNumber}`, refresh_token: `secret-refresh-${tokenNumber}`, expires_in: 3600 });
        }
        if (url.pathname === "/oauth2/userinfo") {
          const authorization = request.headers.get("authorization") || "";
          const identity = Number(authorization.match(/secret-access-(\d+)/u)?.[1]);
          return Response.json({ sub: `acct_${identity}`, email: `user${identity}@example.test` });
        }
        return new Response("ok");
      },
    });
    fixtureBaseUrl = `http://127.0.0.1:${server.port}`;
    const root = await mkdtemp(join(tmpdir(), "grok-swap-device-cli-"));
    const env = {
      ...process.env,
      GROK_SWAP_HOME: root,
      GROK_SWAP_TEST_ALLOW_HTTP: "1",
      GROK_SWAP_TEST_OAUTH_ISSUER: fixtureBaseUrl,
    };
    try {
      expect((await runCli(["add", "--alias", "first", "--no-open", "--json"], env)).data.account.accountKey).toBe("grok-1");
      const collision = await runCliResult(["add", "--alias", "grok-1", "--no-open", "--json"], env);
      expect(collision.exitCode).toBe(2);
      expect(JSON.parse(collision.stdout)).toMatchObject({ ok: false, error: { code: "alias_conflict", details: { accountKey: "grok-1" } } });
      expect((await runCli(["add", "--no-open", "--json"], env)).data.account.accountKey).toBe("grok-2");
      await runCli(["remove", "grok-1", "--json"], env);
      expect((await runCli(["add", "--no-open", "--json"], env)).data.account.accountKey).toBe("grok-3");
      await runCli(["alias", "grok-2", "work", "--json"], env);
      await runCli(["disable", "work", "--json"], env);
      const listed = await runCli(["list", "--json"], env);
      expect(listed.data.accounts.map((item: { accountKey: string }) => item.accountKey)).toEqual(["grok-2", "grok-3"]);
      expect(listed.data.accounts[0]).toMatchObject({ accountKey: "grok-2", displayName: "grok-2", ordinal: 2, alias: "work", enabled: false });
      const output = JSON.stringify(listed);
      expect(output).not.toContain("secret-access");
      expect(output).not.toContain("secret-refresh");
    } finally { server.stop(true); }
  }, 10_000);

  test("the guide catalog covers every literal CliError site", async () => {
    const sourceRoot = join(import.meta.dir, "..", "src");
    const files = ["billing.ts", "cli.ts", "oauth.ts", "select.ts", "store.ts"];
    const emitted = new Set<string>();
    for (const file of files) {
      const source = await readFile(join(sourceRoot, file), "utf8");
      for (const match of source.matchAll(/new CliError\("([a-z0-9_]+)"/gu)) emitted.add(match[1]!);
    }
    // These are passed through bounded helpers rather than constructed at the
    // call site, so retain the audit explicitly.
    for (const code of ["oauth_device_request_failed", "oauth_token_exchange_failed", "oauth_refresh_failed", "oauth_userinfo_failed", "billing_response_invalid"]) emitted.add(code);
    const catalog = new Set(ERROR_CODES.map((entry) => entry.code));
    expect([...emitted].filter((code) => !catalog.has(code))).toEqual([]);
  });
});

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<any> {
  const result = await runCliResult(args, env);
  if (result.exitCode !== 0) throw new Error(`CLI exited ${result.exitCode}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function runCliResult(args: string[], env: Record<string, string | undefined>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { exitCode, stdout, stderr };
}
