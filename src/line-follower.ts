import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  watch,
  type BigIntStats,
  type FSWatcher,
} from "node:fs";
import { LineReader, type Line } from "./line-reader.ts";

export type FollowEvent =
  | { kind: "line"; line: Line }
  /** Emitted after the lines this read completed. */
  | { kind: "read"; endOffset: number }
  /** Later lines and offsets start from byte 0 of the file now at the path. */
  | { kind: "restart"; cause: "replaced" | "truncated" }
  /** Terminal: the follower is closed. */
  | { kind: "failed"; error: Error };

/** An exception thrown by onEvent is the consumer's bug, not a follower
 *  event. It closes the follower and propagates out of drain(), or, in the
 *  background loop, is rethrown as an uncaught exception. */
export interface LineFollower {
  /** Deliver everything visible now, synchronously. Throws the error that
   *  ended the follower during this call; it is also emitted as `failed`.
   *  No-op after close or failure. */
  drain(): void;
  /** Release the watcher and file handle. Idempotent. */
  close(): void;
}

/** Throws if filePath can't be opened or watched. Delivers no events
 *  synchronously; the first lines arrive on the first wake or drain(). */
export function followLines(
  filePath: string,
  onEvent: (event: FollowEvent) => void,
): LineFollower {
  return new Follower(filePath, onEvent);
}

/** Bounds both the memory per read and how long one step holds the event
 *  loop. */
const MAX_READ_BYTES = 1 << 20;

/** Bigints: inode numbers can exceed 2^53 on some filesystems. */
type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

interface WatchedFile {
  fd: number;
  identity: FileIdentity;
  watcher: FSWatcher;
}

/** The follower's position in the file it has open. A step may push into
 *  `reader` and return a new cursor sharing it; the old cursor is then
 *  stale. */
interface Cursor {
  file: WatchedFile;
  /** Holds the torn suffix of the bytes before `offset`. */
  reader: LineReader;
  /** Bytes of `file` consumed so far. */
  offset: number;
}

/** No events means there was nothing to do. */
interface Step {
  cursor: Cursor;
  events: FollowEvent[];
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function startOf(file: WatchedFile): Cursor {
  return { file, reader: new LineReader(), offset: 0 };
}

/** Open, then watch, then check that the path still names the opened file:
 *  fs.watch doesn't report which inode it attached to, and a replacement
 *  between open and watch would leave the watch on a different file. */
function openWatchedFile(
  filePath: string,
  onChange: () => void,
  onError: (error: Error) => void,
): WatchedFile {
  for (;;) {
    const fd = openSync(filePath, "r");
    let watcher: FSWatcher;
    try {
      watcher = watch(filePath, onChange).on("error", onError);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const { dev, ino } = fstatSync(fd, { bigint: true });
    const pathIdentity = statSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (pathIdentity !== undefined && sameFile({ dev, ino }, pathIdentity)) {
      return { fd, identity: { dev, ino }, watcher };
    }
    closeWatchedFile({ fd, identity: { dev, ino }, watcher });
  }
}

function closeWatchedFile(file: WatchedFile): void {
  file.watcher.close();
  closeSync(file.fd);
}

/** The first of: truncation, unread bytes, a missing path, a replaced path.
 *  On replacement, opens the new file with `reopen` before closing the old
 *  one. Throws filesystem errors. Each step works from the cursor alone, so
 *  drain() and the background loop can interleave between steps. */
function step(
  filePath: string,
  cursor: Cursor,
  reopen: () => WatchedFile,
): Step {
  const size = fstatSync(cursor.file.fd).size;
  if (size < cursor.offset) {
    return {
      cursor: startOf(cursor.file),
      events: [{ kind: "restart", cause: "truncated" }],
    };
  }
  if (size > cursor.offset) {
    return readChunk(cursor, size);
  }
  const pathIdentity = statSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (pathIdentity === undefined) {
    throw new Error(`${filePath} no longer exists`);
  }
  if (!sameFile(pathIdentity, cursor.file.identity)) {
    const replacement = reopen();
    closeWatchedFile(cursor.file);
    return {
      cursor: startOf(replacement),
      events: [{ kind: "restart", cause: "replaced" }],
    };
  }
  return { cursor, events: [] };
}

function readChunk(cursor: Cursor, size: number): Step {
  const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, size - cursor.offset));
  const bytesRead = readSync(
    cursor.file.fd,
    buffer,
    0,
    buffer.length,
    cursor.offset,
  );
  if (bytesRead === 0) {
    return { cursor, events: [] };
  }
  const offset = cursor.offset + bytesRead;
  const lines = cursor.reader.push(buffer.subarray(0, bytesRead));
  return {
    cursor: { ...cursor, offset },
    events: [
      ...lines.map((line): FollowEvent => ({ kind: "line", line })),
      { kind: "read", endOffset: offset },
    ],
  };
}

/** Owns the follower's lifecycle: scheduling steps, delivering their events,
 *  and closing on failure. */
class Follower implements LineFollower {
  private readonly filePath: string;
  private readonly onEvent: (event: FollowEvent) => void;
  private cursor: Cursor;
  private loopScheduled = false;
  private closed = false;
  private failure: Error | undefined;

  constructor(filePath: string, onEvent: (event: FollowEvent) => void) {
    this.filePath = filePath;
    this.onEvent = onEvent;
    this.cursor = startOf(this.openFile());
    this.wake();
  }

  drain(): void {
    if (this.closed) {
      return;
    }
    try {
      while (this.deliverStep());
    } catch (error) {
      this.close();
      throw error;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeWatchedFile(this.cursor.file);
  }

  private openFile(): WatchedFile {
    return openWatchedFile(
      this.filePath,
      () => this.wake(),
      (error) => this.fail(error),
    );
  }

  private wake(): void {
    if (!this.loopScheduled && !this.closed) {
      this.loopScheduled = true;
      setImmediate(() => this.backgroundStep());
    }
  }

  /** One step per turn of the event loop, so a large read never holds it
   *  for more than a chunk. */
  private backgroundStep(): void {
    let more: boolean;
    try {
      more = this.deliverStep();
    } catch (error) {
      this.loopScheduled = false;
      this.close();
      throw error;
    }
    if (more) {
      setImmediate(() => this.backgroundStep());
    } else {
      this.loopScheduled = false;
    }
  }

  /** Takes one step and delivers its events. Returns whether to step
   *  again. Throws only what onEvent throws. */
  private deliverStep(): boolean {
    if (this.closed) {
      return false;
    }
    let next: Step;
    try {
      next = step(this.filePath, this.cursor, () => this.openFile());
    } catch (error) {
      this.fail(error);
      return false;
    }
    this.cursor = next.cursor;
    for (const event of next.events) {
      if (this.closed) {
        return false;
      }
      this.onEvent(event);
    }
    return next.events.length > 0 && !this.closed;
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.close();
    this.onEvent({ kind: "failed", error: this.failure });
  }
}
