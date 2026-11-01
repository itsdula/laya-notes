export type NoteSummary = {
  /** Path relative to the notes folder, with forward slashes: `Trips/Tokyo Weekend.md`. */
  id: string;
  title: string;
  /** Empty when the note sits directly in the notes folder. */
  folder: string;
  tags: string[];
  /** File modification time in milliseconds; used to detect edits made outside the app. */
  modified: number;
  size: number;
};

export type Note = NoteSummary & { text: string };

export type Folder = {
  /** Empty for the notes folder itself. */
  name: string;
};

export type Tag = {
  name: string;
  instructions: string;
};

export type LibraryListing = {
  path: string;
  rootTitle: string;
  readOnly: boolean;
  folders: Folder[];
  notes: NoteSummary[];
  tags: Tag[];
  /** Tag entries whose note file is not in the folder (renamed outside the app, or not synced yet). */
  missingTagged: number;
  /** Folders nested more than one level deep; their notes are not shown. */
  nestedFolders: number;
  /** One-time messages, e.g. a damaged tag file that was set aside. */
  notices: string[];
};

export type TagRunEvent =
  | { type: "started"; runId: string; count: number }
  | { type: "tagging"; runId: string; id: string; title: string; index: number; count: number }
  | { type: "tagged"; runId: string; note: NoteSummary; probabilities: Record<string, number> }
  | { type: "noteFailed"; runId: string; id: string; title: string; message: string }
  | { type: "finished"; runId: string; tagged: number; failed: number; cancelled: boolean }
  | { type: "failed"; runId: string; message: string };

export type ChosenLocation = {
  token: string;
  path: string;
  check: LocationSummary;
};

export type LocationSummary =
  | { status: "missing" }
  | { status: "notADirectory" }
  | { status: "unreadable" }
  | { status: "forbidden"; reason: string }
  | {
      status: "ok";
      writable: boolean;
      kind: "empty" | "library" | "markdown" | "other";
      notes: number;
      folders: number;
      nestedFolders: number;
      otherEntries: number;
    };
