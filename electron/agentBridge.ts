import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import * as Diff from "diff";
import * as atelier from "./atelier";
import type { AtelierConnectionConfig } from "./atelier";
import type { WebContents } from "electron";

/**
 * The MCP server the agent talks to (electron/mcp/irisMcpServer.ts) runs as its own OS process,
 * spawned by opencode — not by us — so it has no direct access to Electron's IPC or the renderer.
 * This is the loopback HTTP bridge that gives it one anyway: reads/search go straight through to
 * the Atelier API, and writes block here until the renderer resolves them, so a proposed edit
 * really does pause the agent until a human approves it, not just "look approved" in the UI.
 */

interface Session {
  token: string;
  connectionId: string;
  namespace: string;
  config: AtelierConnectionConfig;
  sender: WebContents;
  runId: string;
}

/** `approved` is the human's decision; `saved` is whether it actually landed on the server —
 * kept separate so a network/compile failure *after* approval isn't reported to the agent as the
 * user having rejected the change, which it didn't. */
interface WriteResolution {
  approved: boolean;
  saved: boolean;
  compileOutput?: string[];
  error?: string;
  message?: string;
}

interface PendingWrite {
  session: Session;
  name: string;
  content: string;
  settle: (result: WriteResolution) => void;
}

const sessions = new Map<string, Session>();
const pendingWrites = new Map<string, PendingWrite>();

let server: Server | null = null;
let serverPort = 0;

function ensureServer(): Promise<number> {
  if (server) return Promise.resolve(serverPort);
  return new Promise((resolve, reject) => {
    const instance = createServer((req, res) => {
      void handleRequest(req, res);
    });
    instance.on("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address();
      serverPort = typeof address === "object" && address ? address.port : 0;
      server = instance;
      resolve(serverPort);
    });
  });
}

export async function registerSession(
  connectionId: string,
  namespace: string,
  config: AtelierConnectionConfig,
  sender: WebContents,
  runId: string,
): Promise<{ port: number; token: string }> {
  const port = await ensureServer();
  const token = crypto.randomUUID();
  sessions.set(token, { token, connectionId, namespace, config, sender, runId });
  return { port, token };
}

/** Ends the session and rejects any of its writes still waiting on a human decision — otherwise an
 * aborted run would leave the MCP tool call (and the now-dead opencode process behind it) hanging
 * on a promise nobody will ever resolve. */
export function endSession(token: string): void {
  const session = sessions.get(token);
  sessions.delete(token);
  if (!session) return;
  for (const [id, pending] of pendingWrites) {
    if (pending.session.token === token) {
      pendingWrites.delete(id);
      pending.settle({ approved: false, saved: false, error: "Sessão do agente encerrada." });
    }
  }
}

export async function resolvePendingWrite(pendingId: string, approved: boolean): Promise<void> {
  const pending = pendingWrites.get(pendingId);
  if (!pending) return;
  pendingWrites.delete(pendingId);
  if (!approved) {
    pending.settle({ approved: false, saved: false });
    return;
  }
  try {
    const { session, name, content } = pending;
    await atelier.saveDocument(session.config, session.namespace, name, content.split("\n"));
    const compileOutput = await atelier.compileDocuments(session.config, session.namespace, [name]);
    pending.settle({ approved: true, saved: true, compileOutput });
  } catch (error) {
    // The human said yes — a failure here is a save/compile problem, not a rejection, so the
    // agent needs to know its change did NOT land rather than being told the user said no.
    pending.settle({ approved: true, saved: false, error: (error as Error).message });
  }
}

async function handleWrite(
  session: Session,
  name: string,
  content: string,
): Promise<WriteResolution> {
  const currentDoc = await atelier
    .getDocument(session.config, session.namespace, name)
    .catch(() => null);
  const serverContent = currentDoc ? currentDoc.content.join("\n") : "";
  if (serverContent === content) {
    return {
      approved: true,
      saved: true,
      message: "Sem alterações — conteúdo já é igual ao do servidor.",
    };
  }
  const patch = Diff.createTwoFilesPatch(
    name,
    name,
    serverContent,
    content,
    "servidor (atual)",
    "opencode (proposto)",
  );
  const pendingId = crypto.randomUUID();
  return new Promise((settle) => {
    pendingWrites.set(pendingId, { session, name, content, settle });
    session.sender.send("agent:pendingWrite", { pendingId, runId: session.runId, name, patch });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = req.headers["x-agent-token"];
  const session = typeof token === "string" ? sessions.get(token) : undefined;
  if (!session) {
    respondJson(res, 403, { error: "Sessão inválida ou expirada." });
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/documents") {
      const docs = await atelier.listDocuments(session.config, session.namespace, false);
      respondJson(res, 200, docs);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/documents/")) {
      const name = decodeURIComponent(url.pathname.slice("/documents/".length));
      const doc = await atelier.getDocument(session.config, session.namespace, name);
      respondJson(res, 200, { content: doc.content.join("\n") });
      return;
    }
    if (req.method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      try {
        const results = await atelier.searchInFiles(
          session.config,
          session.namespace,
          query,
          "*.cls,*.mac,*.int,*.inc",
          false,
        );
        respondJson(res, 200, results);
      } catch (error) {
        // Older IRIS versions don't expose the v2 search route — let the agent fall back to
        // reading likely candidates instead of treating this as a hard failure.
        respondJson(res, 200, {
          error: (error as Error).message,
          note: "Busca não disponível neste servidor; leia documentos específicos em vez disso.",
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/documents/")) {
      const name = decodeURIComponent(url.pathname.slice("/documents/".length));
      const { content } = JSON.parse(await readBody(req)) as { content: string };
      const result = await handleWrite(session, name, content);
      respondJson(res, 200, result);
      return;
    }
    respondJson(res, 404, { error: "Rota desconhecida." });
  } catch (error) {
    respondJson(res, 500, { error: (error as Error).message });
  }
}
