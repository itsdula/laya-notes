/** Characters no file name may contain on Windows, macOS or Linux, plus control characters. */
const INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Device names Windows reserves, with or without an extension. */
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export const MAX_NAME_LENGTH = 200;

/** Tag names: lowercase words joined by hyphens (`Garden Plans` becomes `garden-plans`). */
export function normalizeTag(raw: string): string | null {
  const pieces = raw
    .trim()
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (pieces.length === 0) return null;
  return pieces.join("-").slice(0, 64);
}

export function defaultInstructions(name: string): string {
  return `Does this note match the tag "${name}"?`;
}

/**
 * Turns a title into a file or folder name that is valid on every OS, so a synced notes folder works
 * on a Mac and a PC alike. Never returns an empty name, a hidden name, or a reserved Windows name.
 */
export function sanitizeName(raw: string, fallback = "Untitled"): string {
  let name = raw.normalize("NFC").replace(INVALID_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  const characters = Array.from(name);
  if (characters.length > MAX_NAME_LENGTH) {
    name = characters.slice(0, MAX_NAME_LENGTH).join("").replace(/[.\s]+$/, "");
  }
  if (!name) return fallback;
  const stem = name.split(".")[0]?.trim() ?? name;
  if (RESERVED_WINDOWS.test(stem)) name = `${name} note`;
  return name;
}

export function sanitizeTitle(raw: string): string {
  return sanitizeName(raw, "Untitled");
}

export function sanitizeFolder(raw: string): string {
  return sanitizeName(raw, "New Folder");
}
