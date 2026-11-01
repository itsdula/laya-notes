# Laya Notes

Two separate things share this repo.

The **landing page** is a folder of HTML and CSS in `site/`. GitHub Pages hosts it. It is how a person reads about Laya before they install anything. The app does not contain it, and it does not link into a running app.

The **app** is an Electron program. A person installs it on their computer and gets a window. The window is React. The main process receives a request from the window, then either reads and writes Markdown files or asks the model process to score a note. There is no HTTP server inside the app, no `/app` route, and no account.

A Mac at home and a PC at work are two installations. Each has its own notes and its own copy of the model. Nothing is synced. If someone wants the same notes on both, they point both apps at a folder their own sync already covers.

The step-by-step build plan, with every abstraction and fallback, is in [plan.md](plan.md).

## Where a note is stored

A note is one UTF-8 Markdown file in a folder the person chooses.

On first launch the app asks where notes should live. It suggests `Documents/Laya Notes`, resolved with Electron's `app.getPath('documents')`:

| OS | Suggested folder |
|---|---|
| macOS | `/Users/<name>/Documents/Laya Notes` |
| Windows | `C:\Users\<name>\Documents\Laya Notes` |
| Linux | `/home/<name>/Documents/Laya Notes` |

The person can pick any other folder, including one their own sync service covers. If the chosen folder is empty, the app can add a few example notes. Settings → Notes folder changes the location later: the app can open a different folder as it is, or move the current notes into an empty one.

The app creates the folder only when the person confirms it. If a chosen folder later disappears (an unplugged drive, a sync folder that has not mounted yet), the app does not recreate it. It shows a recovery screen, checks again every few seconds, and reopens the folder as soon as it is back. The person can also create an empty folder there, or pick another one. A folder the app cannot write opens read-only.

Layout, one level of folders only:

```text
Laya Notes/
  Welcome.md
  Weeknight Pasta.md
  Trips/
    Tokyo Weekend.md
  .laya-tags.json
```

- The file name, without `.md`, is the title. Renaming a note renames the file. `Welcome.md` is the note "Welcome". Names are cleaned so they are valid on macOS, Windows and Linux.
- A file sitting directly in the notes folder has no folder.
- A file inside one subdirectory belongs to that folder. `Trips` is a real directory. The app does not create folders nested below that, and it says so when it finds some.
- The body of the file is the note. The editor loads that string and, on each save, writes the string back. The write goes to a temporary file in the same folder, then a rename, so a crash mid-save does not leave a half-written note.
- Each save carries the file time the editor last saw. If another app changed the file in between, the app asks whether to load that version or keep the text in the editor. A file changed outside the app while nothing is waiting to be saved simply reloads.
- Deleting a note or folder moves it to the system Trash or Recycle Bin.

Tags are not written inside the Markdown. They live in `.laya-tags.json` in the notes folder:

```json
{
  "notes": {
    "Welcome.md": ["journal"],
    "Trips/Tokyo Weekend.md": ["travel"]
  },
  "customTags": [
    {
      "name": "travel",
      "instructions": "Is this note about a trip, travel, or a place away from home?"
    }
  ]
}
```

The key is the path of the file relative to the notes folder. Renaming, moving or deleting a file in the app updates that key. An entry whose file is not there is kept, because the file may still be syncing; Settings offers to clean those up, with a confirmation. A damaged tag file is set aside as `.laya-tags.json.bad-<time>` and the app starts a fresh one, so the notes stay readable.

A tag name is a lowercase slug (`Garden Plans` becomes `garden-plans`). Each tag stores the yes-or-no question Laya is asked.

This folder is the library. An app update does not touch it, because it is not inside the installed program. It is also not in the hidden application-support directory, because that is not where a person looks for their writing.

## The other two places Electron stores things

**The installed program** (the `.app`, the Windows install folder, the Linux install prefix) holds the code and the ONNX Runtime addon. The operating system treats it as read-only. An update replaces it. A person's files do not go here.

**Application support**, `app.getPath('userData')`, is private to this app, this OS user, and this machine:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Laya Notes` |
| Windows | `%APPDATA%\Laya Notes` |
| Linux | `~/.config/Laya Notes` |

Development builds use `Laya Notes Development` instead, so trying the app never touches real settings.

It holds:

- `settings.json` — the notes folder path, recent folders, the last opened note, theme, whether confetti is on, whether to load the model at launch, window size
- `models/<revision>/` — the downloaded Laya weights, for one pinned revision
- `logs/` — a JSON-lines log, rotated at 5 MB

Deleting this directory removes the model and the preferences. It does not remove the notes; the app asks for the folder again and can open the same one.

At startup the main process checks this directory. If it cannot be written, the app still opens, keeps settings in memory for that session, and says so. A damaged `settings.json` is set aside and every readable field is kept, so a bad theme value never loses the notes folder.

## How the app is shaped

The window never touches the disk and never loads the model. It sends typed requests across the preload bridge on one channel. Each request is checked with Zod in the main process and answers with a result, `{ ok: true, value }` or `{ ok: false, error: { code, message } }`, so nothing throws across the bridge. Folder choices come back to the window as one-time tokens, not raw paths it could send back altered.

```text
Electron window               React, shadcn, editorcn
        │  preload: invoke + events
