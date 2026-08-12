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
  | { kind: "tool"; tool: string; title?: string; status?: string; diff?: string; input?: unknown }
  | { kind: "raw"; text: string };

interface ToolMetadata {
  diff?: string;
  filediff?: { patch?: string };
}

interface ToolState {
  status?: string;
  input?: unknown;
  title?: string;
  metadata?: ToolMetadata;
}

interface AgentPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
  reason?: string;
}

interface AgentRawEvent {
  type?: string;
  part?: AgentPart;
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
  if (!part || typeof part !== "object") return { kind: "raw", text: line };

  if (part.type === "text" && typeof part.text === "string") {
    return { kind: "text", text: part.text };
  }

  if (part.type === "tool") {
    const diff = part.state?.metadata?.filediff?.patch ?? part.state?.metadata?.diff;
    return {
      kind: "tool",
      tool: part.tool ?? "tool",
      title: part.state?.title,
      status: part.state?.status,
      diff,
      input: part.state?.input,
    };
  }

  if (part.type === "step-start" || part.type === "step-finish") return null;

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
