import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app, type WebContents } from "electron";
import * as agentBridge from "./agentBridge";
import type { AtelierConnectionConfig } from "./atelier";

const activeRuns = new Map<string, { child: ChildProcess; bridgeToken: string }>();

// Resolves the real compiled binary directly (node_modules/opencode-ai/bin/opencode.exe) instead
// of pnpm's node_modules/.bin/opencode.CMD shim. That shim only runs via `shell: true` on Windows,
// which spawns cmd.exe as the actual child — child.kill() then only kills cmd.exe, leaving the
// real opencode process (and the "Parar" button) doing nothing. Going straight to the binary means
// this is the real process, so a normal kill actually works, and it starts faster too.
function opencodeBin(): string {
  return path.join(
    process.env.APP_ROOT!,
    "node_modules",
    "opencode-ai",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
}

function mcpServerScript(): string {
  return path.join(process.env.APP_ROOT!, "electron", "mcp", "irisMcpServer.ts");
}

function specsMcpServerScript(): string {
  return path.join(process.env.APP_ROOT!, "electron", "mcp", "specsMcpServer.ts");
}

/** One directory per connection+namespace holding just config, never any class/routine content —
 * opencode still needs a real directory to run in, but everything it reads or writes goes through
 * the MCP tools (see irisMcpServer.ts / agentBridge.ts), never this folder. */
function projectDir(connectionId: string, namespace: string): string {
  return path.join(app.getPath("userData"), "agent-projects", connectionId, namespace);
}

async function ensureProjectDir(
  connectionId: string,
  namespace: string,
  host: string,
  port: number,
  bridgePort: number,
  bridgeToken: string,
): Promise<string> {
  const dir = projectDir(connectionId, namespace);
  await fs.mkdir(dir, { recursive: true });

  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      iris: {
        type: "local",
        command: ["node", "--experimental-strip-types", mcpServerScript()],
        environment: {
          IRIS_BRIDGE_PORT: String(bridgePort),
          IRIS_BRIDGE_TOKEN: bridgeToken,
        },
      },
      specs: {
        type: "local",
        command: ["node", "--experimental-strip-types", specsMcpServerScript()],
        environment: {
          IRIS_BRIDGE_PORT: String(bridgePort),
          IRIS_BRIDGE_TOKEN: bridgeToken,
        },
      },
    },
    // Denies opencode's own filesystem/shell tools rather than "ask" — there's nothing legitimate
    // for it to read/write/run in this directory anyway (it's just config), so the only real tools
    // it has are the iris_*/specs_* ones, which route through the bridge's own approval gate instead
    // of opencode's permission system.
    permission: { write: "deny", edit: "deny", bash: "deny" },
  };
  await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));

  const agentsInstructions = `# Servidor IRIS conectado + Specs locais

Este projeto usa DUAS fontes de informação completamente separadas — nunca confunda uma com a outra:

## 1. Código-fonte no servidor IRIS (ferramentas \`iris_*\`)

Este projeto não tem os fontes localmente. O namespace **${namespace}** no servidor **${host}:${port}**
é acessado inteiramente através das ferramentas MCP do servidor "iris":

- \`iris_list_documents\` — lista classes e rotinas do namespace.
- \`iris_read_document\` — lê o conteúdo atual de um documento (ex: "Pacote.Classe.cls").
- \`iris_search\` — busca um texto no código-fonte de todo o namespace.
- \`iris_propose_write\` — propõe salvar o conteúdo completo de um documento. Fica pendente até um
  humano aprovar ou rejeitar. Confira \`approved\` (decisão do usuário) e \`saved\` (se realmente
  foi gravado) no resultado: \`approved: false\` é uma rejeição (não insista sem perguntar);
  \`approved: true, saved: false\` significa que o usuário disse sim mas a gravação falhou (ex:
  timeout) — pode valer a pena tentar de novo.

Sempre leia um documento com \`iris_read_document\` antes de propor uma escrita nele.

## 2. Specs do projeto (ferramentas \`specs_*\`)

"Specs" são arquivos .md locais (planos, notas, especificações escritas pelo usuário sobre o que
construir) — NÃO são classes/rotinas do IRIS, NÃO existem no namespace do servidor, e NÃO devem ser
buscadas com \`iris_search\`, \`iris_list_documents\` ou \`iris_read_document\`. Elas ficam em outro
lugar (uma pasta local, fora deste projeto) e só são acessíveis por:

- \`specs_list\` — lista os nomes dos arquivos .md de spec disponíveis.
- \`specs_read\` — lê o conteúdo de um deles pelo nome (ex: "plano.md").
- \`specs_write\` — cria ou sobrescreve um arquivo .md de spec com o conteúdo completo informado
  (não um diff parcial). Cria o arquivo se ainda não existir. Diferente de \`iris_propose_write\`,
  isto NÃO espera aprovação humana — grava direto. Leia o arquivo com \`specs_read\` primeiro sempre
  que for uma edição (não uma criação do zero), para não apagar conteúdo por engano.

Sempre que o usuário mencionar "specs", "especificação", "plano" ou pedir para seguir/atualizar um
documento de planejamento do projeto, use \`specs_list\`/\`specs_read\`/\`specs_write\` — nunca as
ferramentas \`iris_*\`. Antes de atuar em uma tarefa, também vale a pena checar \`specs_list\` e ler
(\`specs_read\`) as specs cujo nome pareça relevante para o que foi pedido — não leia todas
indiscriminadamente, só as que puderem conter contexto útil. Se nenhuma parecer relevante, siga sem
ler nenhuma. Se o usuário pedir para registrar uma decisão, atualizar o plano ou documentar algo do
que foi feito, use \`specs_write\` para isso em vez de só responder no chat.

Não use ferramentas de arquivo local (read/write/edit/bash) para nada disso — este diretório de
projeto é só configuração, tanto o código quanto as specs são acessados exclusivamente pelas
ferramentas MCP acima.

## 3. Narre o progresso passo a passo

Para qualquer tarefa com mais de um passo óbvio (e principalmente para pedidos grandes/complexos),
escreva uma frase curta ANTES de cada ação relevante dizendo o que você vai fazer e por quê — ex:
"1. Vou ler Pacote.Classe.cls para entender a estrutura atual.", "2. Vou propor a alteração X.". Não
espere até o fim para explicar tudo de uma vez. Isso é importante especialmente em tarefas longas: o
usuário está vendo essas mensagens aparecerem em tempo real, e silêncio prolongado parece uma
travada mesmo quando você só está processando um pedido grande — prefira narrar demais a narrar de
menos.
`;
  await fs.writeFile(path.join(dir, "AGENTS.md"), agentsInstructions);

  return dir;
}

