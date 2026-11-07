// @futr-work/pod-kernel: AG-UI Protocol Implementation
// Lightweight, zero-dependency Agent-User Interaction Protocol (AG-UI) engine
// Compatible with Cloudflare Workers V8 isolates, Bun, and Node.js 18+

export type AgUiEventType =
  | "run_started"
  | "run_finished"
  | "run_error"
  | "step_started"
  | "step_finished"
  | "text_message_start"
  | "text_message_chunk"
  | "text_message_end"
  | "tool_call_start"
  | "tool_call_args"
  | "tool_call_end"
  | "tool_call_result"
  | "state_snapshot"
  | "state_delta"
  | "interrupt"
  | "resume";

export interface BaseAgUiEvent {
  type: AgUiEventType;
  timestamp?: number;
}

export interface RunStartedEvent extends BaseAgUiEvent {
  type: "run_started";
  runId: string;
  agentId?: string;
  inputs?: Record<string, any>;
}

export interface RunFinishedEvent extends BaseAgUiEvent {
  type: "run_finished";
  runId: string;
  outputs?: Record<string, any>;
}

export interface RunErrorEvent extends BaseAgUiEvent {
  type: "run_error";
  runId: string;
  error: string;
  code?: string | number;
}

export interface StepStartedEvent extends BaseAgUiEvent {
  type: "step_started";
  stepId: string;
  stepName: string;
  runId?: string;
}

export interface StepFinishedEvent extends BaseAgUiEvent {
  type: "step_finished";
  stepId: string;
  status: "completed" | "failed" | "skipped";
  durationMs?: number;
}

export interface TextMessageStartEvent extends BaseAgUiEvent {
  type: "text_message_start";
  messageId: string;
  role: "assistant" | "system" | "user";
}

export interface TextMessageChunkEvent extends BaseAgUiEvent {
  type: "text_message_chunk";
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends BaseAgUiEvent {
  type: "text_message_end";
  messageId: string;
  fullText?: string;
}

export interface ToolCallStartEvent extends BaseAgUiEvent {
  type: "tool_call_start";
  callId: string;
  toolName: string;
}

export interface ToolCallArgsEvent extends BaseAgUiEvent {
  type: "tool_call_args";
  callId: string;
  delta: string;
}

export interface ToolCallEndEvent extends BaseAgUiEvent {
  type: "tool_call_end";
  callId: string;
  toolName: string;
  args?: Record<string, any>;
}

export interface ToolCallResultEvent extends BaseAgUiEvent {
  type: "tool_call_result";
  callId: string;
  result: any;
  isError?: boolean;
}

export interface StateSnapshotEvent extends BaseAgUiEvent {
  type: "state_snapshot";
  state: Record<string, any>;
}

export interface StateDeltaEvent extends BaseAgUiEvent {
  type: "state_delta";
  patch: Array<{ op: "add" | "remove" | "replace"; path: string; value?: any }> | Record<string, any>;
}

export interface InterruptEvent extends BaseAgUiEvent {
  type: "interrupt";
  interruptId: string;
  reason: string;
  prompt?: string;
  options?: string[];
  schema?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ResumeEntryEvent extends BaseAgUiEvent {
  type: "resume";
  interruptId: string;
  decision: "allow_once" | "allow_always" | "deny" | "handled" | string;
  response?: any;
}

export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageChunkEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | InterruptEvent
  | ResumeEntryEvent;

/** Formats an AG-UI event into a standard Server-Sent Event (SSE) block. */
export function formatAgUiEvent(event: AgUiEvent): string {
  const payload = {
    ...event,
    timestamp: event.timestamp ?? Date.now(),
  };
  return `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Parses a standard SSE block back into an AgUiEvent (useful for test suites & clients). */
export function parseAgUiEvent(rawBlock: string): AgUiEvent | null {
  const lines = rawBlock.trim().split("\n");
  let eventType: AgUiEventType | null = null;
  let dataStr = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim() as AgUiEventType;
    } else if (line.startsWith("data:")) {
      dataStr = line.slice(5).trim();
    }
  }

  if (!dataStr) return null;

  try {
    const parsed = JSON.parse(dataStr);
    if (eventType && !parsed.type) {
      parsed.type = eventType;
    }
    return parsed as AgUiEvent;
  } catch {
    return null;
  }
}

/** Creates an edge-native SSE stream backed by Web standard ReadableStream. */
export function createAgUiStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let isClosed = false;

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      isClosed = true;
    },
  });

  const emit = (event: AgUiEvent): void => {
    if (isClosed || !controller) return;
    const sse = formatAgUiEvent(event);
    controller.enqueue(encoder.encode(sse));
  };

  const close = (): void => {
    if (isClosed || !controller) return;
    isClosed = true;
    try {
      controller.close();
    } catch {}
  };

  const toResponse = (extraHeaders: Record<string, string> = {}): Response => {
    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        ...extraHeaders,
      },
    });
  };

  return {
    readable,
    emit,
    close,
    toResponse,
  };
}
