import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";

/** Resolves once filePath exists. It watches the nearest existing ancestor
 *  directory, installing the watch before re-checking. Rejects when signal
 *  aborts. */
export async function awaitFileExists(
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  while (!existsSync(filePath)) {
    await awaitProgress(nearestExistingAncestor(filePath), filePath, signal);
  }
}

function nearestExistingAncestor(filePath: string): string {
  let ancestor = dirname(filePath);
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }
  return ancestor;
}

/** Resolves on any change in dir, or at once if progress already happened:
 *  the file exists, or a deeper ancestor than dir does. The caller re-derives
 *  where to look. */
function awaitProgress(
  dir: string,
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const settle = (error?: unknown): void => {
      watcher.close();
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = (): void => settle(signal?.reason);
    const watcher = watch(dir, () => settle());
    watcher.on("error", (error) => settle(error));
    signal?.addEventListener("abort", onAbort);
    // After the watch, so a creation racing the setup is not missed.
    if (existsSync(filePath) || nearestExistingAncestor(filePath) !== dir) {
      settle();
    }
  });
}
