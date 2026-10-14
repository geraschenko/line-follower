import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { awaitFileExists } from "./await-file-exists.ts";

const options = { timeout: 5_000 };

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "line-follower-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("resolves at once for an existing file", options, async (t) => {
  const path = join(tempDir(t), "f");
  writeFileSync(path, "");
  await awaitFileExists(path);
});

test("resolves when the file is created", options, async (t) => {
  const path = join(tempDir(t), "f");
  const exists = awaitFileExists(path);
  writeFileSync(path, "");
  await exists;
});

test(
  "resolves when missing ancestor directories and the file appear",
  options,
  async (t) => {
    const dir = tempDir(t);
    const path = join(dir, "a", "b", "f");
    const exists = awaitFileExists(path);
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "a", "b"));
    writeFileSync(path, "");
    await exists;
  },
);

test("rejects with the signal's reason on abort", options, async (t) => {
  const path = join(tempDir(t), "f");
  const controller = new AbortController();
  const exists = awaitFileExists(path, controller.signal);
  controller.abort(new Error("gave up"));
  await assert.rejects(exists, /gave up/);
});

test("rejects at once for an already-aborted signal", options, async (t) => {
  const path = join(tempDir(t), "f");
  await assert.rejects(
    awaitFileExists(path, AbortSignal.abort(new Error("already"))),
    /already/,
  );
});
