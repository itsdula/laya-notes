# Rebuild plan: Laya Notes as an Electron app

This plan turns the Express prototype into the Electron app described in `architecture.md`, with four changes to that doc:

1. The person **chooses the notes folder on first launch** and can change it later in **Settings**. `Documents/Laya Notes` is the suggested default, not a fixed location.
2. The model runs in a **utility process**, not the main process. The main process stays thin and survives a model crash.
3. Startup runs a **health check** of app data, the notes folder, and the model. Every missing or broken piece has a defined fallback, and none of them stops the app from opening.
4. The app stops deleting tags for notes it can't see, so a sync delay or a rename in Finder doesn't lose labels.

## Guiding rules

- **The window is untrusted.** Every IPC request is validated in the main process. The renderer never receives a file system path it can use directly; it gets back data.
- **Nothing throws across IPC.** Every request resolves to a `Result`: `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
- **Never create a folder the person didn't ask for at a path that has disappeared.** A missing notes folder may be an unplugged drive or a sync client that hasn't started. Creating an empty folder there hides the problem and can write onto the wrong disk.
- **Never destroy data while recovering.** Corrupt files are renamed to `*.bad-<timestamp>`, not overwritten or deleted. Moving the library copies the files and leaves the old folder in place.
- **The model is optional.** Every feature except AI Tag works without it.

## Repository layout

```text
laya/
  package.json            Electron app (Forge + Vite)
  forge.config.ts
  vite.main.config.ts
  vite.preload.config.ts
  vite.renderer.config.ts
  vite.model.config.ts    builds the utility-process entry
  src/
    shared/               imported by every process; no Node or DOM APIs
      types.ts            Note, Folder, Tag, Library, NoteSummary
      names.ts            normalizeTag, sanitizeTitle (cross-platform), sanitizeFolder
      result.ts           Result, AppError, ErrorCode
      ipc.ts              the IPC contract: requests, responses, events
      health.ts           HealthReport, LibraryState, ModelState, AppDataState
      settings.ts         Settings schema (Zod) and defaults
    main/
      index.ts            app lifecycle, single-instance lock, window creation
      boot.ts             startup sequence, builds the HealthReport
      appData.ts          userData layout, checks, repair
      settings.ts         SettingsStore: load, validate, migrate, save
      library/
        LibraryService.ts owns the open NotesStore, swaps it when the folder changes
        NotesStore.ts     today's server/store.ts, adapted
        TagIndex.ts       load/save/repair of .laya-tags.json
        location.ts       inspects a candidate folder before it is used
        watcher.ts        reloads when files change outside the app
        relocate.ts       moves a library to a new folder
      model/
        ModelService.ts   state machine; talks to the utility process
        bundle.ts         pinned revision, file manifest, on-disk check
        download.ts       resumable download into userData/models
      ipc/
        router.ts         registers handlers, validates input, wraps Results
        handlers/*.ts     one file per area: boot, library, tags, model, settings
      fs/
        atomic.ts         writeAtomic, readJsonSafe, quarantine
        diskSpace.ts      free space via fs.statfs
      log.ts
    model-worker/
      index.ts            utility process: loads Laya, answers score requests
    preload/
      index.ts            exposes window.laya, typed from shared/ipc.ts
    renderer/
      main.tsx
      App.tsx             routes on the HealthReport
      bridge.ts           typed wrapper over window.laya
      state/              library, model and settings stores (Zustand or useSyncExternalStore)
      screens/
        Onboarding.tsx    first launch: choose folder
        Recovery.tsx      notes folder missing or unusable
        Notes.tsx
        Tags.tsx
        Settings.tsx
      components/         shadcn components, editor, dialogs
  site/                   landing page, plain HTML/CSS, deployed to GitHub Pages
  test/
```

`server/`, `client/`, `vite.config.ts` and the Express dependency are removed once their logic has been moved. `server/store.ts`, `server/tagger.ts`, `shared/names.ts`, `shared/types.ts` and `server/store.test.ts` are moved and adapted, not rewritten.

## Where things live on disk

| What | Where | Chosen by |
|---|---|---|
| Notes and `.laya-tags.json` | the notes folder | the person, on first launch or in Settings |
| `settings.json` | `userData/` | the app |
| Model files | `userData/models/<revision>/` | the app |
| Logs | `userData/logs/` | the app |
| Program code | the install location | the operating system |

`userData` is `app.getPath('userData')`. The notes folder path is stored in `settings.json`, so it is per device. That is intended: a Mac and a PC can point at the same synced folder under different paths.

The model stays in `userData`, not the notes folder. Putting 1.7 GB of weights in a synced folder would upload it to every device's sync service. Settings shows where the model is and how big it is, and offers **Delete model**.

## Abstractions

### Result and errors (`shared/result.ts`)

```ts
export type ErrorCode =
  | "INVALID"              // bad input from the window
  | "NOT_FOUND"            // note, folder or tag is gone
  | "CONFLICT"             // name already in use
  | "LIBRARY_UNAVAILABLE"  // notes folder missing or unreadable
  | "READ_ONLY"            // notes folder can be read but not written
  | "MODEL_UNAVAILABLE"    // not downloaded, or failed to load
  | "BUSY"                 // a tagging run or relocation is in progress
  | "NO_SPACE"
  | "OFFLINE"
  | "INTERNAL";

export type AppError = { code: ErrorCode; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
```

Main-process code throws `NotesError(code, message)` (which replaces `HttpError`). The IPC router catches it and returns `{ ok: false }`. Anything else becomes `INTERNAL`, is logged with its stack, and reaches the window as a generic message.

### Health report (`shared/health.ts`)

The renderer decides which screen to show from this single object. Main sends it once at startup and pushes it again whenever any part changes.

```ts
export type AppDataState =
  | { status: "ok" }
  | { status: "repaired"; notes: string[] }   // e.g. "settings.json was unreadable and has been reset"
  | { status: "degraded"; reason: string };   // userData not writable: settings live in memory only

export type LibraryState =
  | { status: "unset" }                                   // first launch: show Onboarding
  | { status: "ready"; path: string; readOnly: false }
  | { status: "readOnly"; path: string; reason: string }  // can list and read, cannot save
  | { status: "missing"; path: string }                   // folder is gone: show Recovery
  | { status: "unusable"; path: string; reason: string }; // exists but is a file, or cannot be read

export type ModelState =
  | { status: "absent" }                                  // nothing on disk
  | { status: "partial"; bytes: number; total: number }   // interrupted download, can resume
  | { status: "downloading"; file: string; received: number; total: number }
  | { status: "present" }                                 // files verified, not loaded
  | { status: "loading" }
  | { status: "ready" }                                   // loaded in the utility process
  | { status: "error"; reason: string; retryable: boolean };

export type HealthReport = {
  appData: AppDataState;
  library: LibraryState;
  model: ModelState;
  settings: Settings;
};
```

### Settings (`shared/settings.ts`, `main/settings.ts`)

```ts
export const SettingsSchema = z.object({
  version: z.literal(1),
  notesDir: z.string().nullable(),          // null until first launch completes
  recentNotesDirs: z.array(z.string()).max(5),
  lastNoteId: z.string().nullable(),
  confetti: z.boolean(),
  model: z.object({ loadOnLaunch: z.boolean() }),
  theme: ThemeSchema,
  window: z.object({ width: z.number(), height: z.number(), x: z.number().optional(), y: z.number().optional() }),
});
```

`SettingsStore`:

- `load()` reads `settings.json`. If the file is missing, it uses defaults. If it can't be parsed or fails the schema, it quarantines the file (`settings.json.bad-<timestamp>`), salvages any fields that do pass the schema (`notesDir` matters most), and fills the rest with defaults. It reports the repair in `AppDataState`.
- `update(patch)` validates, writes atomically, and emits `settings:changed`.
- Versioned: `version` lets later releases migrate the file instead of discarding it.
- If `userData` can't be written to, settings are kept in memory, `appData` is `degraded`, and the window shows a banner. The app keeps working for the session.

### App data (`main/appData.ts`)

`checkAppData()` runs first at startup:

1. `mkdir -p` on `userData`, `userData/models` and `userData/logs`.
2. Write and delete a probe file to confirm `userData` can be written to.
3. Remove stale temporary files: `*.tmp` from atomic writes and model `*.part` files older than a day that no download is using.
4. Return an `AppDataState`.

This never throws. Each failure lowers the state to `degraded` with a reason.

### Notes folder check (`main/library/location.ts`)

Used at startup, during onboarding, and in Settings, before any folder is used:

```ts
type LocationCheck =
  | { kind: "missing" }
  | { kind: "notADirectory" }
  | { kind: "unreadable" }
  | { kind: "readOnly" }
  | { kind: "forbidden"; reason: string }   // inside the app bundle, inside userData, or a filesystem root
  | { kind: "empty" }
  | { kind: "library"; notes: number; folders: number; hasIndex: boolean }
  | { kind: "otherFiles"; entries: number }; // has files, none of them Markdown

function inspectLocation(dir: string): Promise<LocationCheck>;
```

Write access is checked with a probe file, not `fs.access`. On Windows, `fs.access` doesn't reflect ACLs, and on network or sync drives it can report write access when there isn't any.

### Notes store (`main/library/NotesStore.ts`, `TagIndex.ts`)

`server/store.ts`, adapted:

- **Split listing from reading.** `list()` returns `NoteSummary` (id, title, folder, tags, modified) without file contents. `read(id)` returns one note. Mutations return the changed `NoteSummary` and a `revision` number, not the whole library with every note's text.
- **Never remove tag entries during reads.** Index entries for files that aren't there are kept. They are removed only when the app deletes or moves the note itself, or when the person clicks "Clean up tags for missing notes" in Settings, which shows how many will be removed first.
- **`TagIndex.load()` never blocks the app.** Missing file: empty index. Invalid JSON: quarantine it as `.laya-tags.json.bad-<timestamp>`, start empty, and report this so the window can show "Your tag file was damaged. A copy was kept at …". Today, a corrupt index makes every request fail.
- **Cross-platform names.** `sanitizeTitle` removes `<>:"/\|?*` and control characters, trims trailing dots and spaces, renames reserved Windows names (`CON`, `NUL`, `COM1`…) to `CON note`, and limits names to 200 characters. One set of rules on every OS keeps a synced folder valid on all of them.
- **Case-only renames.** On case-insensitive volumes, renaming `welcome` to `Welcome` goes through a temporary name instead of being treated as a collision and producing `Welcome 2.md`.
- **Detect outside edits before saving.** `save(id, text, baseModified)` refuses with `CONFLICT` if the file changed on disk since the editor loaded it. The window then offers "Reload" or "Keep mine".
- **Read-only mode.** If the folder fails the write probe, the store opens anyway: listing and reading work, and every write returns `READ_ONLY`.
- Keep the single promise queue that runs operations one at a time, the path guards, and atomic writes.

### Library service (`main/library/LibraryService.ts`)

Owns the open store and is the only thing IPC handlers talk to for notes.

```ts
class LibraryService {
  state(): LibraryState;
  open(dir: string): Promise<LibraryState>;  // inspect, then open a NotesStore and watcher
  close(): Promise<void>;                     // let queued work finish, stop the watcher
  store(): NotesStore;                         // throws LIBRARY_UNAVAILABLE unless ready or readOnly
  relocate(to: string, mode: "move" | "switch"): Promise<LibraryState>;
}
```

Switching folders is always: `close()` the old store, `open()` the new one, save `notesDir`, push `library:changed` and an updated health report. A tagging run in progress blocks relocation with `BUSY`.

### Watcher (`main/library/watcher.ts`)

`fs.watch` with a debounce of about 300 ms (or chokidar, if `fs.watch` turns out unreliable on network drives). On a change it sends `library:changed`, and the window lists notes again. If the open note changed on disk and the editor has no unsaved edits, it reloads. If there are unsaved edits, it shows the conflict prompt. If the notes folder itself disappears, the library state becomes `missing` and the window shows Recovery.

### Model (`main/model/*`, `model-worker/`)

**Bundle check (`bundle.ts`).** Pin the model:

```ts
export const MODEL = {
  repo: "receptron/laya-onnx",
  revision: "<commit sha>",          // pinned; changing it is a code change
  files: [
    { path: "laya.onnx", size: 0 },  // sizes filled in when pinning
    { path: "laya.onnx.data", size: 0 },
    { path: "laya_config.json", size: 0 },
    { path: "tokenizer/tokenizer.json", size: 0 },
    { path: "tokenizer/tokenizer_config.json", size: 0 },
  ],
};
```

`checkBundle()` runs at startup. It only calls `stat`: no network and no model loading. It returns `absent`, `partial` (some files or `.part` files exist), or `present` (every file matches its expected size). A file with the wrong size counts as partial and is downloaded again. Because the revision is pinned and the check is local, a launch never contacts Hugging Face.

**Download (`download.ts`).** We use our own downloader instead of `ensureBundle`, because it needs:

- confirmation first: the window shows the size and free space, and the person clicks Download;
- a free-space check with `fs.statfs` (size plus 10%), failing with `NO_SPACE`;
- resuming with HTTP `Range` into `<file>.part`, so an interrupted 1.7 GB download continues where it stopped;
- cancellation with an `AbortController`, and an abort on app quit;
- progress events throttled to about 4 per second;
- a rename into place only when the file reaches its expected size;
- clear errors: `OFFLINE` for network failures, `NO_SPACE`, `INTERNAL` with the HTTP status otherwise.

**Model service (`ModelService.ts`).** A state machine that is the single source of `ModelState`:

```text
absent ──download──▶ downloading ──done──▶ present ──load──▶ loading ──▶ ready
  ▲                     │ cancel/fail          ▲                │ fail
  │                     ▼                      │                ▼
  └──────delete───── partial ──resume──────────┘              error ──retry──▶ loading
ready ──unload / worker exit──▶ present
```

- Loading is lazy: on the first AI Tag, or at launch if `model.loadOnLaunch` is on.
- `score(note, tags)` resolves to probabilities, or returns `MODEL_UNAVAILABLE` with the reason.
- If the worker exits unexpectedly (crash, out of memory), the state returns to `present` with a one-time error message. The next request starts a new worker. After two crashes in a row it becomes `error` with `retryable: false` until the app restarts, so it doesn't crash in a loop.
- `deleteModel()` unloads, then removes `userData/models/<revision>`.
- Each state change is pushed to the window as `model:state`.

**Utility process (`model-worker/index.ts`).** Started with `utilityProcess.fork`. Messages, typed in `shared/ipc.ts`:

```ts
type ToWorker =
  | { type: "load"; modelDir: string }
  | { type: "score"; requestId: string; note: { title: string; text: string }; tags: Tag[] }
  | { type: "unload" };

type FromWorker =
  | { type: "loaded" }
  | { type: "loadFailed"; message: string }
  | { type: "scored"; requestId: string; probabilities: Record<string, number> }
  | { type: "scoreFailed"; requestId: string; message: string };
```

The worker calls `Laya.load({ modelDir })`, so the library never downloads anything. `classifyNote` from `server/tagger.ts` moves here unchanged, including the 0.5 threshold.

**Tagging run.** It lives in the main process, in `TaggingService`: one run at a time, cancellable, notes processed in order. For each note it reads the latest saved text, scores it in the worker, writes the tags, and pushes a `tag:event`. A failure on one note is reported and the run continues with the next note. Today, one failure stops the whole run.

### IPC (`shared/ipc.ts`, `main/ipc/router.ts`, `preload/index.ts`)

**Contract.** One map defines every request, its input schema and its response type:

```ts
export const requests = {
  "health:get":        { input: z.void(), output: {} as HealthReport },

  "library:list":      { input: z.void(), output: {} as LibraryListing },
  "note:read":         { input: z.object({ id: NoteId }), output: {} as Note },
  "note:create":       { input: z.object({ folder: FolderName }), output: {} as NoteSummary },
  "note:save":         { input: z.object({ id: NoteId, text: z.string().max(8_000_000), baseModified: z.string() }), output: {} as NoteSummary },
  "note:rename":       { input: z.object({ id: NoteId, title: z.string().max(200) }), output: {} as NoteSummary },
  "note:move":         { input: z.object({ id: NoteId, folder: FolderName }), output: {} as NoteSummary },
  "note:delete":       { input: z.object({ id: NoteId }), output: {} as void },
  "note:tag:add":      { input: z.object({ id: NoteId, tag: z.string().max(64) }), output: {} as NoteSummary },
  "note:tag:remove":   { input: z.object({ id: NoteId, tag: TagName }), output: {} as NoteSummary },

  "folder:create":     { input: z.object({ name: z.string().max(200) }), output: {} as Folder },
  "folder:rename":     { input: z.object({ name: FolderName, next: z.string().max(200) }), output: {} as Folder },
  "folder:delete":     { input: z.object({ name: FolderName }), output: {} as void },

  "tag:create":        { input: TagInput, output: {} as Tag },
  "tag:update":        { input: TagUpdate, output: {} as Tag },
  "tag:delete":        { input: z.object({ name: TagName }), output: {} as void },

  "tagging:start":     { input: z.object({ ids: z.array(NoteId).optional() }), output: {} as { runId: string } },
  "tagging:cancel":    { input: z.object({ runId: z.string() }), output: {} as void },

  "model:download":    { input: z.void(), output: {} as void },
  "model:cancel":      { input: z.void(), output: {} as void },
  "model:load":        { input: z.void(), output: {} as void },
  "model:delete":      { input: z.void(), output: {} as void },

  "location:choose":   { input: z.object({ purpose: z.enum(["onboarding", "settings", "recovery"]) }), output: {} as ChosenLocation | null },
  "location:useDefault": { input: z.void(), output: {} as ChosenLocation },
  "location:apply":    { input: z.object({ token: z.string(), mode: z.enum(["switch", "move"]), seedSamples: z.boolean() }), output: {} as LibraryState },
  "location:reveal":   { input: z.void(), output: {} as void },
  "library:retry":     { input: z.void(), output: {} as LibraryState },
  "library:recreate":  { input: z.void(), output: {} as LibraryState },
  "library:cleanupTags": { input: z.object({ confirm: z.literal(true) }), output: {} as { removed: number } },

  "settings:update":   { input: SettingsPatch, output: {} as Settings },
} as const;

export type Events = {
  "health:changed": HealthReport;
  "library:changed": { revision: number };
  "model:state": ModelState;
  "tag:event": TagEvent;
  "settings:changed": Settings;
};
```

**Folder selection uses a token, not a path from the window.** `location:choose` opens the native folder picker in the main process, inspects the chosen folder, keeps the result under a short-lived random token, and returns `{ token, path, check }` for display. `location:apply` only accepts that token. The window can never send an arbitrary path for the main process to write to.

**Router.** `handle(channel, fn)` checks that the request comes from our window (`event.senderFrame.url` matches the app's origin), parses the input with the channel's schema (`INVALID` on failure), runs the handler, and wraps the outcome in a `Result`.

**Preload.** Exposes a small typed surface built from the contract:

```ts
contextBridge.exposeInMainWorld("laya", {
  invoke: (channel, input) => ipcRenderer.invoke("laya", channel, input),  // main rejects unknown channels
  on: (event, listener) => { /* subscribe; returns an unsubscribe function */ },
});
```

`renderer/bridge.ts` adds types and unwraps Results into either the value or a thrown `AppError` for React code.

**Window security.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a strict Content Security Policy, navigation and `window.open` blocked, and external links opened through `shell.openExternal` for `https:` and `mailto:` only.

### Theme (`shared/theme.ts`, `renderer/theme.ts`)

A small layer over shadcn's CSS variables. It covers four settings and nothing more:

| Setting | Values | CSS it changes |
|---|---|---|
| `mode` | `system`, `light`, `dark` | the `.dark` class on `<html>`, and Electron's `nativeTheme.themeSource` so the title bar and menus match |
| `accent` | `neutral`, `blue`, `green`, `orange`, `rose`, `violet` | `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-ring` |
| `radius` | `0`, `0.3`, `0.5`, `0.75`, `1` (rem) | `--radius`; shadcn derives `--radius-sm` through `--radius-xl` from it |
| `noteFont` | `sans`, `serif`, `mono` | `--font-note`, used only by the editor |

```ts
export const ThemeSchema = z.object({
  mode: z.enum(["system", "light", "dark"]),
  accent: z.enum(ACCENTS),
  radius: z.union([z.literal(0), z.literal(0.3), z.literal(0.5), z.literal(0.75), z.literal(1)]),
  noteFont: z.enum(["sans", "serif", "mono"]),
});

