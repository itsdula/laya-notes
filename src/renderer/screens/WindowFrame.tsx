import type { ReactNode } from "react";
import { isMac } from "@/bridge.ts";
import { cn } from "@/lib/utils.ts";

/** A draggable title area for screens without the main header; leaves room for the macOS window buttons. */
export function WindowFrame({ children, title = "Laya Notes" }: { children: ReactNode; title?: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("drag-region flex h-12 shrink-0 items-center justify-center text-muted-foreground text-sm", isMac ? "" : "hidden")}>{title}</div>
      {children}
    </div>
  );
}
