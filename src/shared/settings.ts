import { z } from "zod";
import { DEFAULT_THEME, salvageTheme, ThemeSchema } from "./theme.ts";

const WindowSchema = z.object({
  width: z.number().int().min(640).max(10_000),
  height: z.number().int().min(420).max(10_000),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  maximized: z.boolean().optional(),
});

export const SettingsSchema = z.object({
  version: z.literal(1),
  notesDir: z.string().min(1).nullable(),
  recentNotesDirs: z.array(z.string().min(1)).max(5),
  lastNoteId: z.string().nullable(),
  confetti: z.boolean(),
  model: z.object({ loadOnLaunch: z.boolean() }),
  theme: ThemeSchema,
  window: WindowSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  notesDir: null,
  recentNotesDirs: [],
  lastNoteId: null,
  confetti: true,
  model: { loadOnLaunch: false },
  theme: DEFAULT_THEME,
  window: { width: 1200, height: 780 },
};

/** What the window may change directly. The notes folder changes only through the location flow. */
export const SettingsPatchSchema = z
  .object({
    lastNoteId: z.string().max(1024).nullable(),
    confetti: z.boolean(),
    model: z.object({ loadOnLaunch: z.boolean() }).partial(),
    theme: ThemeSchema.partial(),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  return {
    ...settings,
    ...(patch.lastNoteId !== undefined ? { lastNoteId: patch.lastNoteId } : {}),
    ...(patch.confetti !== undefined ? { confetti: patch.confetti } : {}),
    model: { ...settings.model, ...patch.model },
    theme: { ...settings.theme, ...patch.theme },
  };
}

/**
 * Reads whatever is valid out of a parsed settings file. A damaged field falls back to its default
 * instead of discarding the whole file, so a bad theme value never loses the notes folder path.
 */
export function salvageSettings(raw: unknown): { settings: Settings; repaired: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: structuredClone(DEFAULT_SETTINGS), repaired: ["settings"] };
  }
  const record = raw as Record<string, unknown>;
  const settings = structuredClone(DEFAULT_SETTINGS) as Record<keyof Settings, unknown>;
  const repaired: string[] = [];
  for (const key of Object.keys(SettingsSchema.shape) as (keyof Settings)[]) {
    if (!(key in record)) continue;
    if (key === "theme") {
      const result = salvageTheme(record.theme);
      settings.theme = result.theme;
      if (result.repaired) repaired.push("theme");
      continue;
    }
    const parsed = SettingsSchema.shape[key].safeParse(record[key]);
    if (parsed.success) settings[key] = parsed.data;
    else repaired.push(key);
  }
  return { settings: settings as Settings, repaired };
}
