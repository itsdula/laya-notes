import { ChevronDown, ChevronRight, FilePlus, FolderOpen, FolderPlus, MoreHorizontal, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { LibraryListing, NoteSummary } from "@shared/types.ts";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fileManagerName } from "@/bridge.ts";
import { cn } from "@/lib/utils.ts";

const ALL_TAGS = "__all__";

type SidebarProps = {
  listing: LibraryListing;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNote: (folder: string) => void;
  onCreateFolder: () => void;
  onRenameFolder: (name: string) => void;
  onDeleteFolder: (name: string) => void;
  onReveal: () => void;
};

export function Sidebar({ listing, selectedId, onSelect, onCreateNote, onCreateFolder, onRenameFolder, onDeleteFolder, onReveal }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState(ALL_TAGS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeTag = tag !== ALL_TAGS && listing.tags.some((item) => item.name === tag) ? tag : null;
  const filtering = !!query.trim() || !!activeTag;

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return listing.notes.filter((note) => (!activeTag || note.tags.includes(activeTag)) && (!needle || note.title.toLocaleLowerCase().includes(needle)));
  }, [listing.notes, query, activeTag]);

  const byFolder = useMemo(() => {
    const groups = new Map<string, NoteSummary[]>();
    for (const note of visible) groups.set(note.folder, [...(groups.get(note.folder) ?? []), note]);
    return groups;
  }, [visible]);

  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="grid gap-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles" className="h-9 pl-8" aria-label="Search titles" />
        </div>
        <Select value={activeTag ?? ALL_TAGS} onValueChange={setTag}>
          <SelectTrigger size="sm" className="w-full" aria-label="Filter by tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TAGS}>All tags</SelectItem>
            {listing.tags.map((item) => (
              <SelectItem key={item.name} value={item.name}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Notes">
        {filtering && visible.length === 0 ? <p className="px-2 py-6 text-center text-muted-foreground text-sm">No notes match.</p> : null}
        {listing.folders.map((folder) => {
          const notes = byFolder.get(folder.name) ?? [];
          if (filtering && notes.length === 0) return null;
          const isCollapsed = collapsed.has(folder.name) && !filtering;
          const label = folder.name || listing.rootTitle;
          return (
            <section key={folder.name || "__root"} className="mb-1">
              <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent/60">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide"
                  onClick={() => toggle(folder.name)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                  <span className="truncate">{label}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${label}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={listing.readOnly} onClick={() => onCreateNote(folder.name)}>
                      New note here
                    </DropdownMenuItem>
                    {folder.name ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={listing.readOnly} onClick={() => onRenameFolder(folder.name)}>
                          Rename folder…
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" disabled={listing.readOnly} onClick={() => onDeleteFolder(folder.name)}>
                          Move folder to Trash…
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {!isCollapsed ? (
                <ul className="mt-0.5 grid gap-px">
                  {notes.length === 0 ? <li className="px-7 py-1 text-muted-foreground text-xs">No notes</li> : null}
                  {notes.map((note) => (
                    <li key={note.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(note.id)}
                        aria-current={note.id === selectedId ? "page" : undefined}
                        className={cn(
                          "grid w-full gap-0.5 rounded-md px-3 py-1.5 pl-7 text-left text-sm transition-colors hover:bg-sidebar-accent",
                          note.id === selectedId && "bg-sidebar-accent text-sidebar-accent-foreground",
                        )}
                      >
                        <span className="truncate">{note.title}</span>
                        {note.tags.length > 0 ? <span className="truncate text-muted-foreground text-xs">{note.tags.join(" · ")}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </nav>

      <div className="grid gap-1 border-t p-2">
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className="flex-1 justify-start" disabled={listing.readOnly} onClick={() => onCreateNote("")}>
            <FilePlus /> New note
          </Button>
          <Button variant="ghost" size="sm" className="flex-1 justify-start" disabled={listing.readOnly} onClick={onCreateFolder}>
            <FolderPlus /> New folder
          </Button>
        </div>
        <button
          type="button"
          onClick={onReveal}
          title={`Show in ${fileManagerName}: ${listing.path}`}
          className="flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-muted-foreground text-xs hover:bg-sidebar-accent"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate">{listing.path}</span>
        </button>
      </div>
    </aside>
  );
}
