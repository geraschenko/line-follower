import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { followLines, type FollowEvent } from "./line-follower.ts";

/** Every test awaits a named event, never a clock; this bounds a hang. */
const options = { timeout: 5_000 };

function tempFile(t: TestContext, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "line-follower-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "log.jsonl");
  writeFileSync(path, content);
  return path;
}

/** The events received so far, and a promise for the first one, from now
 *  or already received, that matches. */
function recorder() {
  const events: FollowEvent[] = [];
  const waiters: {
    matches: (event: FollowEvent) => boolean;
    resolve: () => void;
  }[] = [];
  const onEvent = (event: FollowEvent): void => {
    events.push(event);
    for (const waiter of waiters.filter((w) => w.matches(event))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const until = (matches: (event: FollowEvent) => boolean): Promise<void> =>
    events.some(matches)
      ? Promise.resolve()
      : new Promise((resolve) => waiters.push({ matches, resolve }));
  const texts = (): string[] =>
    events.flatMap((e) => (e.kind === "line" ? [e.line.text] : []));
  return { events, onEvent, until, texts };
}

/** Resolves once the background loop has gone idle after its latest
 *  delivery. The loop runs one step per setImmediate and schedules its
 *  next step before the awaiting test resumes, so that step, which finds
 *  nothing to do, runs before this one. Only a watch event can wake the
 *  follower after this. */
const idle = (): Promise<void> => new Promise(setImmediate);

const lineWithText =
  (text: string) =>
  (event: FollowEvent): boolean =>
    event.kind === "line" && event.line.text === text;

test(
  "delivers existing lines with offsets, then a read event",
  options,
  async (t) => {
    const path = tempFile(t, '{"a":1}\n{"b"');
    const r = recorder();
    const follower = followLines(path, r.onEvent);
    t.after(() => follower.close());
    assert.deepEqual(r.events, [], "no events synchronously");
    await r.until((e) => e.kind === "read");
    assert.deepEqual(r.events, [
      {
        kind: "line",
        line: { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
      },
      { kind: "read", endOffset: 12, atEnd: true },
    ]);
  },
);

// Rule 1. followLines installs the watch before returning and reads only
// afterwards, so an append right after it returns and an append long after
// the first read are both delivered.
test(
  "delivers appends made before and after the first read",
  options,
  async (t) => {
    const path = tempFile(t, "");
    const r = recorder();
    const follower = followLines(path, r.onEvent);
    t.after(() => follower.close());
    appendFileSync(path, "early\n");
    await r.until(lineWithText("early"));
    await idle();
    appendFileSync(path, "late\n");
    await r.until(lineWithText("late"));
    assert.deepEqual(r.texts(), ["early", "late"]);
  },
);

// Rule 2. fs.watch coalesces a burst of appends into far fewer events.
test("delivers every line of a burst of appends", options, async (t) => {
  const path = tempFile(t, "");
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  t.after(() => follower.close());
  const expected = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
  for (const [i, text] of expected.entries()) {
    appendFileSync(path, `${text}\n`);
    if (i % 50 === 0) {
      // Let the follower run mid-burst, so later appends land while it is
      // reading and their events coalesce.
      await new Promise(setImmediate);
    }
  }
  await r.until(lineWithText(expected.at(-1)!));
  assert.deepEqual(r.texts(), expected);
});

// Rule 3.
test(
  "holds a line torn inside a UTF-8 code point until it completes",
  options,
  async (t) => {
    const path = tempFile(t, "");
    const r = recorder();
    const follower = followLines(path, r.onEvent);
    t.after(() => follower.close());
    const bytes = Buffer.from("rocket \u{1f680}\n");
    const inside = bytes.length - 3;
    appendFileSync(path, bytes.subarray(0, inside));
    await r.until((e) => e.kind === "read" && e.endOffset === inside);
    assert.deepEqual(r.texts(), []);
    appendFileSync(path, bytes.subarray(inside));
    await r.until(lineWithText("rocket \u{1f680}"));
  },
);

// Rule 4.
test("follows a file replaced by a rename", options, async (t) => {
  const path = tempFile(t, "old\n");
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  t.after(() => follower.close());
  await r.until(lineWithText("old"));
  await idle();
  writeFileSync(`${path}.tmp`, "new\n");
  renameSync(`${path}.tmp`, path);
  await r.until(lineWithText("new"));
  await idle();
  appendFileSync(path, "appended\n");
  await r.until(lineWithText("appended"));
  assert.deepEqual(
    r.events.filter((e) => e.kind !== "read"),
    [
      {
        kind: "line",
        line: { text: "old", lineNumber: 1, byteOffset: 0, byteLength: 4 },
      },
      { kind: "restart", cause: "replaced" },
      {
        kind: "line",
        line: { text: "new", lineNumber: 1, byteOffset: 0, byteLength: 4 },
      },
      {
        kind: "line",
        line: { text: "appended", lineNumber: 2, byteOffset: 4, byteLength: 9 },
      },
    ],
  );
});

test("reads a replaced file to its end and drops its unfinished line", (t) => {
  const path = tempFile(t, "");
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  t.after(() => follower.close());
  appendFileSync(path, "last\ntorn");
  writeFileSync(`${path}.tmp`, "new\n");
  renameSync(`${path}.tmp`, path);
  follower.drain();
  assert.deepEqual(r.texts(), ["last", "new"]);
  assert.deepEqual(
    r.events.map((e) => e.kind),
    ["line", "read", "restart", "line", "read"],
  );
});

test("restarts from byte 0 after truncation", (t) => {
  const path = tempFile(t, "one\ntwo\n");
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  t.after(() => follower.close());
  follower.drain();
  truncateSync(path, 0);
  appendFileSync(path, "x\n");
  follower.drain();
  assert.deepEqual(r.texts(), ["one", "two", "x"]);
  assert.deepEqual(r.events.at(-3), { kind: "restart", cause: "truncated" });
});

test("reads a file larger than one chunk; only the last read is atEnd", (t) => {
  const line = "x".repeat(999);
  const path = tempFile(t, `${line}\n`.repeat(3_000));
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  t.after(() => follower.close());
  follower.drain();
  assert.equal(r.texts().length, 3_000);
  const atEnds = r.events.flatMap((e) => (e.kind === "read" ? [e.atEnd] : []));
  assert.ok(atEnds.length > 1);
  assert.deepEqual(atEnds, [...atEnds.slice(0, -1).map(() => false), true]);
});

test("throws when the file is missing at start", (t) => {
  const path = tempFile(t, "");
  assert.throws(() => followLines(`${path}.missing`, () => {}), {
    code: "ENOENT",
  });
});

test("fails when the path no longer exists; drain throws the failure", (t) => {
  const path = tempFile(t, "a\n");
  const r = recorder();
  const follower = followLines(path, r.onEvent);
  follower.drain();
  unlinkSync(path);
  assert.throws(() => follower.drain(), /no longer exists/);
  const failed = r.events.at(-1);
  assert.equal(failed?.kind, "failed");
  follower.drain(); // no-op after failure
  assert.equal(r.events.at(-1), failed);
});

test("close from inside onEvent stops delivery", (t) => {
  const path = tempFile(t, "a\nb\nc\n");
  const texts: string[] = [];
  const follower = followLines(path, (event) => {
    if (event.kind === "line") {
      texts.push(event.line.text);
      follower.close();
    }
  });
  follower.drain();
  assert.deepEqual(texts, ["a"]);
});

test("an onEvent exception propagates out of drain and closes", (t) => {
  const path = tempFile(t, "a\n");
  const follower = followLines(path, () => {
    throw new Error("consumer bug");
  });
  assert.throws(() => follower.drain(), /consumer bug/);
  follower.drain(); // closed: no-op
});
