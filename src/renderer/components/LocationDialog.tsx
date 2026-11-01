import { useState } from "react";
import { toast } from "sonner";
import type { ChosenLocation } from "@shared/types.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { call, messageOf } from "@/bridge.ts";
import { describeLocation, LocationSummaryText } from "@/components/LocationSummaryText.tsx";

type LocationDialogProps = {
  chosen: ChosenLocation | null;
  /** Whether there is a current library that could be moved. */
  canMove: boolean;
  onClose: () => void;
  onApplied: () => void;
};

/** Confirms a folder picked in Settings or Recovery: open it as it is, or move the current notes into it. */
export function LocationDialog({ chosen, canMove, onClose, onApplied }: LocationDialogProps) {
  const [mode, setMode] = useState<"open" | "move">("open");
  const [working, setWorking] = useState(false);
  if (!chosen) return null;
  const { usable } = describeLocation(chosen.check);
  const emptyTarget = chosen.check.status === "missing" || (chosen.check.status === "ok" && chosen.check.kind === "empty" && chosen.check.writable);
  const moveAllowed = canMove && emptyTarget;
  const effectiveMode = moveAllowed ? mode : "open";

  const apply = async () => {
    setWorking(true);
    try {
      await call("location:apply", { token: chosen.token, mode: effectiveMode, seedSamples: false });
      toast.success(effectiveMode === "move" ? "Your notes were copied to the new folder. The old folder was left as it was." : "Switched notes folder.");
      onApplied();
    } catch (error) {
      toast.error(messageOf(error));
      onClose();
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Use this folder?</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{chosen.path}</DialogDescription>
        </DialogHeader>
        <LocationSummaryText check={chosen.check} />
        {usable && canMove ? (
          <RadioGroup value={effectiveMode} onValueChange={(value) => setMode(value as "open" | "move")} className="gap-3">
            <Label className="flex items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary">
              <RadioGroupItem value="open" className="mt-0.5" />
              <span className="grid gap-1">
                <span className="font-medium">Open that folder</span>
                <span className="text-muted-foreground text-xs">Your current notes stay where they are.</span>
              </span>
            </Label>
            <Label
              className="flex items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary data-[disabled=true]:opacity-50"
              data-disabled={!moveAllowed}
            >
              <RadioGroupItem value="move" className="mt-0.5" disabled={!moveAllowed} />
              <span className="grid gap-1">
                <span className="font-medium">Move my notes there</span>
                <span className="text-muted-foreground text-xs">
                  {moveAllowed
                    ? "Copies your notes, folders and tags, checks every file, then switches. The old folder is kept until you delete it."
                    : "Only possible into an empty folder you can write to."}
                </span>
              </span>
            </Label>
          </RadioGroup>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={!usable || working}>
            {effectiveMode === "move" ? "Move notes" : "Open folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
