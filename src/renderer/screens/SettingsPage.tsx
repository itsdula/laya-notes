import { Check, Download, FolderOpen, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HealthReport, ModelState } from "@shared/health.ts";
import type { SettingsPatch } from "@shared/settings.ts";
import { ACCENT_PALETTES, ACCENTS, NOTE_FONT_STACKS, NOTE_FONTS, RADII, RADIUS_LABELS, type Mode, type Radius, type Theme } from "@shared/theme.ts";
import type { ChosenLocation, LibraryListing } from "@shared/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmDialog } from "@/components/dialogs.tsx";
import { LocationDialog } from "@/components/LocationDialog.tsx";
import { isTransferring, ModelProgress } from "@/components/ModelDialog.tsx";
import { call, fileManagerName, messageOf } from "@/bridge.ts";
import { formatBytes, plural } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

type SettingsPageProps = {
  health: HealthReport;
  listing: LibraryListing;
  onLibraryChanged: () => void;
};

async function attempt(task: () => Promise<unknown>) {
  try {
    await task();
  } catch (error) {
    toast.error(messageOf(error));
  }
}

const update = (patch: SettingsPatch) => attempt(() => call("settings:update", patch));

export function SettingsPage({ health, listing, onLibraryChanged }: SettingsPageProps) {
  const settings = health.settings;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-8 py-8">
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <NotesFolderSection health={health} listing={listing} onLibraryChanged={onLibraryChanged} />
        <ModelSection health={health} />
        <AppearanceSection theme={settings.theme} />
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingRow label="Celebrate tagging" description="A little confetti when Laya finishes tagging. Off when your system reduces motion.">
              <Switch checked={settings.confetti} onCheckedChange={(confetti) => void update({ confetti })} aria-label="Celebrate tagging" />
            </SettingRow>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="grid gap-0.5">
        <Label className="font-medium">{label}</Label>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NotesFolderSection({ health, listing, onLibraryChanged }: SettingsPageProps) {
  const [chosen, setChosen] = useState<ChosenLocation | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const recents = health.settings.recentNotesDirs.filter((item) => item !== listing.path);

  const choose = () =>
    attempt(async () => {
      const picked = await call("location:choose");
      if (picked) setChosen(picked);
    });

  const cleanup = () =>
    attempt(async () => {
      const { removed } = await call("library:cleanupTags", { confirm: true });
      toast.success(`Removed tags for ${plural(removed, "missing note")}.`);
      onLibraryChanged();
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes folder</CardTitle>
        <CardDescription>Your notes are Markdown files in this folder. Tags are stored next to them in a hidden file named .laya-tags.json.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate font-mono text-sm" title={listing.path}>
            {listing.path}
          </span>
          {listing.readOnly ? <Badge variant="outline">Read-only</Badge> : null}
        </div>
        <p className="text-muted-foreground text-sm">
          {plural(listing.notes.length, "note")} in {plural(listing.folders.length - 1, "folder")}.
          {listing.nestedFolders > 0 ? ` ${plural(listing.nestedFolders, "nested folder")} deeper than one level are not shown.` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void call("library:reveal")}>
            Show in {fileManagerName}
          </Button>
          <Button variant="outline" onClick={() => void choose()}>
            Change…
          </Button>
        </div>
        {recents.length > 0 ? (
          <>
            <Separator />
            <div className="grid gap-1">
              <p className="font-medium text-sm">Recently used</p>
              {recents.map((item) => (
                <Button
                  key={item}
                  variant="ghost"
                  className="justify-start truncate font-mono text-xs"
                  onClick={() => void attempt(async () => setChosen(await call("location:recent", { path: item })))}
                >
                  {item}
                </Button>
              ))}
            </div>
          </>
        ) : null}
        {listing.missingTagged > 0 ? (
          <>
            <Separator />
            <SettingRow
              label="Tags for missing notes"
              description={`${plural(listing.missingTagged, "tagged note")} could not be found. They may have been renamed outside the app or not synced yet.`}
            >
              <Button variant="outline" size="sm" disabled={listing.readOnly} onClick={() => setConfirmCleanup(true)}>
                Clean up
              </Button>
            </SettingRow>
          </>
        ) : null}
      </CardContent>
      <LocationDialog
        chosen={chosen}
        canMove={!listing.readOnly}
        onClose={() => setChosen(null)}
        onApplied={() => {
          setChosen(null);
          onLibraryChanged();
        }}
      />
      <ConfirmDialog
        open={confirmCleanup}
        title="Remove tags for missing notes?"
        description="Only do this if those notes are really gone. If a sync service has not finished, their tags would be lost."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void cleanup()}
        onClose={() => setConfirmCleanup(false)}
      />
    </Card>
  );
}

const MODEL_STATUS: Record<ModelState["status"], { label: string; tone: "ok" | "busy" | "off" | "bad" }> = {
  absent: { label: "Not downloaded", tone: "off" },
  partial: { label: "Partly downloaded", tone: "off" },
  downloading: { label: "Downloading", tone: "busy" },
  verifying: { label: "Checking", tone: "busy" },
  present: { label: "Installed", tone: "ok" },
  loading: { label: "Loading", tone: "busy" },
  ready: { label: "Installed · loaded", tone: "ok" },
  error: { label: "Needs attention", tone: "bad" },
};

const TONE_DOT = { ok: "bg-emerald-500", busy: "bg-primary animate-pulse", off: "bg-muted-foreground/50", bad: "bg-destructive" };

function ModelSection({ health }: { health: HealthReport }) {
  const model = health.model;
  const state = model.state;
  const status = state.status;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const transferring = isTransferring(state);
  const complete = model.diskBytes >= model.totalBytes;
  const used = state.status === "downloading" ? state.bytes : model.diskBytes;
  const canDownload = status === "absent" || status === "partial" || (status === "error" && state.retryable && !complete);
  const canLoad = status === "present" || (status === "error" && state.retryable && complete);
  const badge = MODEL_STATUS[status];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Laya model</CardTitle>
          <CardDescription>
            Suggests tags on this computer, so your notes never leave it. It is stored with the app's data, not in your notes folder.
          </CardDescription>
        </div>
        <Badge variant="outline" className="shrink-0 gap-1.5">
          <span className={cn("size-2 rounded-full", TONE_DOT[badge.tone])} aria-hidden />
          {badge.label}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Space used</dt>
          <dd className="tabular-nums">
            {used === 0 ? (
              <>
                None <span className="text-muted-foreground">· needs {formatBytes(model.totalBytes)}</span>
              </>
            ) : (
              formatBytes(used)
            )}
            {used > 0 && used < model.totalBytes ? <span className="text-muted-foreground"> of {formatBytes(model.totalBytes)}</span> : null}
          </dd>
          {model.freeBytes !== null ? (
            <>
              <dt className="text-muted-foreground">Free on this disk</dt>
              <dd className="tabular-nums">{formatBytes(model.freeBytes)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Location</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs" title={model.directory}>
              {model.directory}
            </span>
            {used > 0 ? (
              <Button variant="link" size="sm" className="h-auto shrink-0 p-0" onClick={() => void attempt(() => call("model:reveal"))}>
                Show in {fileManagerName}
              </Button>
            ) : null}
          </dd>
        </dl>
        {status !== "absent" && status !== "present" && status !== "ready" ? <ModelProgress model={model} /> : null}
        <div className="flex flex-wrap gap-2">
          {canDownload ? (
            <Button onClick={() => void attempt(() => call("model:download"))}>
              <Download />
              {status === "partial" ? "Resume download" : status === "error" ? "Try again" : `Download ${formatBytes(model.totalBytes)}`}
            </Button>
          ) : null}
          {transferring ? (
            <Button variant="outline" onClick={() => void attempt(() => call("model:cancel"))}>
              Cancel download
            </Button>
          ) : null}
          {canLoad ? (
            <Button variant="outline" onClick={() => void attempt(() => call("model:load"))}>
              Load now
            </Button>
          ) : null}
          {!transferring && used > 0 ? (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              Delete model
            </Button>
          ) : null}
        </div>
        <Separator />
        <SettingRow label="Load when the app starts" description="Tagging starts faster, but Laya uses memory even when you are not tagging.">
          <Switch
            checked={health.settings.model.loadOnLaunch}
            onCheckedChange={(loadOnLaunch) => void update({ model: { loadOnLaunch } })}
            aria-label="Load when the app starts"
          />
        </SettingRow>
      </CardContent>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete the Laya model?"
        description={`This frees ${formatBytes(model.diskBytes)}. Your notes and tags are not affected, and you can download Laya again at any time.`}
        confirmLabel="Delete model"
        destructive
        onConfirm={() => void attempt(() => call("model:delete"))}
        onClose={() => setConfirmDelete(false)}
      />
    </Card>
  );
}

const MODE_OPTIONS: { value: Mode; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection({ theme }: { theme: Theme }) {
  const setTheme = (patch: Partial<Theme>) => void update({ theme: patch });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <SettingRow label="Mode">
          <ToggleGroup type="single" variant="outline" value={theme.mode} onValueChange={(mode) => mode && setTheme({ mode: mode as Mode })}>
            {MODE_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label} className="gap-1.5 px-3">
                <option.icon className="size-4" />
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow label="Accent color">
          <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={theme.accent === accent}
                aria-label={ACCENT_PALETTES[accent].label}
                title={ACCENT_PALETTES[accent].label}
                onClick={() => setTheme({ accent })}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow",
                  theme.accent === accent ? "ring-2 ring-foreground/60" : "hover:ring-2 hover:ring-border",
                )}
                style={{ background: accent === "neutral" ? "var(--foreground)" : ACCENT_PALETTES[accent].swatch }}
              >
                {theme.accent === accent ? (
                  <Check className={cn("size-3.5 drop-shadow-sm", accent === "neutral" ? "text-background" : "text-white")} strokeWidth={3} />
                ) : null}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Corner radius">
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(theme.radius)}
            onValueChange={(value) => value && setTheme({ radius: Number(value) as Radius })}
          >
            {RADII.map((radius) => (
              <ToggleGroupItem key={radius} value={String(radius)} className="px-3 text-xs">
                {RADIUS_LABELS[radius]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow label="Note font" description="Used for note titles and text.">
          <ToggleGroup type="single" variant="outline" value={theme.noteFont} onValueChange={(noteFont) => noteFont && setTheme({ noteFont: noteFont as Theme["noteFont"] })}>
            {NOTE_FONTS.map((font) => (
              <ToggleGroupItem key={font} value={font} className="px-3" style={{ fontFamily: NOTE_FONT_STACKS[font].stack }}>
                {NOTE_FONT_STACKS[font].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <Separator />
        <div className="grid gap-3 rounded-lg border p-4" aria-label="Preview">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">Preview</p>
          <p className="font-semibold text-lg" style={{ fontFamily: "var(--font-note)" }}>
            Weekend in Tokyo
          </p>
          <p className="text-sm" style={{ fontFamily: "var(--font-note)" }}>
            Ramen in Shinjuku, the teamLab museum, and an early morning at Tsukiji outer market.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>travel</Badge>
            <Badge variant="secondary">food</Badge>
            <div className="flex-1" />
            <Button size="sm" variant="outline">
              Cancel
            </Button>
            <Button size="sm">Save</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