/**
 * Runs opencode headless (`opencode run --format json`) against a config-only project dir,
 * streaming each line of its stdout back to the renderer as it's produced. Reads/writes happen
 * live against the IRIS server through the MCP bridge (agentBridge.ts) — see that file for how a
 * write actually gets gated on human approval.
 */
export async function runAgent(
  connectionId: string,
  namespace: string,
  config: AtelierConnectionConfig,
  prompt: string,
  specsDir: string,
  sender: WebContents,
  model?: string,
  sessionId?: string,
): Promise<string> {
  // Each running agent is its own independent burst of IRIS calls (list/read/search/write, several
  // per turn) — one AgentPanel tab per namespace means nothing previously stopped starting a second
  // conversation (same or different namespace, same or different server) while one was still going,
  // compounding exactly the session/connection pressure that causes 503s on a license-constrained
  // server. Capping this to one at a time app-wide is a deliberate tradeoff (a second tab has to
  // wait), not an oversight.
  if (activeRuns.size > 0) {
    throw new Error(
      "Só um agente pode rodar por vez neste app (para economizar sessões/licença do IRIS). " +
        "Aguarde a execução atual terminar, ou clique em Parar nela, antes de iniciar uma nova.",
    );
  }
  const runId = crypto.randomUUID();
  const { port: bridgePort, token: bridgeToken } = await agentBridge.registerSession(
    connectionId,
    namespace,
    config,
    sender,
    runId,
    specsDir,
  );
  const dir = await ensureProjectDir(
    connectionId,
    namespace,
    config.host,
    config.port,
    bridgePort,
    bridgeToken,
  );

  const args = [
    "run",
    "--dir",
    dir,
    "--format",
    "json",
    // Streams the model's reasoning as it's produced, not just the final reply — without it, a big
    // prompt can leave the UI showing nothing at all for a long stretch while the model is still
    // silently working, which looks exactly like a hang. This gives the transcript (and the "what's
    // it doing" loader) real incremental content to show instead.
    "--thinking",
    ...(model ? ["--model", model] : []),
    // Without this, every run starts a brand-new opencode session even for the same project dir —
    // the whole conversation resets after a single exchange. Passing back the session id opencode
    // handed us on a previous run in this same chat (see the sessionID-sniffing below) continues it
    // instead, so follow-up prompts actually have the prior turns as context.
    ...(sessionId ? ["--session", sessionId] : []),
    prompt,
  ];
  // stdin must be "ignore", not the spawn default of an open pipe — opencode blocks trying to read
  // from stdin if it's left open with nothing writing to it and no EOF, hanging forever before
  // producing a single byte of output. Confirmed by reproducing outside Electron: identical command
  // run from a shell (inherited/closed stdin) completes in ~1s; spawned via child_process with
  // default stdio (open, unconsumed pipe) hangs indefinitely every time.
  const child = spawn(opencodeBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
  activeRuns.set(runId, { child, bridgeToken });

  // Every stdout line carries the session id (`{ type, timestamp, sessionID, part }` — see
  // agentTranscript.ts), including the one opencode assigned itself when `sessionId` above was
  // omitted. Sniffed here (not left to the renderer) so the caller can persist it before the run
  // even finishes, letting the *next* prompt continue this same session.
  let sessionIdSent = false;
  const forwardLines = (stream: NodeJS.ReadableStream, stderr: boolean) => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        sender.send("agent:event", { runId, line, stderr });
        if (!sessionIdSent && !stderr) {
          try {
            const parsed = JSON.parse(line) as { sessionID?: unknown };
            if (typeof parsed.sessionID === "string" && parsed.sessionID) {
              sessionIdSent = true;
              sender.send("agent:session", { runId, sessionId: parsed.sessionID });
            }
          } catch {
            // Not JSON (or no sessionID yet) — keep waiting for a line that has one.
          }
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) sender.send("agent:event", { runId, line: buffer, stderr });
    });
  };
  forwardLines(child.stdout, false);
  forwardLines(child.stderr, true);

  child.on("close", (code) => {
    activeRuns.delete(runId);
    agentBridge.endSession(bridgeToken);
    sender.send("agent:done", { runId, code: code ?? 1 });
  });
  child.on("error", (error) => {
    activeRuns.delete(runId);
    agentBridge.endSession(bridgeToken);
    sender.send("agent:event", {
      runId,
      line: `Erro ao iniciar o opencode: ${error.message}`,
      stderr: true,
    });
    sender.send("agent:done", { runId, code: 1 });
  });

  return runId;
}

export function abortAgentRun(runId: string): void {
  const entry = activeRuns.get(runId);
  if (!entry || entry.child.pid === undefined) return;
  if (process.platform === "win32") {
    // Kills the whole process tree, not just `child` — opencode itself spawns subprocesses for
    // tool calls (bash, etc.), and plain kill() wouldn't touch those.
    execFile("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], () => {});
  } else {
    entry.child.kill("SIGTERM");
  }
}

// Called on app shutdown (see main.ts's "before-quit" handler) — without this, quitting with a run
// active skips the child's own "close"/"error" handlers entirely (the whole process tree is torn
// down first), so activeRuns/agentBridge sessions never get cleaned up and the opencode child can
// outlive the app as an orphaned process still capable of hitting IRIS through nothing (the bridge
// dies with the app) but still worth not leaving behind.
export function abortAllAgentRuns(): void {
  for (const runId of activeRuns.keys()) abortAgentRun(runId);
}
