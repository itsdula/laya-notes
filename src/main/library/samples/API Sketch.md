# API sketch

`POST /notes` creates a Markdown file. `PATCH /notes` writes the body. Tags live in a JSON index beside the files, so the note itself stays plain text.

The handler should refuse a path that climbs out of the notes directory. A folder is a real directory, one level deep, and a note with no folder sits in the storage directory.

```ts
type Note = {
  id: string;
  folderName: string;
  tags: string[];
};
```

Keep the response small enough that saving on each pause does not feel heavy.
