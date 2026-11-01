import { useEffect, useState } from "react";
import { resolveDark, themeVariables, type Theme } from "@shared/theme.ts";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const dark = resolveDark(theme.mode, darkQuery.matches);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  for (const [name, value] of Object.entries(themeVariables(theme, dark))) root.style.setProperty(name, value);
}

/** Applies the theme now and again whenever the OS switches between light and dark. */
export function useAppliedTheme(theme: Theme | undefined): void {
  const [systemDark, setSystemDark] = useState(darkQuery.matches);
  useEffect(() => {
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    darkQuery.addEventListener("change", listener);
    return () => darkQuery.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme, systemDark]);
}
