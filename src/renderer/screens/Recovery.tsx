import { FolderSearch, FolderX, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { HealthReport } from "@shared/health.ts";
import type { ChosenLocation } from "@shared/types.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LocationDialog } from "@/components/LocationDialog.tsx";
import { call, messageOf } from "@/bridge.ts";
import { WindowFrame } from "@/screens/WindowFrame.tsx";

/** The notes folder is missing or cannot be used. Nothing is created until the person decides. */
export function Recovery({ health }: { health: HealthReport }) {
  const library = health.library;
  const [chosen, setChosen] = useState<ChosenLocation | null>(null);
  const [working, setWorking] = useState(false);
  if (library.status !== "missing" && library.status !== "unusable") return null;
  const others = health.settings.recentNotesDirs.filter((item) => item !== library.path);

  const run = async (task: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await task();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setWorking(false);
    }
  };

  const retry = () =>
    run(async () => {
      const state = await call("library:retry");
      if (state.status === "missing") toast.info("The folder is still not there.");
    });

  return (
    <WindowFrame>
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <FolderX className="mb-2 size-8 text-muted-foreground" />
            <CardTitle className="text-xl">{library.status === "missing" ? "Your notes folder can't be found" : "Your notes folder can't be opened"}</CardTitle>
            <CardDescription>
              <span className="break-all font-mono text-xs">{library.path}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {library.status === "missing" ? (
              <p className="text-muted-foreground">
                If it is on an external drive or in a sync folder, connect the drive or wait for sync to start. Laya Notes checks again every few seconds
                and opens it as soon as it appears.
              </p>
            ) : (
              <p className="text-muted-foreground">{library.reason}</p>
            )}
            {others.length > 0 ? (
              <>
                <Separator />
                <p className="font-medium">Recently used</p>
                <div className="grid gap-1">
                  {others.map((item) => (
                    <Button
                      key={item}
                      variant="ghost"
                      className="justify-start font-mono text-xs"
                      disabled={working}
                      onClick={() => void run(async () => setChosen(await call("location:recent", { path: item })))}
                    >
                      {item}
                    </Button>
                  ))}
                </div>
              </>
            ) : null}
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-2">
            {library.status === "missing" ? (
              <Button variant="outline" disabled={working} onClick={() => void run(() => call("library:recreate"))}>
                Create an empty folder there
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  const picked = await call("location:choose");
                  if (picked) setChosen(picked);
                })
              }
            >
              <FolderSearch /> Choose a folder…
            </Button>
            <Button disabled={working} onClick={() => void retry()}>
              <RefreshCw /> Try again
            </Button>
          </CardFooter>
        </Card>
      </div>
      <LocationDialog chosen={chosen} canMove={false} onClose={() => setChosen(null)} onApplied={() => setChosen(null)} />
    </WindowFrame>
  );
}
