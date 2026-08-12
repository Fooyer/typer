/**
 * Proof of concept for the opencode integration: downloads one document from an IRIS server via
 * the Atelier API, lets opencode edit a local copy of it in a scratch temp dir, then prints the
 * diff. Nothing is written back to the server — this only proves the download -> agent -> diff
 * leg of the pipeline before any UI or "apply" step gets built.
 *
 * Usage:
 *   TYPER_IRIS_HOST=localhost TYPER_IRIS_PORT=52773 TYPER_IRIS_USER=_SYSTEM \
 *   TYPER_IRIS_PASSWORD=*** TYPER_IRIS_NAMESPACE=USER \
 *   node scripts/agent-poc.ts "MyPackage.MyClass.cls" "Add a doc comment to the Foo method"
 *
 * Optional env vars: TYPER_IRIS_HTTPS ("true"/"false", default "false"),
 * TYPER_IRIS_PATH_PREFIX, AGENT_MODEL ("provider/model", e.g. "anthropic/claude-sonnet-4-5").
 *
 * Requires `opencode auth login` (or a provider API key env var opencode recognizes) to already
 * be set up — this script does not handle authentication.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Diff from "diff";
import { getDocument, type AtelierConnectionConfig } from "../electron/atelier.ts";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Faltando variável de ambiente obrigatória: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const [docName, prompt] = process.argv.slice(2);
  if (!docName || !prompt) {
    console.error(
      'Uso: node scripts/agent-poc.ts "<NomeDoDocumento.cls>" "<prompt para o agente>"',
    );
    process.exit(1);
  }

  const config: AtelierConnectionConfig = {
    host: requireEnv("TYPER_IRIS_HOST"),
    port: Number(requireEnv("TYPER_IRIS_PORT")),
    https: process.env.TYPER_IRIS_HTTPS === "true",
    pathPrefix: process.env.TYPER_IRIS_PATH_PREFIX,
    username: requireEnv("TYPER_IRIS_USER"),
    password: requireEnv("TYPER_IRIS_PASSWORD"),
  };
  const namespace = requireEnv("TYPER_IRIS_NAMESPACE");
  const model = process.env.AGENT_MODEL;

  console.log(`Baixando ${docName} de ${namespace}@${config.host}:${config.port}...`);
  const original = await getDocument(config, namespace, docName);
  const originalContent = original.content.join("\n");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "typer-agent-poc-"));
  const localFile = path.join(tempDir, docName);
  await fs.writeFile(localFile, originalContent, "utf-8");
  console.log(`Cópia local em: ${localFile}`);

  console.log(`\nRodando opencode (--dir ${tempDir})...\n`);
  const opencodeBin = path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "opencode.CMD" : "opencode",
  );
  const args = ["run", "--dir", tempDir, ...(model ? ["--model", model] : []), prompt];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(opencodeBin, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    console.error(`\nopencode saiu com código ${exitCode}.`);
    process.exit(exitCode);
  }

  const newContent = await fs.readFile(localFile, "utf-8");
  console.log("\n--- resultado ---");
  if (newContent === originalContent) {
    console.log("Nenhuma alteração proposta.");
  } else {
    const patch = Diff.createTwoFilesPatch(
      docName,
      docName,
      originalContent,
      newContent,
      "servidor (atual)",
      "opencode (proposto)",
    );
    console.log(patch);
    console.log(
      "Nada foi salvo no servidor — isso é só a prova de conceito do download -> agente -> diff.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
