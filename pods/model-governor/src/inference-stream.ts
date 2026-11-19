// The provider reader belongs to the request lifetime. A client may stop reading as soon as it sees finish_reason.
import type { RequiredText } from "./required-text.js";
import type { LlmUsageStatus } from "./governor.js";

export interface StreamLifetime {
  signal: AbortSignal;
  waitUntil?: (task: Promise<void>) => void;
}

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  model?: string;
}

interface Options {
  requiredText?: RequiredText;
  validateModel?: (reported: unknown) => void;
  choices: number;
  lifetime?: StreamLifetime;
  record: (usage: Usage, status: LlmUsageStatus) => Promise<string>;
}

const MAX_EVENT_BYTES = 1024 * 1024;
const QUEUE_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 128 * 1024;
const TAIL_MS = 3000;
const STALLED_CLIENT_MS = 15_000;
const wire = new TextEncoder();
function sse(data: unknown) { return wire.encode("data: " + JSON.stringify(data) + "\n\n"); }


function eventReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let eof = false;
  return {
    cancel() { void reader.cancel().catch(() => {}); },
    async read() {
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary || eof) {
          if (!buffer) return null;
          const length = boundary ? boundary.index + boundary[0].length : buffer.length;
          const event = buffer.slice(0, length);
          buffer = buffer.slice(length);
          const bytes = encoder.encode(event);
          if (bytes.length > MAX_EVENT_BYTES) throw new Error("provider sent an oversized SSE event");
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          return { bytes, done: data === "[DONE]", chunk: data && data !== "[DONE]" ? JSON.parse(data) : null };
        }
        if (buffer.length > MAX_EVENT_BYTES) throw new Error("provider sent an oversized SSE event");
        const next = await reader.read();
        eof = next.done;
        buffer += decoder.decode(next.value, { stream: !eof });
      }
    },
  };
}

export async function openMeteredStream(upstream: ReadableStream<Uint8Array>, options: Options): Promise<ReadableStream<Uint8Array>> {
  const source = eventReader(upstream);
  const signal = options.lifetime?.signal;
  let first: Awaited<ReturnType<typeof source.read>> = null;
  if (options.validateModel) {
    // A mismatched first event must still be able to produce an HTTP error.
    const abort = () => source.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("client disconnected");
      do {
        first = await source.read();
        if (!first || first.done) throw new Error("provider ended stream without a model identity");
      } while (!first.chunk);
      options.validateModel(first.chunk.model);
    } catch (err) {
      source.cancel();
      throw err;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  let detached = false;
  let bodyCancelled = false;
  let tail = false;
  let tailExpired = false;
  let wake: (() => void) | undefined;
  const disconnect = () => {
    detached = true;
    wake?.();
    if (!tail) source.cancel();
  };

  const usage: Usage = {};
  let receipt: Promise<string> | undefined;
  const persist = (status: LlmUsageStatus) => receipt ??= options.record({ ...usage }, status);

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>) {
    const finished = new Set<number>();
    const held: Uint8Array[] = [];
    let tailBytes = 0;
    let tailTimer: ReturnType<typeof setTimeout> | undefined;
    let providerError = false;
    let stalled = false;
    let finalUsage = false;
    let doneSeen = false;
    const required = options.requiredText;
    const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const outcome = () => providerError ? "error" : finalUsage ? "success" : "usage_unavailable";

    const startTail = () => {
      if (tail) return;
      tail = true;
      tailTimer = setTimeout(() => { tailExpired = true; source.cancel(); wake?.(); }, TAIL_MS);
    };
    const send = async (bytes: Uint8Array) => {
      if (detached) return;
      if ((controller.desiredSize ?? 0) <= 0) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            stalled = true;
            reject(new Error("client stopped consuming the stream"));
          }, STALLED_CLIENT_MS);
          wake = () => { clearTimeout(timeout); resolve(); };
        });
        wake = undefined;
      }
      if (!detached) controller.enqueue(bytes);
    };
    const flush = async () => {
      for (const bytes of held) await send(bytes);
      held.length = 0;
    };

    signal?.addEventListener("abort", disconnect, { once: true });
    if (signal?.aborted) disconnect();
    try {
      let event = first ?? await source.read();
      while (event && !tailExpired && !(detached && !tail)) {
        const { chunk, done } = event;
        let bytes = event.bytes;
        if (chunk) {
          if (chunk.model !== undefined) {
            options.validateModel?.(chunk.model);
            if (typeof chunk.model === "string") usage.model = chunk.model;
          }
          if (chunk.error) providerError = true;
          const u = chunk.usage;
          if (validCount(u?.prompt_tokens)) usage.promptTokens = u.prompt_tokens;
          if (validCount(u?.completion_tokens)) usage.completionTokens = u.completion_tokens;
          if (typeof u?.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0) usage.cost = u.cost;
          for (const choice of chunk.choices ?? []) {
            if (choice?.finish_reason != null) finished.add(choice.index ?? 0);
          }
          const terminalUsage = finished.size >= options.choices || chunk.choices?.length === 0;
          if (required) {
            required.observe(chunk, true, terminalUsage);
            bytes = sse(required.publicChunk(chunk));
          }
          if (u && terminalUsage) {
            finalUsage = validCount(u.prompt_tokens) && validCount(u.completion_tokens);
          }
          if (finished.size >= options.choices || (u && chunk.choices?.length === 0) || providerError) startTail();
        }
        if (done) { doneSeen = true; startTail(); }
        if (required && !chunk && !done) bytes = wire.encode(": keepalive\n\n");
        if (tail) {
          tailBytes += Math.max(bytes.length, event.bytes.length);
          if (tailBytes > MAX_TAIL_BYTES) throw new Error("provider exceeded the usage trailer limit");
        }
        if (tail && !receipt) {
          held.push(bytes);
          // include_usage's final frame has an empty choices array. Intermediate totals may still increase.
          // For potentially empty text, do not expose a finish frame or record success
          // until the stream terminates. A later provider error must retain its own outcome.
          const pendingText = required && !required.hasOutput && !providerError;
          if (!pendingText && (done || (finalUsage && chunk?.usage && chunk.choices?.length === 0))) {
            await persist(outcome());
            await flush();
          }
        } else {
          await send(bytes);
        }
        if (done) break;
        event = await source.read();
      }
      // EOF before any finish marker can carry provisional counts but cannot prove a completed reply.
      if (required?.emptyCompletion && doneSeen && !detached && !providerError && !tailExpired) {
        held.length = 0;
        const usageEventId = await persist("empty_output");
        // A cancellation during the write may detach the client; send() checks again.
        await send(sse({ error: required.error(usageEventId) }));
        await send(wire.encode("data: [DONE]\n\n"));
      } else {
        const truncated = required?.emptyCompletion && !doneSeen;
        await persist(detached && (!tail || (required && !required.hasOutput)) ? "cancelled" : !tail || truncated ? "error" : outcome());
        await flush();
      }
      if (!bodyCancelled) controller.close();
    } catch (err) {
      try {
        await persist(stalled ? "cancelled" : "error");
      } finally {
        if (!bodyCancelled) controller.error(err);
      }
    } finally {
      source.cancel();
      clearTimeout(tailTimer);
      signal?.removeEventListener("abort", disconnect);
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const task = pump(controller);
      options.lifetime?.waitUntil?.(task);
      // With no Worker context the caller observes write errors on its response reader.
      if (!options.lifetime?.waitUntil) void task.catch(() => {});
    },
    pull() { wake?.(); },
    cancel() { bodyCancelled = true; disconnect(); },
  }, { highWaterMark: QUEUE_BYTES, size: bytes => bytes.byteLength });
}
