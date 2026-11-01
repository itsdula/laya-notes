import { Laya } from "@receptron/laya";
import type { Tag } from "@shared/types.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

/**
 * Runs in an Electron utility process. It owns the ONNX session, so a crash or an out-of-memory error
 * here ends this process only; the window and the notes keep working.
 */
const port = process.parentPort;
let model: Laya | null = null;
let queue: Promise<void> = Promise.resolve();

function send(message: FromWorker): void {
  port.postMessage(message);
}

port.on("message", (event: { data: ToWorker }) => {
  const message = event.data;
  queue = queue.then(() => handle(message)).catch(() => undefined);
});

async function handle(message: ToWorker): Promise<void> {
  if (message.type === "load") {
    if (model) return send({ type: "loaded" });
    try {
      model = await Laya.load({ modelDir: message.modelDir, executionProviders: ["cpu"] });
      send({ type: "loaded" });
    } catch (error) {
      send({ type: "loadFailed", message: error instanceof Error ? error.message : "Laya could not load." });
    }
    return;
  }
  if (message.type === "unload") {
    await model?.close().catch(() => undefined);
    model = null;
    return;
  }
  if (!model) return send({ type: "scoreFailed", requestId: message.requestId, message: "Laya is not loaded." });
  try {
    send({ type: "scored", requestId: message.requestId, probabilities: await score(model, message.note, message.tags) });
  } catch (error) {
    send({ type: "scoreFailed", requestId: message.requestId, message: error instanceof Error ? error.message : "Laya could not tag this note." });
  }
}

/** Every tag is a yes-or-no question, answered together in one forward pass. */
async function score(laya: Laya, note: { title: string; text: string }, tags: Tag[]): Promise<Record<string, number>> {
  const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
  for (const tag of tags) {
    questions[tag.name] = {
      type: "noul",
      instructions: tag.instructions,
      criteria: { true: tag.instructions, false: "This does not apply to the note." },
    };
  }
  const result = await laya.systemOne({ title: note.title, note: note.text }, questions);
  const probabilities: Record<string, number> = {};
  for (const tag of tags) {
    const answer = result.answers[tag.name];
    probabilities[tag.name] = answer && "noul" in answer ? answer.noul : 0;
  }
  return probabilities;
}
