import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A temporary directory that is removed after the test. */
export async function temporaryDirectory(prefix = "laya-test-"): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  return { path: directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`Expected error code ${code}, got ${actual ?? String(error)}`);
    return;
  }
  throw new Error(`Expected error code ${code}, but the call succeeded`);
}
