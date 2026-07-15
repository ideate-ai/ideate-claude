/**
 * logger.test.ts — the MCP server log file is BOUNDED (circular-buffer
 * semantics): it never grows without bound, keeps the most-recent lines, and
 * drops the oldest. This guards the fix for ideate-mcp.log reaching many GB.
 *
 * The logger reads its config (IDEATE_MCP_LOG, IDEATE_MCP_LOG_MAX_BYTES) and
 * opens the file at MODULE LOAD, so each case stubs the env then imports a fresh
 * module instance (vi.resetModules) pointed at a throwaway temp file — the real
 * ~/.claude/logs/ideate-mcp.log is never touched.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs: string[] = [];

function tmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-logtest-"));
  tmpDirs.push(dir);
  // Nested so the logger's mkdir-recursive path is exercised too.
  return path.join(dir, "logs", "ideate-mcp.log");
}

async function freshLogger(logPath: string, maxBytes: number) {
  vi.resetModules();
  vi.stubEnv("IDEATE_MCP_LOG", logPath);
  vi.stubEnv("IDEATE_MCP_LOG_MAX_BYTES", String(maxBytes));
  const mod = await import("../logger.js");
  return mod.log;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("logger: bounded log file (circular-buffer semantics)", () => {
  it("caps a growing log, keeps the newest lines, drops the oldest", async () => {
    const logPath = tmpLogPath();
    const max = 8 * 1024; // 8 KiB cap
    const log = await freshLogger(logPath, max);

    // Write far more than the cap; each line is uniquely numbered.
    const N = 800;
    for (let i = 0; i < N; i++) {
      log.info("test", `line-${String(i).padStart(5, "0")}-${"x".repeat(60)}`);
    }
    const totalWritten = N * 80; // ~64 KiB, ~8x the cap

    const size = fs.statSync(logPath).size;
    // Bounded: nowhere near the total written, and within a small multiple of
    // the cap (the file may transiently exceed the cap by one size-check
    // interval before the next trim, but never grows unbounded).
    expect(size).toBeLessThan(2 * max);
    expect(size).toBeLessThan(totalWritten / 3);

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain(`line-${String(N - 1).padStart(5, "0")}-`); // newest kept
    expect(content).not.toContain("line-00000-"); // oldest dropped
    expect(content).toContain("log trimmed"); // a trim actually occurred
    // File starts on a clean line boundary (a full timestamped line, no partial).
    expect(content.split("\n")[0].startsWith("[")).toBe(true);
  });

  it("bounds an already-oversize file on startup (before any new writes)", async () => {
    const logPath = tmpLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Pre-existing giant log: a huge oldest block, then newer lines.
    const oldestBlock = `OLDEST-${"z".repeat(20_000)}`;
    const newerLines = Array.from({ length: 300 }, (_, i) => `pre-${i}`).join("\n");
    fs.writeFileSync(logPath, `${oldestBlock}\n${newerLines}\nNEWEST-PRELINE\n`);
    expect(fs.statSync(logPath).size).toBeGreaterThan(20_000);

    const max = 4 * 1024; // 4 KiB cap
    await freshLogger(logPath, max); // ensureLogDir() → trimIfOversize() on open

    // Startup trim ran once, with no subsequent writes → strictly within cap.
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(max);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("NEWEST-PRELINE"); // newest retained
    expect(content).not.toContain("z".repeat(200)); // oldest block dropped
  });

  it("leaves a small log untouched (no premature trimming)", async () => {
    const logPath = tmpLogPath();
    const log = await freshLogger(logPath, 1024 * 1024); // 1 MiB cap
    log.info("test", "hello");
    log.error("test", "world");
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("hello");
    expect(content).toContain("world");
    expect(content).not.toContain("log trimmed");
  });
});
