/**
 * remote-adapter.test.ts — Integration tests for RemoteAdapter wired into
 * selectAdapter via server.ts.
 *
 * These tests require a running ideate-server at localhost:4000. If the server
 * is not reachable, all tests in the live-server suite are skipped automatically.
 *
 * The error-handling tests (missing config, unreachable endpoint) run
 * unconditionally because they do not require a live server.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { selectAdapter } from "../server.js";
import { RemoteAdapter } from "../adapters/remote/index.js";
import { ConnectionError, StorageAdapterError } from "../adapter.js";
import { GraphQLClient } from "../adapters/remote/client.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempIdeateDir(config: object): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-remote-test-"));
  const ideateDir = path.join(tmpRoot, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
  // Write config to <project-root>/.ideate.json (new canonical location).
  // selectAdapter reads via readRawConfig(ideateDir) which looks at <parent>/.ideate.json.
  fs.writeFileSync(
    path.join(tmpRoot, ".ideate.json"),
    JSON.stringify(config, null, 2),
    "utf8"
  );
  return ideateDir;
}

// ---------------------------------------------------------------------------
// Check if localhost:4000 is reachable before running live-server tests
// ---------------------------------------------------------------------------

let serverReachable = false;

beforeAll(async () => {
  try {
    const res = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(2000),
    });
    serverReachable = res.ok || res.status === 400; // 400 = server up but query may be invalid
  } catch {
    serverReachable = false;
  }
});

// ---------------------------------------------------------------------------
// Unconditional tests — no live server required
// ---------------------------------------------------------------------------

describe("selectAdapter — remote backend wiring", () => {
  it("returns a RemoteAdapter instance when backend is 'remote'", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        endpoint: "http://localhost:4000/graphql",
        org_id: "test-org",
        codebase_id: "test-codebase",
      },
    });

    try {
      // Pass null for db/drizzleDb — the remote path does not use them
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = selectAdapter(ideateDir, null as any, null as any);
      expect(adapter).toBeInstanceOf(RemoteAdapter);
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });

  it("throws a clear error when remote.endpoint is missing", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        org_id: "test-org",
        codebase_id: "test-codebase",
        // endpoint intentionally omitted
      },
    });

    try {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectAdapter(ideateDir, null as any, null as any)
      ).toThrow("Remote backend requires 'remote.endpoint' in .ideate.json");
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });

  it("throws a clear error when remote config block is absent", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      // remote block intentionally omitted
    });

    try {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectAdapter(ideateDir, null as any, null as any)
      ).toThrow("Remote backend requires 'remote.endpoint' in .ideate.json");
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });

  it("throws when local backend is selected without db/drizzleDb", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "local",
    });

    try {
      expect(() =>
        selectAdapter(ideateDir, undefined, undefined)
      ).toThrow(/Local backend requires db and drizzleDb/);
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });
});

describe("RemoteAdapter — unreachable endpoint error handling", () => {
  it("initialize() throws ConnectionError for unreachable endpoint", async () => {
    // Use a port that should never have a server listening
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        endpoint: "http://localhost:19999/graphql",
        org_id: "test-org",
        codebase_id: "test-codebase",
      },
    });

    let adapter: RemoteAdapter | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter = selectAdapter(ideateDir, null as any, null as any) as RemoteAdapter;
      expect(adapter).toBeInstanceOf(RemoteAdapter);

      await expect(adapter.initialize()).rejects.toThrow(ConnectionError);
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live-server integration tests — skipped when server is not running
// ---------------------------------------------------------------------------

const describeLive = serverReachable ? describe : describe.skip;

describeLive("RemoteAdapter — live server at localhost:4000", () => {
  let ideateDir: string;
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-remote-live-"));
    ideateDir = path.join(tmpRoot, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    // Write config to <project-root>/.ideate.json (new canonical location).
    fs.writeFileSync(
      path.join(tmpRoot, ".ideate.json"),
      JSON.stringify(
        {
          schema_version: 4,
          backend: "remote",
          remote: {
            endpoint: "http://localhost:4000/graphql",
            org_id: "test-org",
            codebase_id: "test-codebase",
          },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  afterAll(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("selectAdapter returns RemoteAdapter with live endpoint", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = selectAdapter(ideateDir, null as any, null as any);
    expect(adapter).toBeInstanceOf(RemoteAdapter);
  });

  it("RemoteAdapter.initialize() succeeds with live server", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = selectAdapter(ideateDir, null as any, null as any) as RemoteAdapter;
    // initialize() should resolve without throwing
    await expect(adapter.initialize()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tokenProvider 401 rotation tests — no live server required
// ---------------------------------------------------------------------------

// Tests exercise client.ts:276-295 — 401 Unauthorized + tokenProvider rotation path.
// Documented in adapter-interface.md Section 7 (AdapterConfig.tokenProvider).
describe("tokenProvider 401 rotation", () => {
  // Each test spies on globalThis.fetch and must restore it after.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: build a minimal Response-like object that globalThis.fetch can return.
   */
  function makeFetchResponse(
    status: number,
    body: unknown
  ): Response {
    const bodyText = JSON.stringify(body);
    return new Response(bodyText, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("Test A: 401 → token rotation → retry with new token → 200 succeeds", async () => {
    const tokenProvider = vi.fn().mockResolvedValue("new-token-value");

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      tokenProvider
    );

    const successBody = { data: { result: "ok" } };

    // Track what Authorization header was sent on each call
    const capturedAuthHeaders: (string | null)[] = [];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuthHeaders.push(headers?.["Authorization"] ?? null);

        // First call: 401. Second call: 200 with valid GraphQL response.
        if (capturedAuthHeaders.length === 1) {
          return Promise.resolve(
            new Response(null, { status: 401, statusText: "Unauthorized" })
          );
        }
        return Promise.resolve(makeFetchResponse(200, successBody));
      }
    );

    const result = await client.query<{ result: string }>("{ result }");

    // tokenProvider must be called exactly once
    expect(tokenProvider).toHaveBeenCalledTimes(1);

    // fetch must be called twice (original + retry)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // The initial request must have used the original token
    expect(capturedAuthHeaders[0]).toBe("Bearer old-token");

    // The retry (second call) must use the new token
    expect(capturedAuthHeaders[1]).toBe("Bearer new-token-value");

    // The resolved value must be the 200 body's data
    expect(result).toEqual({ result: "ok" });
  });

  it("Test B: tokenProvider returns null → throws StorageAdapterError with AUTH_FAILURE code", async () => {
    const tokenProvider = vi.fn().mockResolvedValue(null);

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      tokenProvider
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
        (err as StorageAdapterError).code === "AUTH_FAILURE";
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("Test C: tokenProvider returns undefined → throws StorageAdapterError with AUTH_FAILURE code", async () => {
    // TokenProvider typed as () => Promise<string | null> but undefined is treated
    // the same as null (falsy) in the implementation's `if (newToken)` guard.
    const tokenProvider = vi.fn().mockResolvedValue(undefined);

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      // Cast to satisfy TypeScript; runtime value is undefined (falsy → same null path)
      tokenProvider as () => Promise<string | null>
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
        (err as StorageAdapterError).code === "AUTH_FAILURE";
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("Test D: 401 on both calls — tokenProvider called exactly once, second 401 throws StorageAdapterError", async () => {
    // NOTE: executeOnceWithAuth (the retry path) does NOT re-enter the
    // tokenProvider rotation guard — it calls !response.ok and throws
    // StorageAdapterError("HTTP_401") directly. This means there is no
    // infinite retry loop; tokenProvider is called at most once per request.
    //
    // Behaviour verified against the executeOnceWithAuth throw-vs-retry logic in client.ts.
    const tokenProvider = vi.fn().mockResolvedValue("new-token");

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      tokenProvider
    );

    // Both the original request and the retry return 401
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    // The retry path (executeOnceWithAuth) throws StorageAdapterError on 401,
    // not ConnectionError, because it has no tokenProvider logic.
    // StorageAdapterError is NOT retryable in execute(), so it propagates immediately.
    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
        (err as StorageAdapterError).code === "HTTP_401";
    });

    // tokenProvider called exactly once — no second rotation attempt
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    // Exactly 2 fetch calls: original request + one post-rotation retry
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("Test E: tokenProvider throws → StorageAdapterError with AUTH_FAILURE code", async () => {
    const tokenProvider = vi.fn().mockRejectedValue(new Error("EC2 metadata timeout"));

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      tokenProvider
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
             (err as StorageAdapterError).code === "AUTH_FAILURE" &&
             (err as StorageAdapterError).message.includes("EC2 metadata timeout");
    });

    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("Test F: executeOnceWithAuth network error → StorageAdapterError (non-retryable)", async () => {
    // First call returns 401, tokenProvider succeeds, second call (executeOnceWithAuth) throws network error.
    // executeOnceWithAuth throws StorageAdapterError (not ConnectionError) so the outer
    // execute() retry loop does not retry the post-rotation path.
    const tokenProvider = vi.fn().mockResolvedValue("new-token");

    const client = new GraphQLClient(
      "http://fake-endpoint/graphql",
      { Authorization: "Bearer old-token" },
      tokenProvider
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // First call: 401 (triggers tokenProvider)
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );
    // Second call: network error (executeOnceWithAuth)
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
        (err as StorageAdapterError).code === "CONNECTION_ERROR" &&
        (err as StorageAdapterError).message.includes("fake-endpoint");
    });

    // Exactly 2 fetch calls: original request + one post-rotation retry (no outer-loop retries)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("Test G: 401 without tokenProvider → StorageAdapterError with AUTH_FAILURE", async () => {
    // GraphQLClient without tokenProvider — 401 is a direct auth failure, no rotation.
    const client = new GraphQLClient("http://fake-endpoint/graphql");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    await expect(client.query("{ result }")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageAdapterError &&
        (err as StorageAdapterError).code === "AUTH_FAILURE" &&
        (err as StorageAdapterError).message.includes("fake-endpoint");
    });
  });
});

// ---------------------------------------------------------------------------
// getToolUsage stub (WI-855)
// ---------------------------------------------------------------------------

describe("RemoteAdapter.getToolUsage — stub behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty array without contacting the remote backend", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://fake-endpoint/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
    });

    // Ensure no HTTP call is made — the stub should short-circuit.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Guard the observability requirement: the spec requires log.warn on the stub path.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const rows = await adapter.getToolUsage();
    expect(rows).toEqual([]);

    const rowsFiltered = await adapter.getToolUsage({ tool_name: "ideate_query" });
    expect(rowsFiltered).toEqual([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("remote", expect.stringContaining("stub"));
  });
});

