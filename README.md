# line-follower

[![GitHub](https://img.shields.io/badge/github-geraschenko%2Fline--follower-blue?logo=github)](https://github.com/geraschenko/line-follower)
[![npm](https://img.shields.io/npm/v/line-follower.svg)](https://www.npmjs.com/package/line-follower)

Follow an append-only file line by line, like `tail -F`, and get each complete
line as soon as it is written, with its byte offset. Zero dependencies.

```ts
import { followLines } from "line-follower";

const follower = followLines("records.jsonl", (event) => {
  switch (event.kind) {
    case "line": // { text, lineNumber, byteOffset, byteLength }
      apply(JSON.parse(event.line.text));
      break;
    case "read": // every byte before endOffset is consumed; atEnd: caught up
      break;
    case "restart": // the file was replaced or truncated; lines start over
      state = emptyState();
      break;
    case "failed": // terminal: the follower is closed
      report(event.error);
      break;
  }
});

follower.drain(); // synchronously deliver everything on disk now
follower.close();
```

## Why

Streams of lines make a simple communication channel. JSON-RPC over a socket
is one stream of lines. An append-only jsonl log is another: an actor that
records its messages in one has a durable history, and other processes can
follow it as it grows.

Following a file correctly is harder than it looks. A follower has to do four
things (based on experiments with Node on ext4):

1. **Watch before reading.** Otherwise appends between the first read and the
   watch are missed.
2. **Read to EOF on every event.** `fs.watch` coalesces events: 32,000
   appends gave 800 to 3,900 events.
3. **Buffer the unfinished last line, as bytes.** Reads end mid-line
   routinely, even with one writer. A UTF-8 character split across two reads
   must survive.
4. **Survive replacement.** After an atomic write (write a temp file, rename
   it over the path), a watch on the old file goes silent for good.

## API

### `followLines(filePath, onEvent): LineFollower`

Starts following `filePath`, which must exist; otherwise it throws. No events
are delivered synchronously: lines arrive on the next turn of the event loop,
or when you call `drain()`.

| Event                                                   | Meaning                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `{ kind: "line", line }`                                | One complete line, in file order.                                                                             |
| `{ kind: "read", endOffset, atEnd }`                    | Sent after the lines a read completed. If `endOffset` is past the last line's end, part of a line is waiting. |
| `{ kind: "restart", cause: "replaced" \| "truncated" }` | Later lines come from byte 0 of the file now at the path, numbered from 1. Discard what you derived.          |
| `{ kind: "failed", error }`                             | Terminal; the follower is closed. For example, the path no longer exists.                                     |

`atEnd` says a read reached the file's size as of that read. A backlog larger
than one chunk arrives as several reads, and only the last has `atEnd`.

A read's lines come before its `read` event, all in one synchronous call; no
other callback runs between them.

On replacement, the old file is read to its end first; its unfinished last
line, if any, is dropped.

- `drain()` delivers everything visible now, synchronously, so state is
  current when it returns. It throws the error that ended the follower during
  the call (also sent as `failed`). It does nothing after close or failure.
- `close()` releases the watch and the file. It is idempotent and safe to call
  from inside `onEvent`.

An exception thrown by `onEvent` is a bug in the consumer, not a follower
event. It closes the follower and propagates out of `drain()`; in the
background it becomes an uncaught exception.

### `LineReader`

`new LineReader().push(chunk: Buffer): Line[]` splits any byte stream (a
socket, stdin) into lines on raw `\n` bytes. It holds an unfinished line until
its newline arrives. Every line is delivered, blank ones included. `text` is
exactly the bytes before the `\n`, so a `\r` is kept and `byteLength` is the
UTF-8 length of `text` plus 1.

### `awaitFileExists(filePath, signal?): Promise<void>`

Resolves once `filePath` exists, watching the nearest existing ancestor
directory. Rejects with `signal.reason` when `signal` aborts, for example
`AbortSignal.timeout(10_000)`.

## Limits

- **A rewrite to the same size or larger is not detected.** Only truncation
  below what has been read, or replacement by a different file, is.
- **A path that is briefly missing fails the follower.** A rename over the
  path never leaves it missing. But unlink-then-create, or
  rename-away-then-create, can fail if the follower looks in between.
- **Untested on network filesystems,** where neither `O_APPEND` atomicity nor
  `fs.watch` events can be relied on.
- **Synchronous reads.** Reads happen on the event loop, one chunk (1 MiB) per
  turn, so a large first read doesn't hold the loop for longer than a chunk.

## Why not an existing package

As of October 2026, no package on npm follows all four rules, and none reports
per-line byte offsets. Each package's published source was checked, not its
README.

| Package             | Mechanism              | 1. Watch first | 2. Read to EOF | 3. Byte-level line buffer           | 4. Replacement                        |
| ------------------- | ---------------------- | -------------- | -------------- | ----------------------------------- | ------------------------------------- |
| `@logdna/tail-file` | polling, 1 s           | n/a            | yes            | emits chunks, no splitting          | yes                                   |
| `tail`              | `fs.watch` on the file | no             | yes            | no: decodes each block to a string  | no: waits 1 s, follows the moved file |
| `always-tail`       | `fs.watchFile`, 5 s    | n/a            | yes            | no                                  | yes                                   |
| `tail-file`         | `fs.watch` on the dir  | yes            | yes            | no: flushes the decoder at each EOF | yes                                   |
| `tail-stream`       | `fs.watch` on the file | no             | mostly         | reuses one buffer                   | no                                    |
| `fs-tail-stream`    | `fs.watch` on the file | partly         | racy           | no                                  | no                                    |
| `nodejs-tail`       | chokidar               | no             | no             | no                                  | no                                    |

`@logdna/tail-file` is correct but polls, so a line arrives up to a poll
interval late. `tail` is the obvious candidate for a pull request instead of a
new package. But it would need byte-level buffering, which changes its
`separator` and `encoding` options. It would need a new event or a breaking
change to report offsets, and a reversal of what its `follow` option means.
It would also need watch-before-read, truncation from 0, and a synchronous
drain: a rewrite of almost every method.
