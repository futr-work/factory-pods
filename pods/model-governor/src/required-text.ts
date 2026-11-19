// An opt-in delivery requirement. Only visible text counts for extraction; genuine non-text
// responses such as refusals and tool calls keep their ordinary OpenAI meaning.
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function visibleOrAlternative(message: any): boolean {
  // Even an incomplete function-call fragment, refusal or non-text part makes an OAuth
  // recovery unsafe. An empty tool_calls array alone is not a tool call.
  if (message.refusal != null || message.function_call != null || message.audio != null ||
      (message.images != null && (!Array.isArray(message.images) || message.images.length > 0)) ||
      (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))) return true;
  const content = message.content;
  if (content == null) return false;
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return true;
  return content.some(part => part?.type !== "text" || typeof part.text !== "string" || text(part.text));
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function usageDetails(raw: any) {
  const u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens: number }; cost?: number } = {};
  if (count(raw?.prompt_tokens)) u.prompt_tokens = raw.prompt_tokens;
  if (count(raw?.completion_tokens)) u.completion_tokens = raw.completion_tokens;
  if (count(raw?.total_tokens) && (u.prompt_tokens === undefined || u.completion_tokens === undefined ||
      raw.total_tokens === u.prompt_tokens + u.completion_tokens)) u.total_tokens = raw.total_tokens;
  const reasoning = raw?.completion_tokens_details?.reasoning_tokens;
  if (count(reasoning) && (u.completion_tokens === undefined || reasoning <= u.completion_tokens))
    u.completion_tokens_details = { reasoning_tokens: reasoning };
  if (typeof raw?.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0) u.cost = raw.cost;
  return u;
}

// Unknown delta extensions may contain a visible alternative or refusal. Leave the
// response alone, but do not attest a recoverable timeout in that case.
const timeoutDeltaFields = new Set(["role", "content", "refusal", "tool_calls", "function_call", "audio", "images",
  "reasoning", "reasoning_content", "reasoning_details", "thinking"]);

const metadata = (s: unknown) => typeof s === "string" && s.length <= 512 && !/[\x00-\x1f\x7f]/.test(s) ? s : null;

export class RequiredText {
  hasOutput = false;
  completionId: string | null = null;
  servedModel: string | null = null;
  finishReason: string | null = null;
  usage = usageDetails(null);
  private partialUsage = usageDetails(null);
  private uncertainTimeout = false;
  get unresolved() { return !this.hasOutput && !this.ambiguous && !this.uncertainTimeout && this.finished.size === 0; }

  timeoutMetadata(milliseconds: number) {
    return { requested_model: this.requestedModel, model: this.model, served_model: this.servedModel,
      completion_id: this.completionId, timeout_ms: milliseconds,
      usage_state: Object.keys(this.partialUsage).length ? "partial" as const : "unknown" as const,
      usage: { ...this.partialUsage } };
  }

  private readonly assistant = new Set<number>();
  private readonly finished = new Set<number>();
  private ambiguous = false;
  constructor(readonly requestedModel: string, readonly model: string, private readonly choices: number) {}

  get emptyCompletion() {
    return !this.hasOutput && !this.ambiguous && this.completionId !== null && this.servedModel !== null && this.choices > 0 && this.finished.size === this.choices &&
      [...this.finished].every(index => this.assistant.has(index));
  }

