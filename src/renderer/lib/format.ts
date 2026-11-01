export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Time left in words, rounded the way a person would say it. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "about a minute left" : `about ${minutes} minutes left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h ${rest} min left`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
