import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isDirectory } from "../fs/atomic.ts";
import { TAG_INDEX_FILE } from "./TagIndex.ts";

export type WatchHandlers = {
  /** Something in the folder changed outside the app's own temporary files. */
  onChange: () => void;
  /** The notes folder itself disappeared. */
  onGone: () => void;
};

const DEBOUNCE_MS = 300;

export function watchLibrary(directory: string, handlers: WatchHandlers): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;

  const flush = async () => {
    timer = null;
    if (closed) return;
    if (!(await isDirectory(directory))) {
      handlers.onGone();
      return;
    }
    handlers.onChange();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  };

  try {
    watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename) {
        const base = path.basename(filename.toString());
        if (base.startsWith(".") && base !== TAG_INDEX_FILE) return;
      }
      schedule();
    });
    watcher.on("error", () => schedule());
  } catch {
    // Some network drives cannot be watched; the library still works, it just does not refresh by itself.
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
