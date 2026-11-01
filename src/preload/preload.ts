import { contextBridge, ipcRenderer } from "electron";
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "@shared/channels.ts";

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on(EVENT_CHANNEL, (_event, name: string, payload: unknown) => {
  for (const listener of listeners.get(name) ?? []) listener(payload);
});

/** The window's only way to reach the main process. The main process validates every request. */
contextBridge.exposeInMainWorld("laya", {
  invoke: (channel: string, input?: unknown) => ipcRenderer.invoke(INVOKE_CHANNEL, channel, input),
  on: (event: string, listener: Listener) => {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(event, set);
    return () => {
      set.delete(listener);
    };
  },
  platform: process.platform,
});
