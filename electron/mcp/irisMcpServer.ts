/**
 * Standalone MCP server spawned by opencode itself (per the `mcp` section of the opencode.json
 * this app generates — see agentRun.ts), not by our Electron main process. Runs as a plain Node
 * process talking JSON-RPC over stdio to opencode; it has no access to Electron internals, so every
 * tool here proxies to the loopback HTTP bridge in electron/agentBridge.ts instead of touching the
 * Atelier API or the filesystem directly. That bridge is what actually holds the IRIS credentials
 * and the pending-approval queue.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const port = process.env.IRIS_BRIDGE_PORT;
const token = process.env.IRIS_BRIDGE_TOKEN;
if (!port || !token) {
  console.error("IRIS_BRIDGE_PORT / IRIS_BRIDGE_TOKEN não configurados no ambiente.");
  process.exit(1);
}
const baseUrl = `http://127.0.0.1:${port}`;

async function bridgeFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, "X-Agent-Token": token! },
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? text;
    throw new Error(message);
  }
  return data;
}

const server = new McpServer({ name: "iris", version: "1.0.0" });

server.registerTool(
  "list_documents",
  {
    description: "Lista as classes e rotinas ObjectScript existentes no namespace conectado.",
    inputSchema: z.object({}),
  },
  async () => {
    const docs = await bridgeFetch("/documents");
    return { content: [{ type: "text" as const, text: JSON.stringify(docs) }] };
  },
);

server.registerTool(
  "read_document",
  {
    description:
      "Lê o conteúdo atual de uma classe ou rotina no servidor (ex: 'Pacote.Classe.cls'). Sempre " +
      "use isto antes de propor uma escrita, para editar em cima do conteúdo real e atual.",
    inputSchema: z.object({
      name: z.string().describe("Nome do documento, ex: Pacote.Classe.cls"),
    }),
  },
  async ({ name }) => {
    const doc = (await bridgeFetch(`/documents/${encodeURIComponent(name)}`)) as {
      content: string;
    };
    return { content: [{ type: "text" as const, text: doc.content }] };
  },
);

server.registerTool(
  "search",
  {
    description: "Busca um texto no código-fonte de todas as classes/rotinas do namespace.",
    inputSchema: z.object({ query: z.string() }),
  },
  async ({ query }) => {
    const results = await bridgeFetch(`/search?q=${encodeURIComponent(query)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
  },
);

server.registerTool(
  "propose_write",
  {
    description:
      "Propõe salvar o CONTEÚDO COMPLETO de uma classe/rotina no servidor (não um diff parcial). " +
      "Isso NÃO salva imediatamente: fica pendente até um humano aprovar ou rejeitar na interface. " +
      "Confira os campos 'approved' (decisão do usuário) e 'saved' (se realmente foi gravado) no " +
      "resultado — 'approved: true, saved: false' significa que o usuário aprovou mas a gravação " +
      "falhou (ex: timeout com o servidor), então pode valer a pena tentar de novo; 'approved: " +
      "false' significa que o usuário rejeitou e não deve ser tentado de novo sem perguntar.",
    inputSchema: z.object({
      name: z.string().describe("Nome do documento, ex: Pacote.Classe.cls"),
      content: z.string().describe("Conteúdo completo do arquivo após a alteração"),
    }),
  },
  async ({ name, content }) => {
    const result = (await bridgeFetch(`/documents/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })) as {
      approved: boolean;
      saved: boolean;
      compileOutput?: string[];
      error?: string;
      message?: string;
    };

    if (!result.approved) {
      return {
        content: [
          {
            type: "text" as const,
            text: `approved: false — o usuário rejeitou a escrita em ${name}.`,
          },
        ],
        isError: true,
      };
    }
    if (!result.saved) {
      return {
        content: [
          {
            type: "text" as const,
            text: `approved: true, saved: false — o usuário aprovou, mas gravar ${name} no servidor falhou: ${result.error ?? "erro desconhecido"}`,
          },
        ],
        isError: true,
      };
    }
    const compileText = result.compileOutput?.length
      ? `\nSaída da compilação:\n${result.compileOutput.join("\n")}`
      : result.message
        ? `\n${result.message}`
        : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `approved: true, saved: true — ${name} salvo e compilado.${compileText}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
