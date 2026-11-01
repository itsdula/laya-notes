import { homedir } from "node:os";
import path from "node:path";
import type { AppDataState, HealthReport } from "@shared/health.ts";
import type { EventName, Events } from "@shared/ipc.ts";
import type { Mode } from "@shared/theme.ts";
import type { WorkerHandle } from "../model-worker/protocol.ts";
import { appPaths, checkAppData } from "./appData.ts";
import { registerHandlers } from "./ipc/handlers.ts";
import { IpcRouter } from "./ipc/router.ts";
import { LibraryService } from "./library/LibraryService.ts";
import type { ForbiddenRule } from "./library/location.ts";
import { LocationTokens } from "./library/locationTokens.ts";
import { configureLog, log } from "./log.ts";
import { MODEL_BUNDLE } from "./model/bundle.ts";
import { ModelService } from "./model/ModelService.ts";
import { TaggingService } from "./model/TaggingService.ts";
import { SettingsStore } from "./settings.ts";

export type BootOptions = {
  userData: string;
  documentsPath: string;
  /** Folders that hold the app itself; the notes folder may not be inside them. */
  appPaths: string[];
  platform: string;
  startWorker: () => WorkerHandle;
  trash: (target: string) => Promise<void>;
  chooseFolder: (defaultPath: string) => Promise<string | null>;
  openPath: (target: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  applyThemeMode: (mode: Mode) => void;
  emit: <E extends EventName>(event: E, payload: Events[E]) => void;
};

export type LayaApp = {
  router: IpcRouter;
  settings: SettingsStore;
  library: LibraryService;
  model: ModelService;
  tagging: TaggingService;
  health: () => HealthReport;
  dispose: () => void;
};

/**
 * Startup, in order: app data, settings, notes folder, model files. Each step reports problems in the
 * health report instead of throwing, so the window always opens and can show what to do.
 */
export async function boot(options: BootOptions): Promise<LayaApp> {
  const paths = appPaths(options.userData);
  const appData = await checkAppData(paths, MODEL_BUNDLE.revision);
  configureLog(appData.writable ? paths.logs : null);
  log.info("starting", { userData: options.userData, appData: appData.state.status });

  const settings = new SettingsStore(paths.settingsFile, appData.writable);
  const loaded = await settings.load();
  options.applyThemeMode(settings.get().theme.mode);
  const appDataState: AppDataState = { ...appData.state, notices: [...appData.state.notices, ...loaded.notices] };

  const rules: ForbiddenRule[] = [
    { path: options.userData, match: "inside", reason: "That folder belongs to the app's private data. Choose a folder of your own." },
    ...options.appPaths.map((appPath) => ({ path: appPath, match: "inside" as const, reason: "That folder is part of the installed app." })),
    { path: homedir(), match: "exact", reason: "Choose a folder inside your home folder, not the home folder itself." },
  ];

  let tagging: TaggingService | null = null;
  const health = (): HealthReport => ({
    appData: appDataState,
    library: library.state(),
    model: model.info(),
    settings: settings.get(),
    platform: options.platform,
  });

  const library = new LibraryService({
    settings,
    rules,
    suggestedPath: path.join(options.documentsPath, "Laya Notes"),
    remove: options.trash,
    isBusy: () => tagging?.busy() ?? false,
    onState: () => options.emit("health:changed", health()),
    onChanged: (reason) => options.emit("library:changed", { reason }),
  });

  const model = new ModelService({
    modelsDir: paths.models,
    bundle: MODEL_BUNDLE,
    startWorker: options.startWorker,
    onChange: (info) => options.emit("model:changed", info),
    reuseFrom: legacyModelFolders(),
  });

  tagging = new TaggingService(library, model, (event) => options.emit("tagging:event", event));

  await library.openFromSettings();
  await model.check();
  if (settings.get().model.loadOnLaunch && model.filesPresent) void model.ensureLoaded().catch(() => undefined);

  settings.onChange((next) => options.emit("settings:changed", next));

  const router = new IpcRouter();
  registerHandlers(router, {
    settings,
    library,
    model,
    tagging,
    tokens: new LocationTokens(),
    health,
    documentsPath: options.documentsPath,
    chooseFolder: options.chooseFolder,
    openPath: options.openPath,
    openExternal: options.openExternal,
    onSettingsChanged: (next) => options.applyThemeMode(next.theme.mode),
  });
  const missing = router.missing();
  if (missing.length > 0) log.error("requests without handlers", missing);

  return {
    router,
    settings,
    library,
    model,
    tagging,
    health,
    dispose: () => {
      model.dispose();
      library.close();
    },
  };
}

/** Where the earlier command-line prototype cached the model. Verified files there are reused. */
function legacyModelFolders(): string[] {
  const root = process.env.LAYA_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "receptron-laya");
  const repo = path.join(root, MODEL_BUNDLE.repo.replace("/", "--"));
  return [path.join(repo, MODEL_BUNDLE.revision), path.join(repo, "main")];
}
