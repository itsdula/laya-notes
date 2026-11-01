import { AlertTriangle, CheckCircle2, FolderPlus, Info } from "lucide-react";
import type { LocationSummary } from "@shared/types.ts";
import { plural } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

type Line = { tone: "good" | "info" | "warn"; text: string };

/** Explains in plain words what a chosen folder holds and what Laya Notes will do with it. */
export function describeLocation(check: LocationSummary): { usable: boolean; lines: Line[] } {
  switch (check.status) {
    case "missing":
      return { usable: true, lines: [{ tone: "info", text: "This folder does not exist yet. Laya Notes will create it." }] };
    case "notADirectory":
      return { usable: false, lines: [{ tone: "warn", text: "That is a file, not a folder." }] };
    case "unreadable":
      return { usable: false, lines: [{ tone: "warn", text: "Laya Notes does not have permission to read this folder." }] };
    case "forbidden":
      return { usable: false, lines: [{ tone: "warn", text: check.reason }] };
    case "ok": {
      const lines: Line[] = [];
      if (check.kind === "empty") lines.push({ tone: "good", text: "This folder is empty." });
      if (check.kind === "library") lines.push({ tone: "good", text: `Found an existing Laya library with ${plural(check.notes, "note")}. Your tags come with it.` });
      if (check.kind === "markdown") lines.push({ tone: "good", text: `Found ${plural(check.notes, "Markdown note")}. Laya Notes will use them as they are.` });
      if (check.kind === "other") {
        lines.push({ tone: "warn", text: "This folder holds other files. Laya Notes only shows Markdown (.md) files, so a new folder may be tidier." });
      }
      if (check.nestedFolders > 0) {
        lines.push({ tone: "info", text: `${plural(check.nestedFolders, "folder")} sit more than one level deep. Notes inside them are not shown.` });
      }
      if (!check.writable) lines.push({ tone: "warn", text: "This folder is read-only. You can read notes but not change them." });
      return { usable: true, lines };
    }
  }
}

export function LocationSummaryText({ check, className }: { check: LocationSummary; className?: string }) {
  const { lines } = describeLocation(check);
  return (
    <ul className={cn("grid gap-1.5 text-sm", className)}>
      {lines.map((line) => (
        <li key={line.text} className="flex items-start gap-2">
          {line.tone === "good" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : line.tone === "warn" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : check.status === "missing" ? (
            <FolderPlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className={line.tone === "warn" ? "text-foreground" : "text-muted-foreground"}>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}
