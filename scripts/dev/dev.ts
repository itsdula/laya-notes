import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyLine, lineSplitter, type AttributeValue, type Severity } from "./records.ts";
import { listen, monitorServer, staticSite } from "./servers.ts";
import { createTelemetry } from "./telemetry.ts";

const root = path.resolve(import.meta.dirname, "../..");
const MONITOR_PORT = 4700;
const SITE_PORT = 4710;
const STOP_GRACE_MS = 4000;

function forgeCli(): string {
  const directory = path.join(root, "node_modules/@electron-forge/cli");
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as { bin: Record<string, string> };
  return path.join(directory, manifest.bin["electron-forge"] ?? "dist/electron-forge.js");
}

/** The landing page links to the repository; GitHub Pages fills this in when it deploys. */
function repositoryUrl(): string {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return remote.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  } catch {
    return "https://github.com";
  }
}

/** Process groups started for Forge. Killing a group also stops Electron and its helper processes. */
const groups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already exited.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid: number): boolean {
  return process.platform !== "win32" && processAlive(-pid);
}

/** Electron's main process in a group. Signalling the whole group at once makes Chromium report its helpers as crashed. */
function electronIn(group: number): number | undefined {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,pgid=,comm="], { encoding: "utf8" }).stdout ?? "";
  for (const row of listing.split("\n")) {
    const [pid, pgid, ...command] = row.trim().split(/\s+/);
    if (Number(pgid) === group && path.basename(command.join(" ")).toLowerCase() === "electron") return Number(pid);
  }
  return undefined;
}

async function waitFor(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function stopGroups(): Promise<void> {
  const pids = [...groups];
  if (process.platform === "win32") {
    for (const pid of pids) killGroup(pid, "SIGKILL");
  } else {
    const apps = pids.map(electronIn).filter((pid) => pid !== undefined);
    for (const pid of apps) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await waitFor(() => !apps.some(processAlive), STOP_GRACE_MS);
    for (const pid of pids) killGroup(pid, "SIGTERM");
    await waitFor(() => !pids.some(groupAlive), 1000);
    for (const pid of pids) if (groupAlive(pid)) killGroup(pid, "SIGKILL");
  }
  for (const pid of pids) groups.delete(pid);
}

let forge: ChildProcess | null = null;
let shuttingDown = false;

const monitor = monitorServer({
  page: readFileSync(path.join(import.meta.dirname, "monitor.html"), "utf8"),
  onRestart: () => void restart(),
  onStop: () => void stopApp(),
});
const monitorPort = await listen(monitor.server, MONITOR_PORT);
const repository = repositoryUrl();
const site = staticSite(path.join(root, "site"), (html) => html.replaceAll("{{REPO_URL}}", repository));
const sitePort = await listen(site, SITE_PORT);
const telemetry = createTelemetry(`http://127.0.0.1:${monitorPort}/v1/logs`);

function note(severity: Severity, body: string, attributes: Record<string, AttributeValue> = {}): void {
  telemetry.emit({ severity, source: "dev", body, attributes });
}

function startForge(): void {
  monitor.setStatus({ state: "starting", since: Date.now() });
  note("info", "starting electron-forge");
  const child = spawn(process.execPath, [forgeCli(), "start"], {
    cwd: root,
    env: { ...process.env, LAYA_LOG_STDOUT: "json", FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  forge = child;
  if (child.pid) groups.add(child.pid);

  for (const stream of ["stdout", "stderr"] as const) {
    const splitter = lineSplitter((line) => {
      const parsed = classifyLine(line, stream);
      if (!parsed) return;
      telemetry.emit(parsed);
      if (child === forge && parsed.source === "main" && parsed.body === "starting") monitor.setStatus({ state: "running", since: Date.now() });
    });
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", splitter.push);
    child[stream]?.on("end", splitter.end);
  }

  child.on("error", (error) => note("error", `could not start electron-forge: ${error.message}`));
  child.on("exit", (code, signal) => {
    const requested = forge !== child;
    note(requested || code === 0 ? "info" : "error", `electron-forge exited (${signal ?? `code ${code}`})`);
    if (requested) return;
    forge = null;
    monitor.setStatus({ state: "stopped", exitCode: code, since: Date.now() });
  });
}

let restarting = false;

/** Forge only reads `rs` from an interactive terminal, so a restart runs a fresh `forge start`. */
async function restart(): Promise<void> {
  if (shuttingDown || restarting) return;
  restarting = true;
  note("info", "restarting the app");
  monitor.setStatus({ state: "restarting", since: Date.now() });
  forge = null;
  await stopGroups();
  restarting = false;
  if (!shuttingDown) startForge();
}

async function stopApp(): Promise<void> {
  if (!forge || restarting) return;
  note("info", "stopping the app");
  forge = null;
  await stopGroups();
  monitor.setStatus({ state: "stopped", since: Date.now() });
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  forge = null;
  await stopGroups();
  await telemetry.shutdown().catch(() => undefined);
  monitor.closeClients();
  monitor.server.closeAllConnections();
  site.closeAllConnections();
  monitor.server.close();
  site.close();
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown());
process.on("uncaughtException", (error) => {
  note("error", `dev script crashed: ${error.stack ?? error.message}`);
  void shutdown(1);
});
// Last resort if the process exits without shutdown(): never leave Electron running.
process.on("exit", () => {
  for (const pid of groups) killGroup(pid, "SIGKILL");
});

process.stdout.write(`\n  Monitor   http://127.0.0.1:${monitorPort}\n  Landing   http://127.0.0.1:${sitePort}\n\n`);
startForge();
