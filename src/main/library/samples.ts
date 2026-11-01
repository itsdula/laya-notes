import type { Tag } from "@shared/types.ts";
import type { SampleSet } from "./NotesStore.ts";
import tagCatalog from "./samples/tags.json";

const files = import.meta.glob<string>("./samples/**/*.md", { query: "?raw", import: "default", eager: true });

/** The example notes, bundled into the main process so packaged builds need no extra files. */
export const SAMPLES: SampleSet = {
  files: Object.fromEntries(Object.entries(files).map(([key, text]) => [key.replace(/^\.\/samples\//, ""), text])),
  customTags: (tagCatalog as { customTags: Tag[] }).customTags,
};
