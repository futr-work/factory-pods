import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAgUiEvent,
  parseAgUiEvent,
  createAgUiStream,
  type AgUiEvent,
} from "../src/ag-ui.js";

test("AG-UI Protocol Suite - Event Formatting & Parsing", () => {
  const runStarted: AgUiEvent = {
    type: "run_started",
    runId: "run-abc-123",
    agentId: "pod:model-governor",
    inputs: { model: "gpt-4o" },
    timestamp: 1730000000000,
  };

  const formatted = formatAgUiEvent(runStarted);
  assert.match(formatted, /^event: run_started\n/);
  assert.match(formatted, /"runId":"run-abc-123"/);
  assert.match(formatted, /\n\n$/);

  const parsed = parseAgUiEvent(formatted);
  assert.ok(parsed);
  assert.equal(parsed.type, "run_started");
  assert.equal((parsed as any).runId, "run-abc-123");
  assert.equal((parsed as any).agentId, "pod:model-governor");
});

test("AG-UI Protocol Suite - Human-In-The-Loop Interrupt Event", () => {
  const interruptEvent: AgUiEvent = {
    type: "interrupt",
    interruptId: "int-99",
    reason: "Destructive database migration requires operator sign-off",
    prompt: "Do you authorize running migration 0002_drop_legacy_tables.sql?",
    options: ["allow_once", "allow_always", "deny"],
    timestamp: 1730000001000,
  };

  const formatted = formatAgUiEvent(interruptEvent);
  const parsed = parseAgUiEvent(formatted);

  assert.ok(parsed);
  assert.equal(parsed.type, "interrupt");
  assert.equal((parsed as any).interruptId, "int-99");
  assert.equal((parsed as any).options.length, 3);
});

test("AG-UI Protocol Suite - Web Stream SSE Emitter", async () => {
  const { emit, close, toResponse } = createAgUiStream();

  const response = toResponse({ "X-Pod-Source": "kernel-test" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("X-Pod-Source"), "kernel-test");

  emit({
    type: "text_message_chunk",
    messageId: "msg-1",
    delta: "Hello from edge pod!",
  });

  close();

  const text = await response.text();
  assert.match(text, /event: text_message_chunk/);
  assert.match(text, /Hello from edge pod!/);
});
