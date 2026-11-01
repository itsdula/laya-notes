import { Loader2 } from "lucide-react";
import type { HealthReport } from "@shared/health.ts";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHealth } from "@/state/useHealth.ts";
import { useAppliedTheme } from "@/theme.ts";
import { Onboarding } from "@/screens/Onboarding.tsx";
import { Recovery } from "@/screens/Recovery.tsx";
import { WindowFrame } from "@/screens/WindowFrame.tsx";
import { Workspace } from "@/screens/Workspace.tsx";

export function App() {
  const { health, error, refresh } = useHealth();
  useAppliedTheme(health?.settings.theme);

  return (
    <TooltipProvider delayDuration={400}>
      <Screen health={health} error={error} refresh={refresh} />
      <Toaster theme={health?.settings.theme.mode ?? "system"} position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

function Screen({ health, error, refresh }: { health: HealthReport | null; error: string | null; refresh: () => Promise<void> }) {
  if (!health) {
    return (
      <WindowFrame>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
          {error ? (
            <>
              <p>{error}</p>
              <Button variant="outline" onClick={() => void refresh()}>
                Try again
              </Button>
            </>
          ) : (
            <Loader2 className="size-5 animate-spin" aria-label="Starting" />
          )}
        </div>
      </WindowFrame>
    );
  }

  switch (health.library.status) {
    case "unset":
      return <Onboarding />;
    case "ready":
    case "readOnly":
      return <Workspace key={health.library.path} health={health} />;
    case "missing":
    case "unusable":
      return <Recovery health={health} />;
  }
}
