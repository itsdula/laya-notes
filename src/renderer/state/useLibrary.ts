import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { LibraryListing } from "@shared/types.ts";
import { call, messageOf, subscribe } from "@/bridge.ts";

/** The note list. It reloads after the app's own changes and when files change on disk. */
export function useLibrary(open: boolean): { listing: LibraryListing | null; reload: () => Promise<void>; error: string | null } {
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await call("library:list");
      if (mine !== generation.current) return;
      setListing(next);
      setError(null);
      for (const notice of next.notices) toast.warning(notice, { duration: 10_000 });
    } catch (failure) {
      if (mine === generation.current) setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setListing(null);
      return;
    }
    void reload();
    return subscribe("library:changed", () => void reload());
  }, [open, reload]);

  return { listing, reload, error };
}