Electron main process
        ├── settings          userData/settings.json
        ├── library           NotesStore + watcher, in the chosen folder
        ├── model service     download, verify, state machine
        │        │  utilityProcess
        │   model worker      @receptron/laya + onnxruntime-node
        └── tagging           one run at a time
```

The window starts from a health report: application support (ok or degraded), the notes folder (not chosen, ready, read-only, missing, unusable), and the model (absent, partly downloaded, downloading, verifying, on disk, loading, ready, error). It shows onboarding, recovery or the notes from that report, and the main process pushes a new report when any part changes.

There is no Express server and no port to visit. The earlier web prototype's rules are what we keep: a Markdown file per note, a JSON tag index beside the files, and a tag kept when Laya's probability is at least 0.5.

## Laya

`@receptron/laya` is a library, not a service. It runs an ONNX model through `onnxruntime-node` and answers every tag as a yes-or-no question in one pass. A tag is kept when the probability is at least 0.5.

The model runs in an Electron utility process, not in the main process. A crash or a long scoring pass cannot freeze the window or take the notes with it. If the worker exits, the app reports it and can start it again; after two crashes in a row it stops retrying and says so.

The installer does not contain the weights. They are about 1.6 GB, published on Hugging Face as `receptron/laya-onnx` (an export of `convaiinnovations/laya`). The app pins one revision of that repository and the hash of every file. The first AI Tag on a machine offers the download into `userData/models/<revision>`; it checks free space first, resumes after an interruption, and verifies each file before using it. Files from the earlier prototype's cache are reused when their hashes match. After the download, tagging works with no network, and the app never contacts Hugging Face again for that revision.

The ONNX Runtime addon is unpacked from the app archive when the app is packaged, because it loads a dynamic library that has to sit beside it as a real file. Packaging keeps only the binaries for the target platform and architecture.

## Development

`npm run dev` runs `scripts/dev/dev.ts` with Node, which strips the TypeScript types itself. The script starts three things and prints only two addresses:

- The dev monitor at `http://127.0.0.1:4700`. It shows every log line from the run, with filters for level, source and text, and buttons to restart or stop the app.
- The landing page from `site/` at `http://127.0.0.1:4710`.
- `electron-forge start`, which opens the Electron window and reloads the React code inside it.

If a port is taken, the script tries the next one. Both servers listen on 127.0.0.1 only.

Forge's output never reaches the terminal. The script reads each line and turns it into an OpenTelemetry log record with a level and a source: `forge`, `vite`, `electron`, `main`, `worker`, `renderer` or `dev`. It sends the records over OTLP/HTTP to the monitor's `/v1/logs` endpoint. In development the main process prints its own log entries as JSON lines prefixed with `laya:log `, so their level and details survive the trip. It also forwards the model worker's output and the window's console messages. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` sends the same records to a collector as well.

Restart stops the app and runs a new `forge start`, which also rebuilds the main process. Stop sends SIGTERM to Electron, and then ends Forge's process group. Ctrl+C, closing the terminal, or a crash of the script stop everything it started. `npm run dev:forge` runs Forge directly with its usual terminal output.

`npm run icons` draws every icon from the logo mark defined in `scripts/icons/icons.ts`: the app icons in `assets/` (`icon.icns` for macOS, `icon.ico` for Windows, `icon.png` for Linux) and the favicons in `site/`. The generated files are committed, so builds on other platforms do not need to run it; making `icon.icns` needs macOS.

`npm test` runs the Vitest suite for the store, settings, model download, IPC router and the monitor's log parsing. `npm run package` and `npm run make` build the installable app.

## Window

React, Tailwind, and shadcn/ui. Folder and tag dialogs use React Hook Form and Zod.

The note body uses editorcn's toolbar editor and its Markdown extension. Loading a file parses Markdown into the editor. Saving calls `getMarkdown()` and writes that string into the `.md` file. Opening a note never writes it; only an edit does. The block editor is the wrong tool: slash commands and image blocks do not come back out as the same Markdown file.

Settings → Appearance changes a few shadcn variables: light, dark or system mode, an accent color for `--primary` and `--ring`, the corner radius `--radius`, and the font used for notes. The values are applied to the document root and saved in `settings.json`.
