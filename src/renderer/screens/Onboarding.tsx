import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { ChosenLocation } from "@shared/types.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { describeLocation, LocationSummaryText } from "@/components/LocationSummaryText.tsx";
import { call, fileManagerName, messageOf } from "@/bridge.ts";
import { WindowFrame } from "@/screens/WindowFrame.tsx";

/** First launch: the person picks where their notes live. */
export function Onboarding() {
  const [chosen, setChosen] = useState<ChosenLocation | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [seed, setSeed] = useState(true);
  const [working, setWorking] = useState(false);

  const loadDefault = useCallback(async () => {
    try {
      setChosen(await call("location:default"));
      setIsDefault(true);
    } catch (error) {
      toast.error(messageOf(error));
    }
  }, []);

  useEffect(() => {
    void loadDefault();
  }, [loadDefault]);

  const choose = async () => {
    try {
      const picked = await call("location:choose");
      if (picked) {
        setChosen(picked);
        setIsDefault(false);
      }
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  const empty = chosen?.check.status === "missing" || (chosen?.check.status === "ok" && chosen.check.kind === "empty");
  const usable = chosen ? describeLocation(chosen.check).usable : false;

  const confirm = async () => {
    if (!chosen) return;
    setWorking(true);
    try {
      await call("location:apply", { token: chosen.token, mode: "open", seedSamples: empty && seed });
    } catch (error) {
      toast.error(messageOf(error));
      // The choice is used up once applied; offer the folder again.
      if (isDefault) await loadDefault();
      else setChosen(null);
    } finally {
      setWorking(false);
    }
  };

  return (
    <WindowFrame>
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle className="text-2xl">Welcome to Laya Notes</CardTitle>
            <CardDescription className="text-base">
              Your notes are ordinary Markdown files in a folder on this computer. You can open that folder in {fileManagerName}, back it up, or
              keep it in a folder your own sync service already covers.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">{isDefault ? "Suggested folder" : "Chosen folder"}</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-sm" title={chosen?.path}>
                  {chosen?.path ?? "…"}
                </span>
              </div>
              {chosen ? <LocationSummaryText check={chosen.check} /> : null}
            </div>
            {empty ? (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <Label htmlFor="seed" className="grid gap-1 font-normal">
                  <span className="font-medium">Start with a few example notes</span>
                  <span className="text-muted-foreground text-xs">Six short notes and five tags to try Laya with. Delete them any time.</span>
                </Label>
                <Switch id="seed" checked={seed} onCheckedChange={setSeed} />
              </div>
            ) : null}
          </CardContent>
          <CardFooter className="justify-between gap-2">
            <Button variant="outline" onClick={() => void choose()}>
              Choose another folder…
            </Button>
            <Button onClick={() => void confirm()} disabled={!chosen || !usable || working}>
              {working ? <Loader2 className="animate-spin" /> : null}
              Use this folder
            </Button>
          </CardFooter>
        </Card>
      </div>
    </WindowFrame>
  );
}
