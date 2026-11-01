import { Menu, type MenuItemConstructorOptions } from "electron";
import type { EventName, Events } from "@shared/ipc.ts";

type MenuOptions = {
  emit: <E extends EventName>(event: E, payload: Events[E]) => void;
  isPackaged: boolean;
};

export function buildMenu({ emit, isPackaged }: MenuOptions): Menu {
  const mac = process.platform === "darwin";
  const command = (name: Events["app:command"]["command"]) => () => emit("app:command", { command: name });
  const settingsItem: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: command("openSettings") };

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "Laya Notes",
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: command("newNote") },
        { label: "New Folder", accelerator: "CmdOrCtrl+Shift+N", click: command("newFolder") },
        { type: "separator" },
        { label: "Show Notes Folder", click: command("revealLibrary") },
        ...(mac ? [] : [{ type: "separator" } as const, settingsItem, { type: "separator" } as const, { role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Notes", accelerator: "CmdOrCtrl+1", click: command("openNotes") },
        { label: "Tags", accelerator: "CmdOrCtrl+2", click: command("openTags") },
        { type: "separator" },
        ...(isPackaged ? [] : [{ role: "reload" } as const, { role: "toggleDevTools" } as const, { type: "separator" } as const]),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
