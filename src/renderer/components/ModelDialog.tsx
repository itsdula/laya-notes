import { Download, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ModelInfo, ModelState } from "@shared/health.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { call, messageOf } from "@/bridge.ts";
import { formatBytes, formatDuration } from "@/lib/format.ts";

type ModelDialogProps = {
  open: boolean;
  model: ModelInfo;
  onClose: () => void;
  /** Called once the model is on disk, so the tagging that prompted the dialog can continue. */
  onReady: () => void;
};

export function ModelDialog({ open, model, onClose, onReady }: ModelDialogProps) {
  const state = model.state;
  const onDisk = state.status === "present" || state.status === "loading" || state.status === "ready";

  useEffect(() => {
    if (open && onDisk) onReady();
  }, [open, onDisk, onReady]);

  const start = async () => {
    try {
      await call("model:download");
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" /> Download Laya
          </DialogTitle>
          <DialogDescription>
            Laya is the model that suggests tags. It runs on this computer, so your notes never leave it. It is downloaded once, about{" "}
            {formatBytes(model.totalBytes)}, and then works without an internet connection.
          </DialogDescription>
        </DialogHeader>
        <ModelProgress model={model} />
        <DialogFooter>
          {isTransferring(state) ? (
            <>
              <Button variant="outline" onClick={() => void call("model:cancel")}>
                Cancel download
              </Button>
              <Button onClick={onClose}>Continue in background</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Not now
              </Button>
              <Button onClick={() => void start()} disabled={onDisk}>
                <Download />
                {state.status === "partial" ? "Resume download" : state.status === "error" ? "Try again" : `Download ${formatBytes(model.totalBytes)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function isTransferring(state: ModelState): state is Extract<ModelState, { status: "downloading" | "verifying" }> {
  return state.status === "downloading" || state.status === "verifying";
}

/** Bytes per second, averaged over the last few seconds of samples. */
function useRate(bytes: number | null): number | null {
  const samples = useRef<{ at: number; bytes: number }[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const list = samples.current;
    if (bytes === null) {
      list.length = 0;
      setRate(null);
      return;
    }
    const now = performance.now();
    const last = list.at(-1);
    if (last && bytes < last.bytes) list.length = 0;
    list.push({ at: now, bytes });
    while (list.length > 2 && now - list[0]!.at > 8000) list.shift();
    const first = list[0]!;
    const seconds = (now - first.at) / 1000;
    setRate(seconds >= 1 ? (bytes - first.bytes) / seconds : null);
  }, [bytes]);
  return rate;
}

function percent(bytes: number, total: number): number {
  return total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
}

/** Status, progress bar, speed and time left for the model, shared by the dialog and the settings page. */
export function ModelProgress({ model }: { model: ModelInfo }) {
  const state = model.state;
  const rate = useRate(state.status === "downloading" ? state.bytes : null);
  const free = model.freeBytes;

  if (state.status === "downloading") {
    const value = percent(state.bytes, state.totalBytes);
    const left = rate && rate > 0 ? (state.totalBytes - state.bytes) / rate : null;
    return (
      <ProgressBlock
        label={state.file ? `Downloading ${state.file}` : "Starting download…"}
        value={value}
        detail={[
          `${formatBytes(state.bytes)} of ${formatBytes(state.totalBytes)}`,
          rate !== null ? `${formatBytes(Math.max(0, rate))}/s` : null,
          left !== null ? formatDuration(left) : null,
        ]}
      />
    );
  }
  if (state.status === "verifying") {
    return (
      <ProgressBlock
        label={`Checking ${state.file}`}
        value={percent(state.bytes, state.totalBytes)}
        detail={["Making sure the file is complete and undamaged"]}
      />
    );
  }
  if (state.status === "partial") {
    return (
      <ProgressBlock
        label="Download paused"
        value={percent(state.bytes, state.totalBytes)}
        detail={[`${formatBytes(state.bytes)} of ${formatBytes(state.totalBytes)}`, "continues where it stopped"]}
      />
    );
  }
  return (
    <div className="text-sm">
      {state.status === "absent" ? <p className="text-muted-foreground">Not downloaded.{free !== null ? ` ${formatBytes(free)} free on this disk.` : ""}</p> : null}
      {state.status === "present" ? <p className="text-muted-foreground">Downloaded. It loads the first time you tag a note.</p> : null}
      {state.status === "loading" ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading Laya…
        </p>
      ) : null}
      {state.status === "ready" ? <p className="text-muted-foreground">Loaded and ready.</p> : null}
      {state.status === "error" ? <p className="text-destructive">{state.reason}</p> : null}
    </div>
  );
}

function ProgressBlock({ label, value, detail }: { label: string; value: number; detail: (string | null)[] }) {
  return (
    <div className="grid gap-2 text-sm" role="status">
      <div className="flex items-baseline justify-between gap-4">
        <span className="truncate font-medium">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{Math.floor(value)}%</span>
      </div>
      <Progress value={value} aria-label={label} />
      <p className="text-muted-foreground text-xs tabular-nums">{detail.filter(Boolean).join(" · ")}</p>
    </div>
  );
}

/** A compact progress button for the header while the model downloads in the background. */
export function ModelDownloadIndicator({ model, onOpen }: { model: ModelInfo; onOpen: () => void }) {
  const state = model.state;
  if (!isTransferring(state)) return null;
  const value = percent(state.bytes, state.totalBytes);
  const label = state.status === "downloading" ? "Downloading Laya" : "Checking Laya";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="no-drag flex items-center gap-2 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
      title="Show download progress"
    >
      <Download className="size-4 text-primary" />
      <span>{label}</span>
      <Progress value={value} className="w-20" aria-label={label} />
      <span className="w-9 text-right text-xs tabular-nums">{Math.floor(value)}%</span>
    </button>
  );
}
