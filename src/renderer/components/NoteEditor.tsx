import { Placeholder } from "@tiptap/extension-placeholder";
import { useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Loader2, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { LibraryListing, NoteSummary } from "@shared/types.ts";
import { RichTextEditor } from "@/components/editor";
import { Markdown } from "@/components/extensions/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { call, messageOf } from "@/bridge.ts";
import { useNoteDocument } from "@/state/useNoteDocument.ts";
import { ConfirmDialog } from "@/components/dialogs.tsx";

const ROOT_VALUE = "__root__";

type NoteEditorProps = {
  summary: NoteSummary;
  listing: LibraryListing;
  tagging: boolean;
  onIdChange: (from: string, to: string) => void;
  onChanged: () => void;
  onDelete: () => void;
  onAiTag: (id: string) => void;
  registerFlush: (flush: (() => Promise<void>) | null) => void;
};

export function NoteEditor({ summary, listing, tagging, onIdChange, onChanged, onDelete, onAiTag, registerFlush }: NoteEditorProps) {
  const readOnly = listing.readOnly;
  const document = useNoteDocument(summary.id, () => onChanged());
  const [title, setTitle] = useState(summary.title);
  const [draftTag, setDraftTag] = useState("");
  const loadedFor = useRef<string | null>(null);
  // Until the file is in the editor, any update is the editor's own setup and must never be saved.
  const loaded = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: "Write something…" }),
      Markdown.configure({ pasteMarkdown: true }),
    ],
    editable: !readOnly,
    immediatelyRender: true,
    onUpdate: ({ editor: current }) => {
      if (loaded.current) document.edit(current.getMarkdown());
    },
  });

  useEffect(() => {
    setTitle(summary.title);
  }, [summary.title]);

  // Load the file into the editor without marking it as edited, so opening a note never rewrites it.
  useEffect(() => {
    if (!editor || !document.note) return;
    const key = `${document.note.id}:${document.note.modified}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    loaded.current = false;
    editor.commands.setContent(document.note.text, { contentType: "markdown", emitUpdate: false });
    loaded.current = true;
  }, [editor, document.note]);

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useEffect(() => {
    void document.externalChange(summary.modified);
  }, [summary.modified, document.externalChange]);

  // Reads the editor itself: typing can still be on its way to onUpdate when the person renames or switches notes.
  const flush = useCallback(async () => {
    if (editor && loaded.current && !readOnly) document.edit(editor.getMarkdown());
    await document.flush();
  }, [editor, readOnly, document.edit, document.flush]);

  useEffect(() => {
    registerFlush(flush);
    return () => registerFlush(null);
  }, [registerFlush, flush]);

  const commitTitle = async () => {
    const next = title.trim();
    if (!next || next === summary.title) {
      setTitle(summary.title);
      return;
    }
    try {
      await flush();
      const renamed = await call("note:rename", { id: summary.id, title: next });
      setTitle(renamed.title);
      onIdChange(summary.id, renamed.id);
    } catch (error) {
      setTitle(summary.title);
      toast.error(messageOf(error));
    }
  };

  const moveTo = async (value: string) => {
    const folder = value === ROOT_VALUE ? "" : value;
    try {
      await flush();
      const moved = await call("note:move", { id: summary.id, folder });
      onIdChange(summary.id, moved.id);
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  const addTag = async (event: FormEvent) => {
    event.preventDefault();
    const tag = draftTag.trim();
    if (!tag) return;
    setDraftTag("");
    try {
      await call("note:tag:add", { id: summary.id, tag });
      onChanged();
    } catch (error) {
      setDraftTag(tag);
      toast.error(messageOf(error));
    }
  };

  const removeTag = async (tag: string) => {
    try {
      await call("note:tag:remove", { id: summary.id, tag });
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  const saveLabel = { saved: "Saved", unsaved: "Edited", saving: "Saving…", error: "Not saved" }[document.saveState];

  if (document.loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-muted-foreground">{document.loadError}</p>
        <Button variant="outline" onClick={() => void document.load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Select value={summary.folder || ROOT_VALUE} onValueChange={(value) => void moveTo(value)} disabled={readOnly}>
          <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Folder">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {listing.folders.map((folder) => (
              <SelectItem key={folder.name || ROOT_VALUE} value={folder.name || ROOT_VALUE}>
                {folder.name || listing.rootTitle}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {summary.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              {!readOnly ? (
                <button type="button" className="rounded-sm opacity-60 hover:opacity-100" aria-label={`Remove tag ${tag}`} onClick={() => void removeTag(tag)}>
                  <X className="size-3" />
                </button>
              ) : null}
            </Badge>
          ))}
          {!readOnly ? (
            <form onSubmit={addTag}>
              <Input
                value={draftTag}
                onChange={(event) => setDraftTag(event.target.value)}
                placeholder="Add tag"
                list="tag-suggestions"
                className="h-7 w-28 text-xs"
                aria-label="Add tag"
              />
              <datalist id="tag-suggestions">
                {listing.tags
                  .filter((tag) => !summary.tags.includes(tag.name))
                  .map((tag) => (
                    <option key={tag.name} value={tag.name} />
                  ))}
              </datalist>
            </form>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs" role="status">
          {readOnly ? "Read-only" : saveLabel}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" disabled={tagging || readOnly || listing.tags.length === 0} onClick={() => onAiTag(summary.id)}>
              {tagging ? <Loader2 className="animate-spin" /> : <Sparkles />}
              AI Tag
            </Button>
          </TooltipTrigger>
          <TooltipContent>{listing.tags.length === 0 ? "Add tags first, on the Tags page." : "Ask Laya which of your tags apply to this note."}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" disabled={readOnly} onClick={onDelete} aria-label="Delete note">
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Move this note to the Trash</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-8 pb-24">
          <input
            className="mb-4 w-full bg-transparent font-semibold text-3xl tracking-tight outline-none placeholder:text-muted-foreground/60"
            style={{ fontFamily: "var(--font-note)" }}
            value={title}
            disabled={readOnly}
            aria-label="Title"
            placeholder="Untitled"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                editor?.commands.focus("start");
              }
              if (event.key === "Escape") setTitle(summary.title);
            }}
          />
          {document.note ? (
            <RichTextEditor editor={editor} variant="subtle" className="note-editor border-0 bg-transparent">
              {!readOnly ? (
                <RichTextEditor.Toolbar sticky className="-mx-2 mb-2 bg-background/95 backdrop-blur">
                  <RichTextEditor.ControlsGroup>
                    <RichTextEditor.Bold />
                    <RichTextEditor.Italic />
                    <RichTextEditor.Strikethrough />
                    <RichTextEditor.Code />
                  </RichTextEditor.ControlsGroup>
                  <RichTextEditor.ControlsGroup>
                    <RichTextEditor.H1 />
                    <RichTextEditor.H2 />
                    <RichTextEditor.H3 />
                  </RichTextEditor.ControlsGroup>
                  <RichTextEditor.ControlsGroup>
                    <RichTextEditor.BulletList />
                    <RichTextEditor.OrderedList />
                    <RichTextEditor.Blockquote />
                    <RichTextEditor.CodeBlock />
                    <RichTextEditor.Hr />
                  </RichTextEditor.ControlsGroup>
                  <RichTextEditor.ControlsGroup>
                    <RichTextEditor.Link />
                    <RichTextEditor.Unlink />
                  </RichTextEditor.ControlsGroup>
                  <RichTextEditor.ControlsGroup>
                    <RichTextEditor.Undo />
                    <RichTextEditor.Redo />
                  </RichTextEditor.ControlsGroup>
                </RichTextEditor.Toolbar>
              ) : null}
              <RichTextEditor.Content />
            </RichTextEditor>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" /> Opening…
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={document.conflict === "changed"}
        title="This note changed outside Laya Notes"
        description="Another app or a sync service changed the file since you opened it. Load that version, or keep the text in the editor and overwrite the file."
        confirmLabel="Keep mine"
        cancelLabel="Load that version"
        onCancel={() => void document.load()}
        onConfirm={() => void document.save(true)}
      />
      <ConfirmDialog
        open={document.conflict === "deleted"}
        title="This note's file is gone"
        description="It was deleted or renamed outside Laya Notes. Save your text as this note again, or discard it."
        confirmLabel="Save it again"
        cancelLabel="Discard"
        onCancel={() => {
          document.setConflict(null);
          onChanged();
        }}
        onConfirm={() => void document.save(true)}
      />
    </div>
  );
}
