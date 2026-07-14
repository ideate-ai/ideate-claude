/**
 * build-freshness.test.ts (WI-337 review S2) — exercises the SHIPPED shell
 * function scripts/build-freshness.sh `needs_build()` that start.sh sources, so
 * the tested code is the deployed code (no drift). Each case runs the real sh
 * function against a temp fixture with explicitly-controlled mtimes and asserts
 * the exit status: 0 = rebuild needed, 1 = skip.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/build-freshness.sh"
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Opts {
  version?: string;
  hasMarker?: boolean;
  markerContent?: string;
  hasDistIndex?: boolean;
  srcNewer?: boolean;
  tsconfigNewer?: boolean;
}

function fixture(o: Opts = {}): { dir: string; version: string; marker: string } {
  const version = o.version ?? "3.11.0";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const x = 1;");
  if (o.hasDistIndex ?? true) fs.writeFileSync(path.join(dir, "dist", "index.js"), "");

  const marker = path.join(dir, "dist", ".build-version");
  // Avoid millisecond races with directory mtimes: put the "newer" thing FAR in
  // the future. For skip cases the marker is far-future (nothing is newer than
  // it); for the source-newer/tsconfig-newer cases the specific file is
  // far-future while the marker sits at ~now.
  const now = Date.now() / 1000; // seconds
  const FAR = now + 100000; // ~1.15 days ahead — unambiguously newer
  if (o.srcNewer) fs.utimesSync(path.join(dir, "src", "a.ts"), FAR, FAR);
  if (o.tsconfigNewer) fs.utimesSync(path.join(dir, "tsconfig.json"), FAR, FAR);
  if (o.hasMarker ?? true) {
    fs.writeFileSync(marker, o.markerContent ?? version);
    const markerMtime = o.srcNewer || o.tsconfigNewer ? now : FAR;
    fs.utimesSync(marker, markerMtime, markerMtime);
  }
  return { dir, version, marker };
}

function needsBuild(f: { dir: string; version: string; marker: string }): number {
  const r = spawnSync(
    "sh",
    ["-c", '. "$1"; needs_build "$2" "$3" "$4"', "_", SCRIPT, f.dir, f.version, f.marker],
    { encoding: "utf8" }
  );
  if (r.status === null) throw new Error(`sh did not exit normally: ${r.error?.message ?? "unknown"}`);
  return r.status;
}

const BUILD = 0;
const SKIP = 1;

describe("build-freshness needs_build() (WI-337)", () => {
  it("missing marker -> rebuild", () => {
    expect(needsBuild(fixture({ hasMarker: false }))).toBe(BUILD);
  });

  it("marker matches, dist present, sources older -> skip", () => {
    expect(needsBuild(fixture())).toBe(SKIP);
  });

  it("source newer than marker, version unchanged -> rebuild (the WI-337 bug)", () => {
    expect(needsBuild(fixture({ srcNewer: true }))).toBe(BUILD);
  });

  it("built version differs from package.json -> rebuild", () => {
    expect(needsBuild(fixture({ version: "3.12.0", markerContent: "3.11.0" }))).toBe(BUILD);
  });

  it("tsconfig newer than marker -> rebuild", () => {
    expect(needsBuild(fixture({ tsconfigNewer: true }))).toBe(BUILD);
  });

  it("dist/index.js missing though marker intact -> rebuild (M1)", () => {
    expect(needsBuild(fixture({ hasDistIndex: false }))).toBe(BUILD);
  });
});
