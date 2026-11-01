import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { NoteSummary, TagRunEvent } from "@shared/types.ts";
import { call, subscribe } from "@/bridge.ts";

export type TaggingStatus = {
  runId: string;
  text: string;
  index: number;
  count: number;
};

type Options = {
  onTagged: (note: NoteSummary) => void;
  onCelebrate: () => void;
};

/** Starts tagging runs and follows their progress events. */
export function useTagging({ onTagged, onCelebrate }: Options) {
  const [status, setStatus] = useState<TaggingStatus | null>(null);
  const handlers = useRef({ onTagged, onCelebrate });
  handlers.current = { onTagged, onCelebrate };
  const single = useRef(false);

  useEffect(
    () =>
      subscribe("tagging:event", (event: TagRunEvent) => {
        switch (event.type) {
          case "started":
            setStatus({ runId: event.runId, text: "Loading Laya…", index: 0, count: event.count });
            break;
          case "tagging":
            setStatus({ runId: event.runId, text: `Tagging ${event.title}`, index: event.index, count: event.count });
            break;
          case "tagged":
            handlers.current.onTagged(event.note);
            if (single.current) {
              toast.success(event.note.tags.length ? `Laya tagged ${event.note.title}: ${event.note.tags.join(", ")}` : `Laya found no matching tags for ${event.note.title}.`);
              handlers.current.onCelebrate();
            }
            break;
          case "noteFailed":
            toast.error(`Laya could not tag ${event.title}. ${event.message}`);
            break;
          case "finished":
            setStatus(null);
            if (event.cancelled) toast.info(`Tagging stopped after ${event.tagged} notes.`);
            else if (!single.current && event.tagged > 0) {
              toast.success(`Laya tagged ${event.tagged} notes${event.failed ? `; ${event.failed} could not be tagged` : ""}.`);
              handlers.current.onCelebrate();
            }
            break;
          case "failed":
            setStatus(null);
            toast.error(event.message);
            break;
        }
      }),
    [],
  );

  const start = useCallback(async (ids?: string[]) => {
    single.current = ids?.length === 1;
    const { runId } = await call("tagging:start", ids ? { ids } : {});
    setStatus((current) => current ?? { runId, text: "Starting…", index: 0, count: ids?.length ?? 0 });
  }, []);

  const cancel = useCallback(() => {
    if (status) void call("tagging:cancel", { runId: status.runId });
  }, [status]);

  return { status, start, cancel, busy: status !== null };
}
