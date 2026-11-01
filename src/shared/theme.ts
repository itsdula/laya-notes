import { z } from "zod";

export const ACCENTS = ["neutral", "blue", "green", "orange", "rose", "violet"] as const;
export const RADII = [0, 0.3, 0.5, 0.75, 1] as const;
export const NOTE_FONTS = ["sans", "serif", "mono"] as const;
export const MODES = ["system", "light", "dark"] as const;

export type Accent = (typeof ACCENTS)[number];
export type Radius = (typeof RADII)[number];
export type NoteFont = (typeof NOTE_FONTS)[number];
export type Mode = (typeof MODES)[number];

export const ThemeSchema = z.object({
  mode: z.enum(MODES),
  accent: z.enum(ACCENTS),
  radius: z.union([z.literal(0), z.literal(0.3), z.literal(0.5), z.literal(0.75), z.literal(1)]),
  noteFont: z.enum(NOTE_FONTS),
});

export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_THEME: Theme = { mode: "system", accent: "neutral", radius: 0.5, noteFont: "sans" };

type Pair = { primary: string; foreground: string };
/** `swatch` is unused for neutral: its picker swatch follows the text color, black in light mode and white in dark. */
type AccentPalette = { label: string; swatch: string; light: Pair; dark: Pair };

/** Each pair keeps the foreground readable on the primary color. */
export const ACCENT_PALETTES: Record<Accent, AccentPalette> = {
  neutral: {
    label: "Neutral",
    swatch: "oklch(0.205 0 0)",
    light: { primary: "oklch(0.205 0 0)", foreground: "oklch(0.985 0 0)" },
    dark: { primary: "oklch(0.922 0 0)", foreground: "oklch(0.205 0 0)" },
  },
  blue: {
    label: "Blue",
    swatch: "oklch(0.546 0.245 262.881)",
    light: { primary: "oklch(0.546 0.245 262.881)", foreground: "oklch(0.97 0.014 254.604)" },
    dark: { primary: "oklch(0.623 0.214 259.815)", foreground: "oklch(0.97 0.014 254.604)" },
  },
  green: {
    label: "Green",
    swatch: "oklch(0.527 0.154 150.069)",
    light: { primary: "oklch(0.527 0.154 150.069)", foreground: "oklch(0.982 0.018 155.826)" },
    dark: { primary: "oklch(0.723 0.219 149.579)", foreground: "oklch(0.266 0.065 152.934)" },
  },
  orange: {
    label: "Orange",
    swatch: "oklch(0.553 0.195 38.402)",
    light: { primary: "oklch(0.553 0.195 38.402)", foreground: "oklch(0.98 0.016 73.684)" },
    dark: { primary: "oklch(0.705 0.213 47.604)", foreground: "oklch(0.266 0.079 36.259)" },
  },
  rose: {
    label: "Rose",
    swatch: "oklch(0.586 0.253 17.585)",
    light: { primary: "oklch(0.586 0.253 17.585)", foreground: "oklch(0.969 0.015 12.422)" },
    dark: { primary: "oklch(0.645 0.246 16.439)", foreground: "oklch(0.969 0.015 12.422)" },
  },
  violet: {
    label: "Violet",
    swatch: "oklch(0.541 0.281 293.009)",
    light: { primary: "oklch(0.541 0.281 293.009)", foreground: "oklch(0.969 0.016 293.756)" },
    dark: { primary: "oklch(0.606 0.25 292.717)", foreground: "oklch(0.969 0.016 293.756)" },
  },
};

export const NOTE_FONT_STACKS: Record<NoteFont, { label: string; stack: string }> = {
  sans: { label: "Sans", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  serif: { label: "Serif", stack: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, Cambria, serif' },
  mono: { label: "Mono", stack: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace' },
};

export const RADIUS_LABELS: Record<Radius, string> = { 0: "None", 0.3: "Small", 0.5: "Medium", 0.75: "Large", 1: "Full" };

/** Window background before the page paints, so a dark theme does not flash white. */
export const WINDOW_BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" } as const;

export type ThemeVariable = `--${string}`;

/** The shadcn CSS variables this theme overrides. Pure, so it can be tested without a DOM. */
export function themeVariables(theme: Theme, dark: boolean): Record<ThemeVariable, string> {
  const palette = ACCENT_PALETTES[theme.accent] ?? ACCENT_PALETTES.neutral;
  const pair = dark ? palette.dark : palette.light;
  const ring = theme.accent === "neutral" ? (dark ? "oklch(0.556 0 0)" : "oklch(0.708 0 0)") : pair.primary;
  return {
    "--primary": pair.primary,
    "--primary-foreground": pair.foreground,
    "--ring": ring,
    "--sidebar-primary": pair.primary,
    "--sidebar-primary-foreground": pair.foreground,
    "--sidebar-ring": ring,
    "--radius": `${theme.radius}rem`,
    "--font-note": NOTE_FONT_STACKS[theme.noteFont]?.stack ?? NOTE_FONT_STACKS.sans.stack,
  };
}

export function resolveDark(mode: Mode, systemPrefersDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark);
}

/** Keeps every valid field and replaces the rest with defaults. */
export function salvageTheme(raw: unknown): { theme: Theme; repaired: boolean } {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let repaired = !(raw && typeof raw === "object");
  const theme = { ...DEFAULT_THEME } as Record<keyof Theme, unknown>;
  for (const key of Object.keys(ThemeSchema.shape) as (keyof Theme)[]) {
    if (!(key in record)) continue;
    const parsed = ThemeSchema.shape[key].safeParse(record[key]);
    if (parsed.success) theme[key] = parsed.data;
    else repaired = true;
  }
  return { theme: theme as Theme, repaired };
}