export function themeVariables(theme: Theme, dark: boolean): Record<`--${string}`, string>;
```

`themeVariables` is a pure function, so it is unit-tested without a browser. Each accent defines a light and a dark pair of OKLCH values chosen for contrast with its foreground. `renderer/theme.ts` applies the variables to `document.documentElement` and follows the operating system's color scheme when `mode` is `system`. The theme is stored under `theme` in `settings.json`. An invalid value falls back to that field's default, like any other setting. The main process reads the stored mode before creating the window and sets the window's background color, so a dark theme doesn't flash white on launch.

Settings gets an **Appearance** section with a live preview: a button, an input, a card and a sample paragraph in the note font.

## Startup sequence (`main/boot.ts`)

```text
1. requestSingleInstanceLock()       a second launch focuses the existing window and exits
2. checkAppData()                    → AppDataState (never throws)
3. settings.load()                   → Settings, possibly repaired
4. if settings.notesDir is null      → library = unset
   else inspectLocation(notesDir)
        missing                      → library = missing   (do NOT create the folder)
        notADirectory / unreadable   → library = unusable
        readOnly                     → open read-only
        empty / library / otherFiles → open
5. model.checkBundle()               → absent | partial | present (stat only, no network)
6. create the window; the renderer asks for health:get
7. if model.loadOnLaunch and present → load in the background
```

Steps 2–5 take milliseconds and never block on the network. The window opens even if every check fails.

## Fallbacks

| Situation | Detected by | What happens |
|---|---|---|
| `userData` missing | `checkAppData` | Created. Treated as first launch. |
| `userData` not writable | write probe | Settings kept in memory; banner "Settings can't be saved on this computer". Notes still work. |
| `settings.json` missing | `settings.load` | Defaults; `notesDir` null, so Onboarding opens. |
| `settings.json` corrupt | parse or schema failure | Quarantined. Valid fields kept (especially `notesDir`). Notice shown once. |
| Notes folder never chosen | `notesDir` null | Onboarding. |
| Notes folder missing | `inspectLocation` | Recovery screen: **Try again** (drive or sync not ready yet), **Locate folder…**, **Create a new empty folder here**, **Use another folder**. Never created automatically. |
| Notes folder is a file or unreadable | `inspectLocation` | Recovery screen with the reason. |
| Notes folder read-only | write probe | Opens read-only with a banner; editing is disabled. |
| Notes folder disappears while running | watcher | Unsaved editor text stays in memory; Recovery screen opens; saving resumes once the folder is back. |
| `.laya-tags.json` missing | `TagIndex.load` | Empty index. |
| `.laya-tags.json` corrupt | `TagIndex.load` | Quarantined; empty index; notice with the backup's location. |
| Tag entries for missing notes | — | Kept. Optional cleanup in Settings. |
| File changed outside the app | watcher, `baseModified` | Reload, or a conflict prompt if there are unsaved edits. |
| Model absent | `checkBundle` | AI Tag opens "Download Laya (1.7 GB)" with free space shown. |
| Download interrupted | `.part` files | `partial`: **Resume** continues from where it stopped. |
| Model file wrong size | `checkBundle` | That file is downloaded again. |
| Not enough disk space | `statfs` | `NO_SPACE` before downloading starts. |
| Offline during download | fetch failure | `OFFLINE`; partial data kept for resuming. |
| Model fails to load | worker `loadFailed` | `error` with reason; **Retry** or **Delete and download again**. |
| Worker crashes | `exit` event | Back to `present`; restarted on the next request; stops after two crashes in a row. |

## Screens

**Onboarding (first launch).** A short explanation that notes are ordinary Markdown files in a folder the person picks. The suggested folder is `Documents/Laya Notes`, with **Use this folder** and **Choose another folder…**. After a folder is picked, the screen shows what's there:

- empty: "Start with a few example notes?" (on by default);
- existing Laya library: "Found 42 notes and your tags. Open it.";
- Markdown files without a tag file: "Found 12 notes. Laya will use them as they are.";
- other files: a warning that Laya will only show `.md` files, with a suggestion to create a subfolder.

Then **Continue**. Downloading the model is not part of onboarding; it is offered the first time someone clicks AI Tag.

**Recovery.** Shown when the library state is `missing` or `unusable`. It shows the path and the actions from the fallback table. Recently used folders that still exist appear as one-click options.

**Settings.** Three sections.

- **Notes folder.** Shows the current path with **Show in Finder/Explorer** and **Change…**. Change opens the picker, then asks how to proceed:
  - **Move my notes there**: copies notes, folders and `.laya-tags.json` to the new folder, checks that every file arrived with the same size, switches to it, and leaves the old folder untouched with a message saying where it is. Only allowed when the target is empty, so nothing gets merged or overwritten.
  - **Open that folder instead**: switches without copying. The old folder stays where it is.
  Also here: **Clean up tags for missing notes**, which shows the count before removing anything.
- **Laya model.** Status, location and size on disk. Download, Resume, Cancel, Retry, or Delete, depending on the state. A toggle for **Load Laya when the app starts**.
- **Appearance.** Mode, accent, corner radius and note font, with a live preview (see Theme above).
- **General.** Confetti on or off.

## Phases

Each phase ends with something runnable and tested.

### Phase 0: groundwork

- Update `architecture.md` for the four changes listed at the top of this file.
- Create the Forge + Vite project at the repo root with main, preload, renderer and model-worker entries. Move `client/` into `src/renderer/` so it renders inside Electron (still using `fetch` until Phase 2).
- Configure packaging for `onnxruntime-node`: mark it as external in the Vite main and worker builds, copy it into the package, unpack `*.node` and the platform libraries from the asar archive, and remove binaries for other platforms.
- Add Vitest for `src/main` and `src/shared`.

**Done when:** `npm run dev` opens a window showing the current UI, and `npm run package` produces an app that starts on macOS.

### Phase 1: shared contract and the main-process core

- `shared/result.ts`, `health.ts`, `settings.ts`, `ipc.ts`.
- `fs/atomic.ts` (`writeAtomic`, `readJsonSafe`, `quarantine`).
- `appData.ts`, `settings.ts`, `library/location.ts`.
- Move `store.ts` into `NotesStore` and `TagIndex` with the changes listed above: listing separate from reading, no removal on reads, safe index loading, cross-platform names, case-only renames, `baseModified` conflicts, read-only mode.
- `LibraryService`.

**Tests:** every row in the fallbacks table that involves settings, app data or the notes folder, using temporary directories (`chmod` for read-only, deleted folders for missing, corrupt JSON fixtures). Windows name rules. Case-only renames.

### Phase 2: IPC and the renderer switch

- Router, handlers, preload, `renderer/bridge.ts`.
- Rewrite `api.ts` on top of the bridge, keeping its function names so `App.tsx` changes little.
- `App.tsx` routes on the health report: Onboarding, Recovery, or the main view.
- Delete `server/index.ts` and Express.

**Tests:** router rejects bad input and unknown channels; handlers return `Result` for every error code.

### Phase 3: onboarding, recovery, settings, watcher

- `location:choose` / `location:apply` with tokens; `relocate.ts` in both modes.
- Onboarding, Recovery and Settings screens.
- `watcher.ts` and the editor conflict prompt.

**Tests:** moving a library copies everything and leaves the original; moving into a non-empty folder is refused; switching while tagging returns `BUSY`; an external rename shows up without losing tags.

### Phase 4: model

- Pin the revision and record file sizes in `bundle.ts`.
- `download.ts` with confirmation, free-space check, resume, cancel and progress.
- `ModelService` state machine, the utility-process worker, and `TaggingService`.
- Model section in Settings; AI Tag and Tag All use the new flow.

**Tests:** the state machine driven by a fake worker (load failure, crash, two crashes in a row); the downloader against a local HTTP server (resume from a partial file, abort, wrong size, no space); `checkBundle` for each on-disk state. One manual test with the real model on each OS.

### Phase 5: UI rebuild

- Tailwind and shadcn/ui; dialogs with React Hook Form and Zod.
- The editorcn toolbar editor with the Markdown extension, replacing the textarea and `markdown.tsx`. Before adopting it, check that loading and saving each file in `samples/` without edits produces no change. Only write when the content actually changed.
- Settings stored in `settings.json` instead of `localStorage`.

### Phase 6: development tooling and logs

- `npm run dev` wrapper: Forge output becomes OpenTelemetry log records, shown on a development-only monitor page. The terminal prints only the monitor and landing page addresses; a failure before the monitor starts is still printed.
- Packaged builds append the same records to `userData/logs` with rotation.

### Phase 7: distribution and landing page

- Code signing and notarization on macOS, signing on Windows, Linux AppImage or deb.
- GitHub Actions: build installers on tag push and attach them to a GitHub Release.
- `site/`: landing page with download links to the latest release assets.
- A GitHub Pages workflow that publishes only `site/`.
- Optional: auto-update with `update.electronjs.org`, which requires signed macOS builds.

## Decisions to confirm

- **The model stays in `userData`**, not next to the notes. The folder picker is for notes only.
- **Moving the library copies and never deletes the old folder.** The person removes it themselves.
- **Tags stay in `.laya-tags.json`.** Two devices syncing one folder can still produce conflicted copies of that file. Merging conflicted copies, or per-note sidecar files, can come later if this becomes a real problem.
- **Folders stay one level deep.** Files deeper down are not shown; Onboarding mentions this when it finds any.
