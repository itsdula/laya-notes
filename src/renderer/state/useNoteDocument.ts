import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteSummary } from "@shared/types.ts";
import { call, isCode, messageOf } from "@/bridge.ts";

export type SaveState = "saved" | "unsaved" | "saving" | "error";
/** `changed`: edited outside the app since it was opened. `deleted`: removed or renamed outside the app. */
export type Conflict = "changed" | "deleted" | null;

const AUTOSAVE_MS = 700;

/**
 * Loads one note and saves it as the person types. Each save carries the file time the editor last saw,
 * so a change made in another app is never silently overwritten.
 */
export function useNoteDocument(id: string, onSaved: (summary: NoteSummary) => void) {
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<Conflict>(null);
  const baseModified = useRef<number | null>(null);
  const savedText = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const load = useCallback(async () => {
    try {
      const loaded = await call("note:read", { id });
      baseModified.current = loaded.modified;
      savedText.current = loaded.text;
      pending.current = null;
      setNote(loaded);
      setConflict(null);
      setSaveState("saved");
      setLoadError(null);
      return loaded;
    } catch (error) {
      setLoadError(messageOf(error));
      return null;
    }
  }, [id]);

  useEffect(() => {
    setNote(null);
    void load();
  }, [load]);

  const save = useCallback(
    (force = false): Promise<void> => {
      chain.current = chain.current.then(async () => {
        const text = pending.current;
        if (text === null) return;
        setSaveState("saving");
        try {
          const summary = await call("note:save", { id, text, baseModified: baseModified.current, force });
          baseModified.current = summary.modified;
          savedText.current = text;
          if (pending.current === text) pending.current = null;
          setConflict(null);
          setSaveState(pending.current === null ? "saved" : "unsaved");
          savedRef.current(summary);
        } catch (error) {
          setSaveState("error");
          if (isCode(error, "CONFLICT")) setConflict("changed");
          else if (isCode(error, "NOT_FOUND")) setConflict("deleted");
          else throw error;
        }
      });
      return chain.current;
    },
    [id],
  );

  const edit = useCallback(
    (text: string) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      if (text === savedText.current) {
        pending.current = null;
        setSaveState("saved");
        return;
      }
      pending.current = text;
      setSaveState("unsaved");
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void save().catch(() => undefined);
      }, AUTOSAVE_MS);
    },
    [save],
  );

  /** Saves anything waiting now, e.g. before tagging, renaming or switching notes. */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null && !conflict) await save();
    else await chain.current;
  }, [save, conflict]);

  /** The file on disk changed. Reload it if nothing is waiting to be saved; otherwise ask. */
  const externalChange = useCallback(
    async (modified: number) => {
      if (modified === baseModified.current) return null;
      await chain.current;
      if (modified === baseModified.current) return null;
      if (pending.current !== null) {
        setConflict("changed");
        return null;
      }
      return load();
    },
    [load],
  );

  useEffect(() => {
    // The request is sent before the page goes away, so the main process still writes it.
    const unloading = () => {
      if (pending.current === null) return;
      void call("note:save", { id, text: pending.current, baseModified: baseModified.current }).catch(() => undefined);
      pending.current = null;
    };
    window.addEventListener("pagehide", unloading);
    return () => {
      window.removeEventListener("pagehide", unloading);
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (pending.current !== null) void save().catch(() => undefined);
    };
  }, [id, save]);

  return { note, loadError, saveState, conflict, edit, flush, save, load, externalChange, setConflict };
}
