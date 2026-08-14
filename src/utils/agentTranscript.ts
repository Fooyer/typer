/**
 * Parses one line of `opencode run --format json` stdout into something renderable. Shape learned
 * by actually running opencode and inspecting its output (not documented anywhere): each line is
 * `{ type, timestamp, sessionID, part }`, where `part.type` is what actually distinguishes an
 * assistant text chunk from a tool call — e.g. `{"type":"text","part":{"type":"text","text":"Hi"}}`
 * or `{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{...}}}`. Falls back to
 * showing the raw line for anything that doesn't match, since opencode's own JSON format isn't
 * guaranteed to stay exactly like this across versions.
 */
export type TranscriptItem =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      tool: string;
      title?: string;
      status?: string;
      diff?: string;
      input?: unknown;
      /** Set when `status` indicates the tool call itself failed (e.g. a bad `bash` command, a
       * write rejected server-side) — best-effort text pulled from wherever the failure reason
       * turns up in the state blob, since opencode's exact shape for it isn't documented. */
      errorText?: string;
    }
  | { kind: "error"; text: string }
  | { kind: "raw"; text: string };

interface ToolMetadata {
  diff?: string;
  filediff?: { patch?: string };
  error?: unknown;
}

interface ToolState {
  status?: string;
  input?: unknown;
  title?: string;
  metadata?: ToolMetadata;
  output?: unknown;
  error?: unknown;
}

interface AgentPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
  /** finishReason-style field (Vercel AI SDK convention: "stop" | "tool-calls" | "error" | …) —
   * carried through even though normal step-finish events are dropped, so an "error" reason can
   * still surface instead of silently vanishing along with the rest of that noise. */
  reason?: string;
  error?: unknown;
  message?: string;
}

interface AgentRawEvent {
  type?: string;
  part?: AgentPart;
  error?: unknown;
  message?: string;
}

const ERROR_STATUSES = new Set(["error", "failed", "failure"]);

/** Digs through a handful of common shapes (`"a string"`, `{message: "..."}`, `{error: "..."}`,
 * `{error: {message: "..."}}`) looking for human-readable error text — opencode's exact envelope
 * for a failure isn't documented, so this takes whatever plausible field is there instead of
 * betting on one exact path and silently coming up empty when it's wrong. */
function extractMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      extractMessage(obj.message, depth + 1) ??
      extractMessage(obj.error, depth + 1) ??
      extractMessage(obj.text, depth + 1)
    );
  }
  return undefined;
}

/** Returns `null` for events that are pure noise (step start/finish markers) and shouldn't take up
 * a line in the transcript at all. */
export function parseAgentLine(line: string): TranscriptItem | null {
  let event: AgentRawEvent;
  try {
    event = JSON.parse(line) as AgentRawEvent;
  } catch {
    return { kind: "raw", text: line };
  }

  const part = event.part;
  if (!part || typeof part !== "object") {
    // No `part` at all but the envelope itself says "error" — still worth surfacing rather than
    // falling back to an easy-to-miss raw line.
    if (event.type === "error") {
      return { kind: "error", text: extractMessage(event) ?? "O agente reportou um erro." };
    }
    return { kind: "raw", text: line };
  }

  if (part.type === "text" && typeof part.text === "string") {
    return { kind: "text", text: part.text };
  }

  if (part.type === "tool") {
    const diff = part.state?.metadata?.filediff?.patch ?? part.state?.metadata?.diff;
    const status = part.state?.status;
    const errorText =
      status && ERROR_STATUSES.has(status.toLowerCase())
        ? (extractMessage(part.state?.metadata?.error) ??
          extractMessage(part.state?.error) ??
          extractMessage(part.state?.output) ??
          "A ferramenta falhou.")
        : undefined;
    return {
      kind: "tool",
      tool: part.tool ?? "tool",
      title: part.state?.title,
      status,
      diff,
      input: part.state?.input,
      errorText,
    };
  }

  if (part.type === "error") {
    return { kind: "error", text: extractMessage(part) ?? "O agente reportou um erro." };
  }

  if (part.type === "step-start") return null;
  if (part.type === "step-finish") {
    if (part.reason && ERROR_STATUSES.has(part.reason.toLowerCase())) {
      return {
        kind: "error",
        text: extractMessage(part) ?? "A etapa do agente terminou com erro.",
      };
    }
    return null;
  }

  return { kind: "raw", text: line };
}

const TOOL_ICONS: Record<string, string> = {
  read: "🔍",
  grep: "🔍",
  glob: "🔍",
  list: "🔍",
  edit: "✏️",
  write: "✏️",
  patch: "✏️",
  bash: "💻",
  webfetch: "🌐",
  todowrite: "📋",
  todoread: "📋",
};

export function toolIcon(tool: string): string {
  return TOOL_ICONS[tool.toLowerCase()] ?? "🔧";
}
