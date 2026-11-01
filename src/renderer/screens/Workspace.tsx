import confetti from "canvas-confetti";
import { FileText, Loader2, NotebookPen, Settings as SettingsIcon, Sparkles, Tags as TagsIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { HealthReport } from "@shared/health.ts";
import type { AppCommand } from "@shared/ipc.ts";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog, PromptDialog } from "@/components/dialogs.tsx";
import { isTransferring, ModelDialog, ModelDownloadIndicator } from "@/components/ModelDialog.tsx";
import { NoteEditor } from "@/components/NoteEditor.tsx";
import { Sidebar } from "@/components/Sidebar.tsx";
import { call, isCode, isMac, messageOf, subscribe } from "@/bridge.ts";
import { cn } from "@/lib/utils.ts";
import { useLibrary } from "@/state/useLibrary.ts";
import { useTagging } from "@/state/useTagging.ts";
import { SettingsPage } from "@/screens/SettingsPage.tsx";
import { TagsPage } from "@/screens/TagsPage.tsx";

let cannon: confetti.CreateTypes | null = null;

/** The default confetti instance draws in a worker made from a blob: URL, which the app's Content Security Policy blocks. */
function burst(): confetti.CreateTypes {
  if (cannon) return cannon;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "100" });
  document.body.append(canvas);
  cannon = confetti.create(canvas, { resize: true, useWorker: false });
  return cannon;
}

type Page = "notes" | "tags" | "settings";
type FolderPrompt = { mode: "create" } | { mode: "rename"; name: string } | null;
type PendingDelete = { kind: "note"; id: string; title: string } | { kind: "folder"; name: string } | null;

