import { describe, expect, it } from "vitest";
import { normalizeTag, sanitizeFolder, sanitizeTitle } from "./names.ts";
import { DEFAULT_SETTINGS, applyPatch, salvageSettings } from "./settings.ts";
import { ACCENT_PALETTES, DEFAULT_THEME, resolveDark, salvageTheme, themeVariables } from "./theme.ts";

describe("names", () => {
  it("normalizes tag names", () => {
    expect(normalizeTag("Garden Plans")).toBe("garden-plans");
    expect(normalizeTag("  Café & Co. ")).toBe("café-co");
    expect(normalizeTag("!!!")).toBeNull();
  });

  it("produces file names valid on every OS", () => {
    expect(sanitizeTitle('Q: what? <draft> "v2" a|b*c')).toBe("Q what draft v2 a b c");
    expect(sanitizeTitle("Trips/Tokyo\\Day 1")).toBe("Trips Tokyo Day 1");
    expect(sanitizeTitle("ending dots...")).toBe("ending dots");
    expect(sanitizeTitle(".hidden")).toBe("hidden");
    expect(sanitizeTitle("   ")).toBe("Untitled");
    expect(sanitizeTitle("..")).toBe("Untitled");
    expect(sanitizeFolder("")).toBe("New Folder");
  });

  it("avoids reserved Windows names", () => {
    expect(sanitizeTitle("CON")).toBe("CON note");
    expect(sanitizeTitle("nul.backup")).toBe("nul.backup note");
    expect(sanitizeTitle("Console")).toBe("Console");
  });

  it("limits length without splitting characters", () => {
    const long = "🙂".repeat(300);
    const result = sanitizeTitle(long);
    expect(Array.from(result)).toHaveLength(200);
    expect(result.endsWith("🙂")).toBe(true);
  });
});

describe("theme", () => {
  it("maps settings to shadcn variables", () => {
    const variables = themeVariables({ mode: "light", accent: "blue", radius: 0.75, noteFont: "serif" }, false);
    expect(variables["--primary"]).toBe(ACCENT_PALETTES.blue.light.primary);
    expect(variables["--ring"]).toBe(ACCENT_PALETTES.blue.light.primary);
    expect(variables["--sidebar-primary"]).toBe(ACCENT_PALETTES.blue.light.primary);
    expect(variables["--radius"]).toBe("0.75rem");
    expect(variables["--font-note"]).toContain("serif");
  });

  it("uses the dark pair in dark mode", () => {
    const variables = themeVariables({ ...DEFAULT_THEME, accent: "green" }, true);
    expect(variables["--primary"]).toBe(ACCENT_PALETTES.green.dark.primary);
    expect(variables["--primary-foreground"]).toBe(ACCENT_PALETTES.green.dark.foreground);
  });

  it("resolves the system mode", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });

  it("keeps valid theme fields and repairs the rest", () => {
    const { theme, repaired } = salvageTheme({ mode: "dark", accent: "purple", radius: 3, noteFont: "mono" });
    expect(theme).toEqual({ mode: "dark", accent: "neutral", radius: 0.5, noteFont: "mono" });
    expect(repaired).toBe(true);
  });
});

describe("settings", () => {
  it("keeps the notes folder when other fields are damaged", () => {
    const { settings, repaired } = salvageSettings({ version: 1, notesDir: "/Users/a/Notes", confetti: "yes", theme: { accent: "rose" } });
    expect(settings.notesDir).toBe("/Users/a/Notes");
    expect(settings.confetti).toBe(true);
    expect(settings.theme.accent).toBe("rose");
    expect(repaired).toEqual(["confetti"]);
  });

  it("falls back to defaults for a non-object", () => {
    expect(salvageSettings([1, 2]).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("merges partial patches", () => {
    const next = applyPatch(DEFAULT_SETTINGS, { theme: { accent: "violet" }, model: { loadOnLaunch: true } });
    expect(next.theme).toEqual({ ...DEFAULT_THEME, accent: "violet" });
    expect(next.model.loadOnLaunch).toBe(true);
    expect(next.notesDir).toBeNull();
  });
});
