/**
 * Standalone MCP server for the "Specs" tab, spawned by opencode itself (see the `mcp` section of
 * the opencode.json generated in agentRun.ts) as a SEPARATE server from the "iris" one
 * (irisMcpServer.ts) — on purpose. Specs (.md planning/notes files) live on local disk and have
 * nothing to do with the IRIS namespace's classes/routines; giving them their own MCP server means
 * their tools show up as `specs_list` / `specs_read`, not `iris_*`, so there's no naming overlap
 * that could make the agent reach for the IRIS document tools when the user says "specs". Like
 * irisMcpServer.ts, this process has no Electron access, so it proxies through the same loopback
 * HTTP bridge in electron/agentBridge.ts.
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

async function bridgeFetch(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "X-Agent-Token": token! },
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

const server = new McpServer({ name: "specs", version: "1.0.0" });

server.registerTool(
  "list",
  {
    description:
      "Lista os arquivos .md da aba 'Specs' deste projeto — planos, notas e especificações que o " +
      "usuário escreveu sobre o que construir. NÃO tem relação com as classes/rotinas do namespace " +
      "IRIS (essas usam as ferramentas 'iris_*'); são arquivos locais completamente separados.",
    inputSchema: z.object({}),
  },
  async () => {
    const names = await bridgeFetch("/specs");
    return { content: [{ type: "text" as const, text: JSON.stringify(names) }] };
  },
);

server.registerTool(
  "read",
  {
    description:
      "Lê o conteúdo de um arquivo .md da aba 'Specs' pelo nome (ex: 'plano.md'). Leia apenas as " +
      "specs cujo nome pareça relevante para a tarefa atual, não todas indiscriminadamente.",
    inputSchema: z.object({
      name: z.string().describe("Nome do arquivo .md, ex: plano.md"),
    }),
  },
  async ({ name }) => {
    const doc = (await bridgeFetch(`/specs/${encodeURIComponent(name)}`)) as { content: string };
    return { content: [{ type: "text" as const, text: doc.content }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
