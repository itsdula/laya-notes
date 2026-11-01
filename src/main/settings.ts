import { DEFAULT_SETTINGS, applyPatch, salvageSettings, type Settings, type SettingsPatch } from "@shared/settings.ts";
import { quarantine, readJsonSafe, writeAtomic } from "./fs/atomic.ts";
import { log } from "./log.ts";

type Listener = (settings: Settings) => void;

export type SettingsLoad = { notices: string[] };

export class SettingsStore {
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  /** `persist` is false when userData cannot be written; changes then last for the session only. */
  constructor(
    private readonly file: string,
    private persist: boolean,
  ) {}

  async load(): Promise<SettingsLoad> {
    const read = await readJsonSafe(this.file);
    if (read.kind === "missing") return { notices: [] };
    if (read.kind === "unreadable") {
      log.warn("settings unreadable", read.reason);
      this.persist = false;
      return { notices: ["Your settings could not be read, so defaults are used and changes will not be saved this session."] };
    }
    if (read.kind === "corrupt") {
      const backup = await this.quarantineFile();
      log.warn("settings corrupt", read.reason);
      await this.save();
      return { notices: [`Your settings file was damaged and has been reset.${backup ? ` A copy was kept at ${backup}.` : ""}`] };
    }
    const { settings, repaired } = salvageSettings(read.value);
    this.settings = settings;
    if (repaired.length === 0) return { notices: [] };
    log.warn("settings repaired", repaired);
    const backup = await this.quarantineFile();
    await this.save();
    return {
      notices: [`Some settings were damaged and have been reset (${repaired.join(", ")}).${backup ? ` A copy was kept at ${backup}.` : ""}`],
    };
  }

  get(): Settings {
    return this.settings;
  }

  get persistent(): boolean {
    return this.persist;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: SettingsPatch): Promise<Settings> {
    return this.commit(applyPatch(this.settings, patch));
  }

  setNotesDir(notesDir: string): Promise<Settings> {
    const recent = [notesDir, ...this.settings.recentNotesDirs.filter((item) => item !== notesDir)].slice(0, 5);
    return this.commit({ ...this.settings, notesDir, recentNotesDirs: recent, lastNoteId: null });
  }

  setWindow(window: Settings["window"]): Promise<Settings> {
    return this.commit({ ...this.settings, window }, false);
  }

  private commit(next: Settings, notify = true): Promise<Settings> {
    this.settings = next;
    if (notify) for (const listener of this.listeners) listener(next);
    return this.save().then(() => next);
  }

  private save(): Promise<void> {
    if (!this.persist) return this.chain;
    const snapshot = `${JSON.stringify(this.settings, null, 2)}\n`;
    this.chain = this.chain
      .then(() => writeAtomic(this.file, snapshot))
      .catch((error: unknown) => {
        log.error("settings could not be saved", error);
      });
    return this.chain;
  }

  private async quarantineFile(): Promise<string | null> {
    if (!this.persist) return null;
    return quarantine(this.file).catch(() => null);
  }
}
