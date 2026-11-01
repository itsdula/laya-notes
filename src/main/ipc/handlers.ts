import path from "node:path";
import type { HealthReport } from "@shared/health.ts";
import { LayaError } from "@shared/result.ts";
import type { Settings } from "@shared/settings.ts";
import type { ChosenLocation } from "@shared/types.ts";
import type { LibraryService } from "../library/LibraryService.ts";
import type { LocationTokens } from "../library/locationTokens.ts";
import type { ModelService } from "../model/ModelService.ts";
import type { TaggingService } from "../model/TaggingService.ts";
import type { SettingsStore } from "../settings.ts";
import type { IpcRouter } from "./router.ts";

/** Everything the handlers need from the outside world, so they can run without Electron in tests. */
export type HandlerContext = {
  settings: SettingsStore;
  library: LibraryService;
  model: ModelService;
  tagging: TaggingService;
  tokens: LocationTokens;
  health: () => HealthReport;
  documentsPath: string;
  chooseFolder: (defaultPath: string) => Promise<string | null>;
  openPath: (target: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onSettingsChanged: (settings: Settings) => void;
};

export function registerHandlers(router: IpcRouter, context: HandlerContext): void {
  const { library, model, tagging, settings, tokens } = context;
  const store = () => library.store();

  const offer = async (directory: string): Promise<ChosenLocation> => ({
    token: tokens.issue(directory),
    path: directory,
    check: await library.inspect(directory),
  });

  router.handle("health:get", () => context.health());

  router.handle("library:list", () => store().list());
  router.handle("library:retry", () => library.retry());
  router.handle("library:recreate", () => library.recreate());
  router.handle("library:reveal", async () => {
    const state = library.state();
    if (state.status === "unset") throw new LayaError("LIBRARY_UNAVAILABLE", "No notes folder has been chosen yet.");
    await context.openPath(state.path);
  });
  router.handle("library:cleanupTags", async () => ({ removed: await store().cleanupMissingTags() }));

  router.handle("note:read", ({ id }) => store().read(id));
  router.handle("note:create", ({ folder }) => store().create(folder));
  router.handle("note:save", ({ id, text, baseModified, force }) => store().save(id, text, baseModified, force ?? false));
  router.handle("note:rename", ({ id, title }) => store().rename(id, title));
  router.handle("note:move", ({ id, folder }) => store().move(id, folder));
  router.handle("note:delete", ({ id }) => store().delete(id));
  router.handle("note:tag:add", ({ id, tag }) => store().addNoteTag(id, tag));
  router.handle("note:tag:remove", ({ id, tag }) => store().removeNoteTag(id, tag));

  router.handle("folder:create", ({ name }) => store().createFolder(name));
  router.handle("folder:rename", ({ name, next }) => store().renameFolder(name, next));
  router.handle("folder:delete", ({ name }) => store().deleteFolder(name));

  router.handle("tag:create", ({ name, instructions }) => store().createTag(name, instructions));
  router.handle("tag:update", ({ name, next, instructions }) => store().updateTag(name, next, instructions));
  router.handle("tag:delete", ({ name }) => store().deleteTag(name));

  router.handle("tagging:start", ({ ids }) => tagging.start(ids));
  router.handle("tagging:cancel", ({ runId }) => tagging.cancel(runId));

  router.handle("model:get", () => model.check());
  router.handle("model:download", () => model.startDownload());
  router.handle("model:cancel", () => model.cancelDownload());
  router.handle("model:load", () => {
    void model.ensureLoaded().catch(() => undefined);
  });
  router.handle("model:delete", async () => {
    if (tagging.busy()) throw new LayaError("BUSY", "Wait for Laya to finish tagging before deleting it.");
    await model.deleteModel();
  });
  router.handle("model:reveal", () => context.openPath(path.dirname(model.directory)));

  router.handle("location:choose", async () => {
    const current = settings.get().notesDir;
    const chosen = await context.chooseFolder(current ?? context.documentsPath);
    return chosen ? offer(chosen) : null;
  });
  router.handle("location:default", () => offer(path.join(context.documentsPath, "Laya Notes")));
  router.handle("location:recent", ({ path: directory }) => {
    if (!settings.get().recentNotesDirs.includes(directory)) throw new LayaError("INVALID", "That folder is not in the recent list.");
    return offer(directory);
  });
  router.handle("location:apply", ({ token, mode, seedSamples }) => library.apply(tokens.take(token), mode, seedSamples));

  router.handle("settings:update", async (patch) => {
    const next = await settings.update(patch);
    context.onSettingsChanged(next);
    return next;
  });

  router.handle("shell:openExternal", async ({ url }) => {
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "mailto:") throw new LayaError("INVALID", "Only web and email links can be opened.");
    await context.openExternal(url);
  });
}
