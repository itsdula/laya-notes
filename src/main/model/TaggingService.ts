import { randomUUID } from "node:crypto";
import { errorMessage, LayaError } from "@shared/result.ts";
import type { TagRunEvent } from "@shared/types.ts";
import type { LibraryService } from "../library/LibraryService.ts";
import { log } from "../log.ts";
import type { ModelService } from "./ModelService.ts";

/** A tag is kept when Laya's probability for it is at least one half. */
export const TAG_THRESHOLD = 0.5;

type Run = { id: string; cancelled: boolean };

/** One tagging run at a time. A failure on one note is reported and the run moves on to the next. */
export class TaggingService {
  private run: Run | null = null;

  constructor(
    private readonly library: LibraryService,
    private readonly model: ModelService,
    private readonly emit: (event: TagRunEvent) => void,
  ) {}

  busy(): boolean {
    return this.run !== null;
  }

  async start(ids?: string[]): Promise<{ runId: string }> {
    if (this.run) throw new LayaError("BUSY", "Laya is already tagging notes.");
    const store = this.library.store();
    if (store.readOnly) throw new LayaError("READ_ONLY", "The notes folder is read-only, so tags cannot be saved.");
    const targets = await store.tagTargets(ids);
    if (targets.catalog.length === 0) throw new LayaError("INVALID", "Add tags before asking Laya to label notes.");
    if (targets.notes.length === 0) throw new LayaError("NOT_FOUND", ids ? "That note is no longer available." : "There are no notes to tag.");
    if (!this.model.filesPresent) throw new LayaError("MODEL_UNAVAILABLE", "Download Laya before asking it to tag notes.");

    const run: Run = { id: randomUUID(), cancelled: false };
    this.run = run;
    void this.execute(run, targets.notes).finally(() => {
      if (this.run === run) this.run = null;
    });
    return { runId: run.id };
  }

  cancel(runId: string): void {
    if (this.run?.id === runId) this.run.cancelled = true;
  }

  private async execute(run: Run, notes: { id: string; title: string }[]): Promise<void> {
    const runId = run.id;
    this.emit({ type: "started", runId, count: notes.length });
    try {
      await this.model.ensureLoaded();
    } catch (error) {
      this.emit({ type: "failed", runId, message: errorMessage(error) });
      return;
    }
    let tagged = 0;
    let failed = 0;
    for (let index = 0; index < notes.length; index += 1) {
      if (run.cancelled) break;
      const target = notes[index];
      if (!target) continue;
      this.emit({ type: "tagging", runId, id: target.id, title: target.title, index: index + 1, count: notes.length });
      try {
        const store = this.library.store();
        const catalog = (await store.list()).tags;
        const note = await store.read(target.id);
        const probabilities = await this.model.score({ title: note.title, text: note.text }, catalog);
        const keep = catalog.filter((tag) => (probabilities[tag.name] ?? 0) >= TAG_THRESHOLD).map((tag) => tag.name);
        const summary = await store.setNoteTags(note.id, keep);
        tagged += 1;
        this.emit({ type: "tagged", runId, note: summary, probabilities });
      } catch (error) {
        failed += 1;
        log.warn("note could not be tagged", { id: target.id, error: errorMessage(error) });
        this.emit({ type: "noteFailed", runId, id: target.id, title: target.title, message: errorMessage(error) });
        if (error instanceof LayaError && (error.code === "MODEL_UNAVAILABLE" || error.code === "LIBRARY_UNAVAILABLE")) {
          this.emit({ type: "failed", runId, message: error.message });
          return;
        }
      }
    }
    this.emit({ type: "finished", runId, tagged, failed, cancelled: run.cancelled });
  }
}