  observe(data: any, stream = false, finalUsage = true) {
    const id = metadata(data.id), reportedModel = metadata(data.model);
    if ((data.id != null && !id) || (data.model != null && !reportedModel) ||
        (id && this.completionId && id !== this.completionId) ||
        (reportedModel && this.servedModel && reportedModel !== this.servedModel)) this.ambiguous = true;
    this.completionId ??= id;
    this.servedModel ??= reportedModel;
    if (data.usage != null) {
      const raw = data.usage, observed = usageDetails(raw);
      // Missing telemetry is explicitly unknown; malformed provider telemetry must
      // never become positive evidence of an unmetered, free attempt.
      if (typeof raw !== "object" || Array.isArray(raw) ||
          ["prompt_tokens", "completion_tokens", "total_tokens", "cost"].some(k =>
            Object.hasOwn(raw, k) && !(k in observed)) ||
          (raw.completion_tokens_details != null && (typeof raw.completion_tokens_details !== "object" ||
            Array.isArray(raw.completion_tokens_details) || (Object.hasOwn(raw.completion_tokens_details, "reasoning_tokens") &&
              !observed.completion_tokens_details))) || (observed.cost ?? 0) > 0) this.uncertainTimeout = true;
      const merged = { ...this.partialUsage, ...observed };
      const { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } = merged;
      if (total !== undefined && ((prompt !== undefined && total < prompt) ||
          (completion !== undefined && total < completion) ||
          (prompt !== undefined && completion !== undefined && total !== prompt + completion))) {
        if (observed.total_tokens !== undefined) this.uncertainTimeout = true;
        delete merged.total_tokens; // An older cumulative total cannot describe newer component counts.
      }
      if (merged.completion_tokens_details && completion !== undefined &&
          merged.completion_tokens_details.reasoning_tokens > completion) this.uncertainTimeout = true;
      this.partialUsage = merged;
    }
    if (finalUsage && data.usage) this.usage = usageDetails(data.usage);
    if (!Array.isArray(data.choices)) { this.ambiguous = true; return; }
    for (const choice of data.choices) {
      const index = choice?.index ?? (this.choices === 1 ? 0 : -1);
      const m = stream ? choice?.delta : choice?.message;
      if ((stream && choice?.message !== undefined) || (!stream && choice?.delta !== undefined)) this.ambiguous = true;
      if (!Number.isInteger(index) || index < 0 || index >= this.choices || !m || typeof m !== "object" || Array.isArray(m)) {
        this.ambiguous = true; continue;
      }
      if (stream && (choice.error != null || choice.content_filter_results != null ||
          Object.keys(m).some(k => !timeoutDeltaFields.has(k)))) this.uncertainTimeout = true;
      if (m.role === "assistant") this.assistant.add(index);
      else if (m.role != null) this.ambiguous = true;
      if (!stream && m.content === undefined) this.ambiguous = true;
      this.hasOutput ||= visibleOrAlternative(m);
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== "stop" && choice.finish_reason !== "length") this.ambiguous = true;
        else {
          this.finished.add(index);
          this.finishReason ??= choice.finish_reason;
        }
      }
    }
  }

  // Only forward public Chat Completions fields in opted-in streams. Provider reasoning
  // extensions can occur on ordinary deltas as well as on the final event.
  publicChunk(data: any) {
    if (data.error?.code === "empty_output" || data.error?.code === "upstream_timeout" || data.error?.type === "governor_error") {
      return { error: { code: "upstream_error", type: "provider_error", message: "Provider reported a stream error." } };
    }
    if (data.error || this.hasOutput || this.ambiguous) {
      // This response cannot trigger recovery. Keep its original refusal, tool calls,
      // logprobs or provider error intact, without the provider's private reasoning deltas.
      if (!Array.isArray(data.choices)) return data;
      return { ...data, choices: data.choices.map((choice: any) => {
        if (!choice?.delta) return choice;
        const { reasoning, reasoning_content, reasoning_details, thinking, ...delta } = choice.delta;
        return { ...choice, delta };
      }) };
    }
    const choices = (Array.isArray(data.choices) ? data.choices : []).map((choice: any) => {
      const source = choice?.delta ?? {};
      const delta: Record<string, unknown> = {};
      for (const key of ["role", "content", "tool_calls", "function_call", "refusal", "audio", "images"]) {
        if (source[key] !== undefined) delta[key] = source[key];
      }
      if (Array.isArray(delta.content)) delta.content = delta.content
        .filter(part => part?.type === "text" || part?.type === "refusal")
        .map(part => part.type === "text" ? { type: "text", text: part.text } : { type: "refusal", refusal: part.refusal });
      return { index: choice?.index, finish_reason: choice?.finish_reason, delta };
    });
    return { id: this.completionId, model: this.servedModel, object: "chat.completion.chunk",
      created: data.created, choices, ...(data.usage ? { usage: usageDetails(data.usage) } : {}) };
  }

  error(usageEventId: string) {
    return { status: 502, code: "empty_output", usage_event_id: usageEventId, type: "governor_error",
      message: "Provider completed without visible text.", requested_model: this.requestedModel,
      model: this.model, served_model: this.servedModel, completion_id: this.completionId,
      finish_reason: this.finishReason, usage: this.usage };
  }
}

export function requireTextFor(body: Record<string, unknown>): boolean {
  const noTools = (v: unknown) => v == null || (Array.isArray(v) && !v.length);
  if (!noTools(body.tools) || !noTools(body.functions) || body.audio ||
      (body.modalities != null && !(Array.isArray(body.modalities) && body.modalities.every(m => m === "text")))) return false;
  return Array.isArray(body.messages) && body.messages.every(m => m && m.role !== "tool" && m.role !== "function" &&
    !m.function_call && noTools(m.tool_calls) && (typeof m.content === "string" ||
      (Array.isArray(m.content) && m.content.every((p: any) => p?.type === "text" && typeof p.text === "string"))));
}


export type TimeoutMetadata = ReturnType<RequiredText["timeoutMetadata"]>;

export function timeoutError(metadata: TimeoutMetadata, usageEventId: string) {
  return { ...metadata, status: 504, code: "upstream_timeout", type: "governor_error", usage_event_id: usageEventId,
    finish_reason: null, message: "The governor upstream deadline expired before visible output." };
}
