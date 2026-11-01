import { mkdir } from "node:fs/promises";
import path from "node:path";
import { libraryIsOpen, type LibraryState } from "@shared/health.ts";
import { LayaError } from "@shared/result.ts";
import type { LocationSummary } from "@shared/types.ts";
import { isDirectory } from "../fs/atomic.ts";
import { log } from "../log.ts";
import type { SettingsStore } from "../settings.ts";
import { inspectLocation, type ForbiddenRule } from "./location.ts";
import { NotesStore } from "./NotesStore.ts";
import { copyLibrary } from "./relocate.ts";
import { SAMPLES } from "./samples.ts";
import { watchLibrary } from "./watcher.ts";

export type LibraryServiceOptions = {
  settings: SettingsStore;
  rules: ForbiddenRule[];
  suggestedPath: string;
  remove?: (target: string) => Promise<void>;
  isBusy: () => boolean;
  onState: (state: LibraryState) => void;
  onChanged: (reason: "external" | "app") => void;
};

const MISSING_POLL_MS = 5000;

/** Owns the open notes folder. IPC handlers reach notes only through `store()`. */
export class LibraryService {
  private current: LibraryState;
  private notes: NotesStore | null = null;
  private stopWatching: (() => void) | null = null;
  private poll: NodeJS.Timeout | null = null;

  constructor(private readonly options: LibraryServiceOptions) {
    this.current = { status: "unset", suggestedPath: options.suggestedPath };
  }

  state(): LibraryState {
    return this.current;
  }

  store(): NotesStore {
    if (!this.notes || !libraryIsOpen(this.current)) {
      throw new LayaError("LIBRARY_UNAVAILABLE", "The notes folder is not available.");
    }
    return this.notes;
  }

  inspect(directory: string): Promise<LocationSummary> {
    return inspectLocation(directory, this.options.rules);
  }

  async openFromSettings(): Promise<LibraryState> {
    const directory = this.options.settings.get().notesDir;
    if (!directory) return this.setState({ status: "unset", suggestedPath: this.options.suggestedPath });
    return this.open(directory);
  }

  /** Opens a folder that already exists. A missing folder is reported, never created here. */
  async open(directory: string): Promise<LibraryState> {
    this.close();
    const check = await this.inspect(directory);
    if (check.status === "missing") {
      this.startMissingPoll(directory);
      return this.setState({ status: "missing", path: directory });
    }
    if (check.status !== "ok") return this.setState({ status: "unusable", path: directory, reason: describeProblem(check) });
    this.notes = new NotesStore(directory, { readOnly: !check.writable, remove: this.options.remove });
    this.stopWatching = watchLibrary(directory, {
      onChange: () => this.options.onChanged("external"),
      onGone: () => {
        log.warn("notes folder disappeared", directory);
        void this.open(directory);
      },
    });
    log.info("notes folder opened", { directory, writable: check.writable });
    return this.setState(check.writable ? { status: "ready", path: directory } : { status: "readOnly", path: directory });
  }

  retry(): Promise<LibraryState> {
    return this.openFromSettings();
  }

  /** The person asked to create an empty folder where the missing one was. */
  async recreate(): Promise<LibraryState> {
    const directory = this.options.settings.get().notesDir;
    if (!directory) throw new LayaError("INVALID", "No notes folder has been chosen yet.");
    if (!(await isDirectory(path.dirname(directory)))) {
      throw new LayaError("LIBRARY_UNAVAILABLE", "The drive or folder that held your notes is not available, so a new folder cannot be created there.");
    }
    await mkdir(directory, { recursive: true });
    return this.open(directory);
  }

  /**
   * Switches to a folder chosen in onboarding, recovery or settings.
   * `move` copies the current notes into the new, empty folder first; the old folder is left as it was.
   */
  async apply(directory: string, mode: "open" | "move", seedSamples: boolean): Promise<LibraryState> {
    if (this.options.isBusy()) throw new LayaError("BUSY", "Wait for Laya to finish tagging before changing the notes folder.");
    let check = await this.inspect(directory);
    if (check.status === "missing") {
      if (!(await isDirectory(path.dirname(directory)))) throw new LayaError("NOT_FOUND", "The folder that should contain your notes folder does not exist.");
      await mkdir(directory, { recursive: true });
      check = await this.inspect(directory);
    }
    if (check.status !== "ok") throw new LayaError("INVALID", describeProblem(check));

    if (mode === "move") {
      if (!this.notes || !libraryIsOpen(this.current)) throw new LayaError("LIBRARY_UNAVAILABLE", "There is no open notes folder to move.");
      if (path.resolve(directory) === path.resolve(this.notes.directory)) throw new LayaError("INVALID", "That is already your notes folder.");
      if (check.kind !== "empty") throw new LayaError("CONFLICT", "Notes can only be moved into an empty folder, so nothing gets mixed up or overwritten.");
      if (!check.writable) throw new LayaError("READ_ONLY", "That folder cannot be written to.");
      await copyLibrary(this.notes.directory, directory);
    }

    this.close();
    await this.options.settings.setNotesDir(directory);
    const state = await this.open(directory);
    if (seedSamples && state.status === "ready" && check.kind === "empty" && mode === "open") {
      await this.store().seed(SAMPLES);
    }
    this.options.onChanged("app");
    return state;
  }

  close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.notes = null;
  }

  /** A missing folder may be a drive that is not plugged in yet; reopen it as soon as it appears. */
  private startMissingPoll(directory: string): void {
    this.poll = setInterval(() => {
      void isDirectory(directory).then((present) => {
        if (present && this.current.status === "missing" && this.current.path === directory) void this.open(directory);
      });
    }, MISSING_POLL_MS);
  }

  private setState(state: LibraryState): LibraryState {
    this.current = state;
    this.options.onState(state);
    return state;
  }
}

export function describeProblem(check: LocationSummary): string {
  switch (check.status) {
    case "missing":
      return "That folder does not exist.";
    case "notADirectory":
      return "That is a file, not a folder.";
    case "unreadable":
      return "Laya Notes does not have permission to read that folder.";
    case "forbidden":
      return check.reason;
    case "ok":
      return "";
  }
}
