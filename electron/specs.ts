import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * "Specs" (.md planning/notes files) are stored as plain local files instead of IRIS server
 * documents. They're free-form (any name, any folder structure a real class/routine can't have)
 * and don't compile — trying to force them through the Atelier document API (classes, routines,
 * CSP files) doesn't work: there's no generic "just save arbitrary content under this name" route
 * server-side, so a doc like "specs/agente.md" either fails to save or 404s the moment anything
 * (a reload, a compile step) tries to read it back. Local files sidestep all of that.
 */

export interface SpecFileEntry {
  /** File name only (no directory) — the list is intentionally flat, one level, no subfolders. */
  name: string;
  path: string;
  modifiedAt: number;
}

function defaultSpecsDir(connectionId: string, namespace: string): string {
  return path.join(app.getPath("userData"), "specs", connectionId, namespace);
}

/** Starter scaffold written into every brand-new specs folder, following Spec-Driven Development
 * (SDD): a constitution (principles/constraints), a spec (what/why), a plan (how), a task list, and
 * a notes log. Content is intentionally generic placeholder text — the user or the agent itself is
 * expected to fill it in for the actual project. Numbered so the (alphabetically sorted) file list
 * keeps the SDD reading order. */
const SDD_TEMPLATE_FILES: Array<{ name: string; content: string }> = [
  {
    name: "00-constituicao.md",
    content: `# Constituição do Projeto

Princípios e restrições que não mudam de uma tarefa para outra. Preencha isso primeiro — as demais
specs devem respeitar o que está aqui.

## Objetivo do projeto
[Uma ou duas frases sobre o que este projeto/namespace faz e para quem.]

## Princípios
- [Ex: compatibilidade retroativa é obrigatória em APIs públicas]
- [Ex: toda classe nova segue o padrão de nomenclatura Pacote.Subpacote.Nome]

## Restrições técnicas
- [Ex: versão mínima do IRIS, dependências permitidas, padrões de log/erro]

## Fora de escopo
- [O que este projeto deliberadamente não faz]
`,
  },
  {
    name: "01-especificacao.md",
    content: `# Especificação

O que precisa ser construído e por quê — em linguagem de negócio/usuário, sem detalhe de
implementação (isso vai no plano).

## Problema
[Que problema real está sendo resolvido?]

## Requisitos funcionais
- [ ] [O sistema deve...]
- [ ] [O sistema deve...]

## Requisitos não funcionais
- [Ex: performance, segurança, auditoria]

## Critérios de aceite
- [Como saber que está pronto?]

## Fora de escopo
- [O que esta spec explicitamente não cobre]
`,
  },
  {
    name: "02-plano.md",
    content: `# Plano Técnico

Como a especificação será implementada.

## Abordagem
[Visão geral da solução técnica.]

## Classes / rotinas envolvidas
- [Pacote.Classe — responsabilidade]

## Modelo de dados
[Novas propriedades, índices, relacionamentos, se houver.]

## Decisões e alternativas consideradas
- [Decisão] — [por quê, o que foi descartado e por quê]

## Riscos
- [O que pode dar errado e como mitigar]
`,
  },
  {
    name: "03-tarefas.md",
    content: `# Tarefas

Checklist executável derivado do plano. Marque conforme for concluindo.

## Fase 1
- [ ] [Tarefa]
- [ ] [Tarefa]

## Fase 2
- [ ] [Tarefa]

## Validação
- [ ] [Como testar/validar o resultado]
`,
  },
  {
    name: "04-notas.md",
    content: `# Notas e Decisões

Log livre de pesquisa, dúvidas em aberto e decisões tomadas ao longo do caminho — o que não cabe
nos documentos formais acima.

## Perguntas em aberto
- [Pergunta]

## Decisões tomadas
- [Data] — [decisão e motivo]
`,
  },
];

/** Writes the SDD scaffold into `dir`, skipping any file that already exists — safe to call on a
 * folder that already has some (but not all) of the template files. Exported so it can also be
 * triggered on demand (see the Specs panel's "Criar template SDD" context menu item), not just
 * automatically the first time a folder is created. */
export async function seedSddScaffold(dir: string): Promise<void> {
  await Promise.all(
    SDD_TEMPLATE_FILES.map(async ({ name, content }) => {
      try {
        await fs.writeFile(path.join(dir, name), content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }),
  );
}

/** Creates the directory (default or a previously chosen custom one) if it doesn't exist yet and
 * returns its absolute path. The very first time a given folder is created, it's seeded with the
 * SDD template scaffold (see SDD_TEMPLATE_FILES) — `fs.mkdir` with `recursive: true` resolves with
 * the path it had to create only when it actually created something, so this only fires once per
 * folder, never on a folder that already existed (even if the user later deleted every file in it). */
export async function resolveSpecsDir(
  connectionId: string,
  namespace: string,
  customDir: string | null,
): Promise<string> {
  const dir = customDir && customDir.trim() ? customDir : defaultSpecsDir(connectionId, namespace);
  const created = await fs.mkdir(dir, { recursive: true });
  if (created) await seedSddScaffold(dir);
  return dir;
}

export async function listSpecFiles(dir: string): Promise<SpecFileEntry[]> {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        return { name: entry.name, path: filePath, modifiedAt: stat.mtimeMs };
      }),
  );
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

export async function readSpecFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

export async function writeSpecFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
}

function ensureMdExtension(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

/** Rejects anything but a bare file name — no "/", "\", or ".." segments — since the list this
 * backs is deliberately flat (see SpecFileEntry). */
function sanitizeFileName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error(`Nome de arquivo inválido: "${name}".`);
  }
  return trimmed;
}

export async function createSpecFile(dir: string, name: string): Promise<string> {
  const fileName = ensureMdExtension(sanitizeFileName(name));
  const filePath = path.join(dir, fileName);
  try {
    // "wx" fails instead of silently overwriting if the file already exists.
    await fs.writeFile(filePath, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`"${fileName}" já existe.`);
    }
    throw error;
  }
  return filePath;
}

export async function deleteSpecFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

export async function renameSpecFile(filePath: string, newName: string): Promise<string> {
  const fileName = ensureMdExtension(sanitizeFileName(newName));
  const newPath = path.join(path.dirname(filePath), fileName);
  await fs.rename(filePath, newPath);
  return newPath;
}
