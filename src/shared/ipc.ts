import { z } from "zod";
import type { HealthReport, LibraryState, ModelInfo } from "./health.ts";
import type { Result } from "./result.ts";
import { SettingsPatchSchema, type Settings } from "./settings.ts";
import type { ChosenLocation, Folder, LibraryListing, Note, NoteSummary, Tag, TagRunEvent } from "./types.ts";

/** Gives each request its response type without a runtime value. */
function returns<T>(): T {
  return undefined as T;
}

const NoteId = z.string().min(1).max(1024);
const FolderName = z.string().max(255);
const TagName = z.string().min(1).max(64);
const Nothing = z.undefined();

export const requests = {
  "health:get": { input: Nothing, output: returns<HealthReport>() },

  "library:list": { input: Nothing, output: returns<LibraryListing>() },
  "library:retry": { input: Nothing, output: returns<LibraryState>() },
  "library:recreate": { input: Nothing, output: returns<LibraryState>() },
  "library:reveal": { input: Nothing, output: returns<void>() },
  "library:cleanupTags": { input: z.object({ confirm: z.literal(true) }), output: returns<{ removed: number }>() },

  "note:read": { input: z.object({ id: NoteId }), output: returns<Note>() },
  "note:create": { input: z.object({ folder: FolderName }), output: returns<NoteSummary>() },
  "note:save": {
    input: z.object({
      id: NoteId,
      text: z.string().max(8_000_000),
      baseModified: z.number().nullable(),
      force: z.boolean().optional(),
    }),
    output: returns<NoteSummary>(),
  },
  "note:rename": { input: z.object({ id: NoteId, title: z.string().max(400) }), output: returns<NoteSummary>() },
  "note:move": { input: z.object({ id: NoteId, folder: FolderName }), output: returns<NoteSummary>() },
  "note:delete": { input: z.object({ id: NoteId }), output: returns<void>() },
  "note:tag:add": { input: z.object({ id: NoteId, tag: z.string().min(1).max(200) }), output: returns<NoteSummary>() },
  "note:tag:remove": { input: z.object({ id: NoteId, tag: TagName }), output: returns<NoteSummary>() },

  "folder:create": { input: z.object({ name: z.string().min(1).max(400) }), output: returns<Folder>() },
  "folder:rename": { input: z.object({ name: FolderName.min(1), next: z.string().min(1).max(400) }), output: returns<Folder>() },
  "folder:delete": { input: z.object({ name: FolderName.min(1) }), output: returns<void>() },

  "tag:create": {
    input: z.object({ name: z.string().min(1).max(200), instructions: z.string().max(2000) }),
    output: returns<Tag>(),
  },
  "tag:update": {
    input: z.object({ name: TagName, next: z.string().min(1).max(200).optional(), instructions: z.string().max(2000).optional() }),
    output: returns<Tag>(),
  },
  "tag:delete": { input: z.object({ name: TagName }), output: returns<void>() },

  "tagging:start": { input: z.object({ ids: z.array(NoteId).max(100_000).optional() }), output: returns<{ runId: string }>() },
  "tagging:cancel": { input: z.object({ runId: z.string().max(64) }), output: returns<void>() },

  "model:get": { input: Nothing, output: returns<ModelInfo>() },
  "model:download": { input: Nothing, output: returns<void>() },
  "model:cancel": { input: Nothing, output: returns<void>() },
  "model:load": { input: Nothing, output: returns<void>() },
  "model:delete": { input: Nothing, output: returns<void>() },
  "model:reveal": { input: Nothing, output: returns<void>() },

  "location:choose": { input: Nothing, output: returns<ChosenLocation | null>() },
  "location:default": { input: Nothing, output: returns<ChosenLocation>() },
  "location:recent": { input: z.object({ path: z.string().max(4096) }), output: returns<ChosenLocation>() },
  "location:apply": {
    input: z.object({ token: z.string().max(64), mode: z.enum(["open", "move"]), seedSamples: z.boolean() }),
    output: returns<LibraryState>(),
  },

  "settings:update": { input: SettingsPatchSchema, output: returns<Settings>() },

  "shell:openExternal": { input: z.object({ url: z.string().url().max(4096) }), output: returns<void>() },
} as const;

export type Channel = keyof typeof requests;
export type Input<C extends Channel> = z.input<(typeof requests)[C]["input"]>;
export type Output<C extends Channel> = (typeof requests)[C]["output"];
export type InvokeArgs<C extends Channel> = Input<C> extends undefined ? [] : [input: Input<C>];

export type Events = {
  "health:changed": HealthReport;
  "library:changed": { reason: "external" | "app" };
  "model:changed": ModelInfo;
  "tagging:event": TagRunEvent;
  "settings:changed": Settings;
  "app:command": { command: AppCommand };
};

export type AppCommand = "newNote" | "newFolder" | "openSettings" | "openNotes" | "openTags" | "revealLibrary";

export type EventName = keyof Events;

export { EVENT_CHANNEL, INVOKE_CHANNEL } from "./channels.ts";

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(requests, value);
}

/** The object the preload script puts on `window.laya`. */
export interface LayaBridge {
  invoke<C extends Channel>(channel: C, ...args: InvokeArgs<C>): Promise<Result<Output<C>>>;
  on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void;
  platform: string;
}
