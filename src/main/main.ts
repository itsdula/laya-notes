import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, utilityProcess, type WebFrameMain } from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "@shared/channels.ts";
import type { EventName, Events } from "@shared/ipc.ts";
import { fail } from "@shared/result.ts";
import type { Settings } from "@shared/settings.ts";
import { WINDOW_BACKGROUND } from "@shared/theme.ts";
import type { FromWorker, ToWorker, WorkerHandle } from "../model-worker/protocol.ts";
import { boot, type LayaApp } from "./boot.ts";
import { buildMenu } from "./menu.ts";
import { log, writeLog, type Level, type LogSource } from "./log.ts";

const CONSOLE_LEVELS: Record<string, Level> = { debug: "debug", info: "info", warning: "warn", error: "error" };

if (squirrelStartup) app.quit();

// Development keeps its own settings and model folder, apart from an installed copy.
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Laya Notes Development"));

const rendererDirectory = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
let window: BrowserWindow | null = null;
let laya: LayaApp | null = null;

function emit<E extends EventName>(event: E, payload: Events[E]): void {
  if (window && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event, payload);
}

function isTrusted(frame: WebFrameMain | null | undefined): boolean {
  if (!frame) return false;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return frame.url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  return frame.url.startsWith(pathToFileURL(rendererDirectory).href);
}

/** Chromium appends `%c` CSS arguments to the message text; keep only the words. */
function withoutConsoleStyles(message: string): string {
  if (!message.includes("%c")) return message;
  return message.replaceAll("%c", "").replace(/(\s+[a-z-]+:\s?[^\s;/]+;?)+$/i, "");
}

/** Sends each line a child process prints to the log, marked with where it came from. */
function logLines(stream: NodeJS.ReadableStream | null, level: Level, source: LogSource): void {
  let buffered = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const lines = (buffered + chunk).split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) writeLog(level, line, undefined, source);
  });
}

function startWorker(): WorkerHandle {
  const child = utilityProcess.fork(path.join(__dirname, "worker.cjs"), [], { serviceName: "Laya model", stdio: "pipe" });
  logLines(child.stdout, "info", "worker");
  logLines(child.stderr, "warn", "worker");
  return {
    send: (message: ToWorker) => child.postMessage(message),
    onMessage: (listener) => child.on("message", (message: FromWorker) => listener(message)),
    onExit: (listener) => child.on("exit", listener),
    kill: () => {
      child.kill();
    },
  };
}

function openExternalSafely(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "https:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    // Not a URL; ignore it.
  }
}

/** Restores the saved size and position, unless that position is no longer on any screen. */
function windowBounds(saved: Settings["window"]) {
  const bounds = { width: saved.width, height: saved.height, x: saved.x, y: saved.y };
  if (bounds.x === undefined || bounds.y === undefined) return { width: bounds.width, height: bounds.height };
  const area = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).workArea;
  const visible = bounds.x < area.x + area.width - 100 && bounds.x + bounds.width > area.x + 100 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 100;
  return visible ? bounds : { width: bounds.width, height: bounds.height };
}

function createWindow(app: LayaApp): BrowserWindow {
  const saved = app.settings.get().window;
  const created = new BrowserWindow({
    ...windowBounds(saved),
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: "Laya Notes",
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  if (saved.maximized) created.maximize();
  created.once("ready-to-show", () => created.show());

  created.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    if (isTrusted({ url } as WebFrameMain)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  created.webContents.on("render-process-gone", (_event, details) => {
    const crashed = details.reason !== "clean-exit" && details.reason !== "killed";
    (crashed ? log.error : log.warn)("window renderer exited", details);
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    created.webContents.on("console-message", (event) => {
      writeLog(CONSOLE_LEVELS[event.level] ?? "info", withoutConsoleStyles(event.message), { source: event.sourceId, line: event.lineNumber }, "renderer");
    });
  }

  created.on("close", () => {
    const bounds = created.getNormalBounds();
    void app.settings.setWindow({ ...bounds, maximized: created.isMaximized() });
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void created.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void created.loadFile(path.join(rendererDirectory, "index.html"));
  return created;
}

async function start(): Promise<void> {
  // Packaged builds take the icon from the bundle; in development the Dock would show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), "assets/icon.png"));
  laya = await boot({
    userData: app.getPath("userData"),
    documentsPath: app.getPath("documents"),
    appPaths: app.isPackaged ? [path.dirname(app.getPath("exe")), process.resourcesPath] : [],
    platform: process.platform,
    startWorker,
    trash: (target) => shell.trashItem(target),
    chooseFolder: async (defaultPath) => {
      const options: Electron.OpenDialogOptions = {
        title: "Choose a folder for your notes",
        buttonLabel: "Use This Folder",
        defaultPath,
        properties: ["openDirectory", "createDirectory", "promptToCreate"],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    openPath: async (target) => {
      const error = await shell.openPath(target);
      if (error) log.warn("could not open path", { target, error });
    },
    openExternal: (url) => shell.openExternal(url),
    applyThemeMode: (mode) => {
      nativeTheme.themeSource = mode;
    },
    emit,
  });

  const running = laya;
  ipcMain.handle(INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    if (!isTrusted(event.senderFrame)) return fail("INVALID", "Request refused.");
    return running.router.dispatch(channel, input);
  });

  Menu.setApplicationMenu(buildMenu({ emit, isPackaged: app.isPackaged }));
  window = createWindow(running);
  window.on("closed", () => {
    window = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(start, (error: unknown) => {
    log.error("startup failed", error);
    dialog.showErrorBox("Laya Notes could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });

  app.on("activate", () => {
    if (!window && laya) window = createWindow(laya);
    window?.on("closed", () => {
      window = null;
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    laya?.dispose();
  });
}
