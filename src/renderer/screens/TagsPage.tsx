import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { defaultInstructions } from "@shared/names.ts";
import type { LibraryListing, Tag } from "@shared/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/dialogs.tsx";
import { call, messageOf } from "@/bridge.ts";
import { plural } from "@/lib/format.ts";

const TagFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a tag name.").max(64, "Use 64 characters or fewer."),
  instructions: z.string().trim().max(2000, "Use 2,000 characters or fewer."),
});
type TagForm = z.infer<typeof TagFormSchema>;

type TagsPageProps = {
  listing: LibraryListing;
  tagging: boolean;
  onChanged: () => void;
  onOpenNote: (id: string) => void;
  onTagAll: () => void;
};

export function TagsPage({ listing, tagging, onChanged, onOpenNote, onTagAll }: TagsPageProps) {
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const note of listing.notes) for (const tag of note.tags) result.set(tag, (result.get(tag) ?? 0) + 1);
    return result;
  }, [listing.notes]);

  const remove = async (tag: Tag) => {
    try {
      await call("tag:delete", { name: tag.name });
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-8 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">Tags</h1>
            <p className="text-muted-foreground text-sm">
              Laya reads each note and adds the tags whose description fits. Clear instructions give better results.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={tagging || listing.readOnly || listing.tags.length === 0 || listing.notes.length === 0} onClick={onTagAll}>
              <Sparkles /> Tag all notes
            </Button>
            <Button disabled={listing.readOnly} onClick={() => setEditing("new")}>
              <Plus /> New tag
            </Button>
          </div>
        </div>

        {listing.tags.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No tags yet</CardTitle>
              <CardDescription>Create a tag like “travel” or “recipes”, then let Laya apply it to your notes.</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <div className="grid gap-3">
          {listing.tags.map((tag) => {
            const notes = listing.notes.filter((note) => note.tags.includes(tag.name));
            return (
              <Card key={tag.name} className="gap-3 py-4">
                <CardHeader className="flex flex-row items-start justify-between gap-4 px-4">
                  <div className="grid gap-1">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {tag.name}
                      <Badge variant="secondary">{plural(counts.get(tag.name) ?? 0, "note")}</Badge>
                    </CardTitle>
                    <CardDescription>{tag.instructions || defaultInstructions(tag.name)}</CardDescription>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" className="size-8" disabled={listing.readOnly} onClick={() => setEditing(tag)} aria-label={`Edit ${tag.name}`}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-8" disabled={listing.readOnly} onClick={() => setDeleting(tag)} aria-label={`Delete ${tag.name}`}>
                      <Trash2 />
                    </Button>
                  </div>
                </CardHeader>
                {notes.length > 0 ? (
                  <CardContent className="flex flex-wrap gap-1.5 px-4">
                    {notes.slice(0, 12).map((note) => (
                      <Button key={note.id} variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpenNote(note.id)}>
                        {note.title}
                      </Button>
                    ))}
                    {notes.length > 12 ? <span className="self-center text-muted-foreground text-xs">and {notes.length - 12} more</span> : null}
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>
      </div>

      <TagDialog editing={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the tag “${deleting?.name ?? ""}”?`}
        description="It is removed from every note. The notes themselves are not changed."
        confirmLabel="Delete tag"
        destructive
        onConfirm={() => deleting && void remove(deleting)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function TagDialog({ editing, onClose, onSaved }: { editing: Tag | "new" | null; onClose: () => void; onSaved: () => void }) {
  const existing = editing && editing !== "new" ? editing : null;
  const form = useForm<TagForm>({ resolver: zodResolver(TagFormSchema), values: { name: existing?.name ?? "", instructions: existing?.instructions ?? "" } });
  const name = form.watch("name");

  const submit = form.handleSubmit(async (values) => {
    try {
      if (existing) {
        await call("tag:update", {
          name: existing.name,
          next: values.name !== existing.name ? values.name : undefined,
          instructions: values.instructions,
        });
      } else {
        await call("tag:create", values);
      }
      onSaved();
      onClose();
    } catch (error) {
      form.setError("name", { message: messageOf(error) });
    }
  });

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit tag" : "New tag"}</DialogTitle>
            <DialogDescription>Laya uses the instructions to decide whether a note gets this tag.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!form.formState.errors.name}>
            <FieldLabel htmlFor="tag-name">Name</FieldLabel>
            <Input id="tag-name" autoFocus autoComplete="off" {...form.register("name")} />
            <FieldError>{form.formState.errors.name?.message}</FieldError>
          </Field>
          <Field data-invalid={!!form.formState.errors.instructions}>
            <FieldLabel htmlFor="tag-instructions">Instructions</FieldLabel>
            <Textarea id="tag-instructions" rows={4} placeholder={defaultInstructions(name.trim() || "this tag")} {...form.register("instructions")} />
            <FieldDescription>Optional. Describe which notes should get this tag. Leave empty to use the placeholder.</FieldDescription>
            <FieldError>{form.formState.errors.instructions?.message}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {existing ? "Save" : "Create tag"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
