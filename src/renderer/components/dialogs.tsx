import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const NameSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(200, "Use 200 characters or fewer."),
});

type PromptDialogProps = {
  open: boolean;
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
};

export function PromptDialog({ open, title, description, label, confirmLabel, initial = "", onClose, onSubmit }: PromptDialogProps) {
  const form = useForm<z.infer<typeof NameSchema>>({ resolver: zodResolver(NameSchema), defaultValues: { name: initial } });
  useEffect(() => {
    if (open) form.reset({ name: initial });
  }, [open, initial, form]);

  const submit = form.handleSubmit(async ({ name }) => {
    try {
      await onSubmit(name);
      onClose();
    } catch (error) {
      form.setError("name", { message: error instanceof Error ? error.message : "That did not work." });
    }
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!form.formState.errors.name}>
            <FieldLabel htmlFor="prompt-name">{label}</FieldLabel>
            <Input id="prompt-name" autoFocus autoComplete="off" {...form.register("name")} />
            <FieldError>{form.formState.errors.name?.message}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  /** Called when the dialog is dismissed without confirming. */
  onCancel?: () => void;
  /** Called whenever the dialog closes, after either choice. */
  onClose?: () => void;
};

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", destructive, onConfirm, onCancel, onClose }: ConfirmDialogProps) {
  const confirmed = useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (!confirmed.current) onCancel?.();
        confirmed.current = false;
        onClose?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              confirmed.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