export function Workspace({ health }: { health: HealthReport }) {
  const { listing, reload, error } = useLibrary(true);
  const [page, setPage] = useState<Page>("notes");
  const [selectedId, setSelectedId] = useState<string | null>(health.settings.lastNoteId);
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  /** `tag` is set when the dialog opened because tagging needed the model; tagging resumes once it is on disk. */
  const [modelPrompt, setModelPrompt] = useState<{ tag: false } | { tag: true; ids?: string[] } | null>(null);
  const wasTransferring = useRef(isTransferring(health.model.state));
  useEffect(() => {
    const transferring = isTransferring(health.model.state);
    if (wasTransferring.current && health.model.state.status === "present") toast.success("Laya is downloaded and ready to tag notes.");
    wasTransferring.current = transferring;
  }, [health.model.state]);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushRef.current = flush;
  }, []);

  const celebrate = useCallback(() => {
    if (!health.settings.confetti || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    void burst()({ particleCount: 120, spread: 70, startVelocity: 55, ticks: 300, origin: { y: 1 }, disableForReducedMotion: true });
  }, [health.settings.confetti]);

  const tagging = useTagging({ onTagged: () => void reload(), onCelebrate: celebrate });

  const selected = listing?.notes.find((note) => note.id === selectedId) ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => void call("settings:update", { lastNoteId: selectedId }).catch(() => undefined), 500);
    return () => window.clearTimeout(timer);
  }, [selectedId]);

  useEffect(() => {
    if (listing && selectedId && !listing.notes.some((note) => note.id === selectedId)) setSelectedId(null);
  }, [listing, selectedId]);

  const select = async (id: string | null) => {
    await flushRef.current?.().catch(() => undefined);
    setSelectedId(id);
    setPage("notes");
  };

  const createNote = async (folder: string) => {
    try {
      const note = await call("note:create", { folder });
      await reload();
      await select(note.id);
    } catch (failure) {
      toast.error(messageOf(failure));
    }
  };

  const aiTag = async (ids?: string[]) => {
    await flushRef.current?.().catch(() => undefined);
    try {
      await tagging.start(ids);
    } catch (failure) {
      if (isCode(failure, "MODEL_UNAVAILABLE")) setModelPrompt({ tag: true, ids });
      else toast.error(messageOf(failure));
    }
  };

  const runCommand = useCallback(
    (command: AppCommand) => {
      if (command === "newNote") void createNote(selected?.folder ?? "");
      if (command === "newFolder") setFolderPrompt({ mode: "create" });
      if (command === "openNotes") setPage("notes");
      if (command === "openTags") setPage("tags");
      if (command === "openSettings") setPage("settings");
      if (command === "revealLibrary") void call("library:reveal");
    },
    // createNote only reads the selected folder at the time of the command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.folder],
  );

  useEffect(() => subscribe("app:command", ({ command }) => runCommand(command)), [runCommand]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      if (pendingDelete.kind === "note") {
        await call("note:delete", { id: pendingDelete.id });
        if (selectedId === pendingDelete.id) setSelectedId(null);
      } else {
        await call("folder:delete", { name: pendingDelete.name });
        if (selected?.folder === pendingDelete.name) setSelectedId(null);
      }
      await reload();
    } catch (failure) {
      toast.error(messageOf(failure));
    }
  };

  const navItems: { page: Page; label: string; icon: typeof FileText }[] = [
    { page: "notes", label: "Notes", icon: NotebookPen },
    { page: "tags", label: "Tags", icon: TagsIcon },
    { page: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <Tabs value={page} onValueChange={(value) => setPage(value as Page)} className="h-full gap-0">
      <header className={cn("drag-region flex h-12 shrink-0 items-center gap-3 border-b px-3", isMac && "pl-20")}>
        <TabsList className="no-drag" aria-label="Pages">
          {navItems.map((item) => (
            <TabsTrigger key={item.page} value={item.page}>
              <item.icon />
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1" />
        <ModelDownloadIndicator model={health.model} onOpen={() => setModelPrompt({ tag: false })} />
        {tagging.status ? (
          <div className="no-drag flex items-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span className="max-w-64 truncate text-muted-foreground">{tagging.status.text}</span>
            {tagging.status.count > 1 ? <Progress value={(tagging.status.index / tagging.status.count) * 100} className="w-24" /> : null}
            <Button variant="ghost" size="icon" className="size-7" onClick={tagging.cancel} aria-label="Stop tagging">
              <X />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="no-drag"
            disabled={!listing || listing.readOnly || listing.tags.length === 0 || listing.notes.length === 0}
            onClick={() => void aiTag()}
          >
            <Sparkles /> Tag all notes
          </Button>
        )}
      </header>

      {listing?.readOnly ? (
        <div className="border-b bg-amber-500/10 px-4 py-1.5 text-center text-amber-900 text-xs dark:text-amber-200">
          This notes folder is read-only. You can read notes, but changes cannot be saved.
        </div>
      ) : null}
      {health.appData.status === "degraded" ? (
        <div className="border-b bg-amber-500/10 px-4 py-1.5 text-center text-amber-900 text-xs dark:text-amber-200">{health.appData.reason}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!listing ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            {error ? (
              <div className="grid justify-items-center gap-3">
                <p>{error}</p>
                <Button variant="outline" onClick={() => void reload()}>
                  Try again
                </Button>
              </div>
            ) : (
              <Loader2 className="size-5 animate-spin" />
            )}
          </div>
        ) : (
          <>
            <TabsContent value="notes" className="flex min-w-0">
              <Sidebar
                listing={listing}
                selectedId={selectedId}
                onSelect={(id) => void select(id)}
                onCreateNote={(folder) => void createNote(folder)}
                onCreateFolder={() => setFolderPrompt({ mode: "create" })}
                onRenameFolder={(name) => setFolderPrompt({ mode: "rename", name })}
                onDeleteFolder={(name) => setPendingDelete({ kind: "folder", name })}
                onReveal={() => void call("library:reveal")}
              />
              <main className="flex min-w-0 flex-1 flex-col">
                {selected ? (
                  <NoteEditor
                    key={selected.id}
                    summary={selected}
                    listing={listing}
                    tagging={tagging.busy}
                    onIdChange={(from, to) => {
                      void reload().then(() => setSelectedId((current) => (current === from ? to : current)));
                    }}
                    onChanged={() => void reload()}
                    onDelete={() => setPendingDelete({ kind: "note", id: selected.id, title: selected.title })}
                    onAiTag={(id) => void aiTag([id])}
                    registerFlush={registerFlush}
                  />
                ) : (
                  <EmptyState hasNotes={listing.notes.length > 0} readOnly={listing.readOnly} onCreate={() => void createNote("")} />
                )}
              </main>
            </TabsContent>
            <TabsContent value="tags" className="flex min-w-0">
              <TagsPage listing={listing} onChanged={() => void reload()} onOpenNote={(id) => void select(id)} onTagAll={() => void aiTag()} tagging={tagging.busy} />
            </TabsContent>
            <TabsContent value="settings" className="flex min-w-0">
              <SettingsPage health={health} listing={listing} onLibraryChanged={() => void reload()} />
            </TabsContent>
          </>
        )}
      </div>

      <PromptDialog
        open={folderPrompt !== null}
        title={folderPrompt?.mode === "rename" ? "Rename folder" : "New folder"}
        description={folderPrompt?.mode === "rename" ? "This renames the folder on disk. Notes inside it stay together." : "This creates a real folder inside your notes folder."}
        label="Folder name"
        confirmLabel={folderPrompt?.mode === "rename" ? "Rename" : "Create"}
        initial={folderPrompt?.mode === "rename" ? folderPrompt.name : ""}
        onClose={() => setFolderPrompt(null)}
        onSubmit={async (name) => {
          if (folderPrompt?.mode === "rename") {
            const from = folderPrompt.name;
            const renamed = await call("folder:rename", { name: from, next: name });
            setSelectedId((current) => (current?.startsWith(`${from}/`) ? `${renamed.name}/${current.slice(from.length + 1)}` : current));
          } else {
            await call("folder:create", { name });
          }
          await reload();
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "note" ? `Move “${pendingDelete.title}” to the Trash?` : `Move the folder “${pendingDelete?.name ?? ""}” to the Trash?`}
        description={
          pendingDelete?.kind === "note"
            ? "The Markdown file goes to the Trash, so you can still restore it from there."
            : "The folder and every note inside it go to the Trash, so you can still restore them from there."
        }
        confirmLabel="Move to Trash"
        destructive
        onConfirm={() => void confirmDelete()}
        onClose={() => setPendingDelete(null)}
      />
      <ModelDialog
        open={modelPrompt !== null}
        model={health.model}
        onClose={() => setModelPrompt(null)}
        onReady={() => {
          const prompt = modelPrompt;
          setModelPrompt(null);
          if (prompt?.tag) void aiTag(prompt.ids);
        }}
      />
    </Tabs>
  );
}

function EmptyState({ hasNotes, readOnly, onCreate }: { hasNotes: boolean; readOnly: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FileText className="size-10 text-muted-foreground/60" />
      <h2 className="font-semibold text-lg">{hasNotes ? "Choose a note" : "No notes yet"}</h2>
      <p className="max-w-sm text-muted-foreground text-sm">
        {hasNotes ? "Pick a note from the list on the left." : "Each note is a Markdown file in your notes folder. Create one to get started."}
      </p>
      {!readOnly ? <Button onClick={onCreate}>New note</Button> : null}
    </div>
  );
}
