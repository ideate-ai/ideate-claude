/**
 * logger.ts — Structured logging for the MCP artifact server.
 *
 * CRITICAL: MCP servers communicate via stdout (newline-delimited JSON-RPC).
 * Any console.log() call corrupts the protocol stream and causes
 * "[Tool result missing due to internal error]" on the client.
 *
 * This module provides:
 *   - log.info/warn/error/debug → all write to stderr (safe for MCP)
 *   - Optional file logging to LOG_PATH for persistent debugging
 *   - Tool call tracing with timing for diagnosing failures
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Log file path — opt-in via IDEATE_MCP_LOG env var, or default location
// ---------------------------------------------------------------------------

const LOG_PATH = process.env.IDEATE_MCP_LOG
  ?? path.join(os.homedir(), ".claude", "logs", "ideate-mcp.log");

let logFileEnabled = true;
let logFd: number | null = null;

// ---------------------------------------------------------------------------
// Bounded log file (circular-buffer semantics)
// ---------------------------------------------------------------------------
// The file is capped at MAX_LOG_BYTES. When a write pushes it past the cap, the
// oldest lines are dropped and only the most-recent KEEP_BYTES are retained
// (realigned to a line boundary) — so the newest logs always win and the file
// can never grow without bound. Before this cap existed the log could reach
// tens/hundreds of GB. Override the cap with IDEATE_MCP_LOG_MAX_BYTES (bytes).
const MAX_LOG_BYTES = ((): number => {
  const v = Number(process.env.IDEATE_MCP_LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 10 * 1024 * 1024; // default 10 MiB
})();
// Retain ~half on rollover so trimming is amortized (not re-run on every line).
const KEEP_BYTES = Math.floor(MAX_LOG_BYTES / 2);
// Only re-check the file size after this many bytes are written (avoids an
// fstat per line); scaled down for tiny caps so small logs stay responsive.
const SIZE_CHECK_INTERVAL = Math.max(1, Math.min(64 * 1024, KEEP_BYTES));
let bytesSinceSizeCheck = 0;

function ensureLogDir(): void {
  if (!logFileEnabled) return;
  try {
    const dir = path.dirname(LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    logFd = fs.openSync(LOG_PATH, "a+");
    // A pre-existing file may already be oversize (grown huge before this cap
    // existed) — bound it immediately on startup.
    trimIfOversize();
  } catch {
    logFileEnabled = false;
  }
}

/**
 * Enforce the size cap: if the log exceeds MAX_LOG_BYTES, rewrite it to the
 * most-recent KEEP_BYTES (aligned to a line boundary). A positioned tail read
 * keeps this cheap even when the existing file is enormous. Never throws — log
 * maintenance must not take down the MCP server.
 */
function trimIfOversize(): void {
  if (!logFileEnabled || logFd === null) return;
  try {
    const size = fs.fstatSync(logFd).size;
    if (size <= MAX_LOG_BYTES) return;
    const readLen = Math.min(KEEP_BYTES, size);
    const buf = Buffer.alloc(readLen);
    fs.readSync(logFd, buf, 0, readLen, size - readLen);
    // Drop the partial leading line so the file starts on a clean boundary.
    const nl = buf.indexOf(0x0a);
    const tail = nl >= 0 && nl + 1 < buf.length ? buf.subarray(nl + 1) : buf;
    const header = Buffer.from(
      `[${timestamp()}] [INFO] [logger] log trimmed: kept most-recent ~${String(tail.length)} bytes (cap ${String(MAX_LOG_BYTES)})\n`,
    );
    fs.closeSync(logFd);
    logFd = null;
    fs.writeFileSync(LOG_PATH, Buffer.concat([header, tail]));
    logFd = fs.openSync(LOG_PATH, "a+");
    bytesSinceSizeCheck = 0;
  } catch {
    // Best-effort: on failure, try to keep file logging alive; if the fd was
    // closed and cannot be reopened, degrade silently to stderr-only.
    if (logFd === null) {
      try {
        logFd = fs.openSync(LOG_PATH, "a+");
      } catch {
        logFileEnabled = false;
      }
    }
  }
}

// Initialize on module load
ensureLogDir();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, prefix: string, msg: string, extra?: unknown): string {
  const base = `[${timestamp()}] [${level}] [${prefix}] ${msg}`;
  if (extra !== undefined) {
    const extraStr = extra instanceof Error
      ? `${extra.message}\n${extra.stack}`
      : typeof extra === "string" ? extra : JSON.stringify(extra);
    return `${base} ${extraStr}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Core log functions — all write to stderr + optional file
// ---------------------------------------------------------------------------

function writeLog(formatted: string): void {
  // Always write to stderr (safe for MCP)
  process.stderr.write(formatted + "\n");

  // Also write to file if enabled (bounded — see trimIfOversize)
  if (logFileEnabled && logFd !== null) {
    try {
      const line = formatted + "\n";
      fs.writeSync(logFd, line);
      bytesSinceSizeCheck += Buffer.byteLength(line);
      if (bytesSinceSizeCheck >= SIZE_CHECK_INTERVAL) {
        bytesSinceSizeCheck = 0;
        trimIfOversize();
      }
    } catch {
      // If file write fails, disable file logging silently
      logFileEnabled = false;
    }
  }
}

export const log = {
  info(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("INFO", prefix, msg, extra));
  },

  warn(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("WARN", prefix, msg, extra));
  },

  error(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("ERROR", prefix, msg, extra));
  },

  debug(prefix: string, msg: string, extra?: unknown): void {
    if (process.env.IDEATE_MCP_DEBUG) {
      writeLog(formatMessage("DEBUG", prefix, msg, extra));
    }
  },

  /** Log a tool call with timing. Returns a function to call when the tool completes. */
  toolCall(name: string, args: Record<string, unknown>): () => void {
    const start = Date.now();
    const argSummary = Object.keys(args).length > 0
      ? ` args=${JSON.stringify(Object.keys(args))}`
      : "";
    log.debug("tool", `→ ${name}${argSummary}`);
    return () => {
      const elapsed = Date.now() - start;
      log.debug("tool", `← ${name} (${elapsed}ms)`);
    };
  },
};
