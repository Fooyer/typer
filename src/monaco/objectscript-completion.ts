import type * as Monaco from "monaco-editor";
import { CLASS_KEYWORDS, COMMANDS, OBJECTSCRIPT_LANGUAGE_ID } from "./objectscript-language";
import { getKnownClasses } from "./classIndex";
import { getClassMembers, type ClassMember } from "./classMembers";
import { collectLocalIdentifiers, parseCurrentClassName, resolveVariableType } from "./objectscriptTypeResolver";
import { DATA_TYPES, SYSTEM_CLASSES } from "./objectscriptDataTypes";

interface IntrinsicFunction {
  name: string;
  snippet: string;
  doc: string;
}

/** A curated starter set of the most commonly used ObjectScript intrinsic ($) functions — not exhaustive. */
const INTRINSIC_FUNCTIONS: IntrinsicFunction[] = [
  { name: "$Get", snippet: "$Get(${1:expr}${2:,default})", doc: "Retorna o valor de uma variável/nó, ou um default se indefinido." },
  { name: "$Piece", snippet: "$Piece(${1:string},${2:delim}${3:,piece})", doc: "Extrai uma peça delimitada de uma string." },
  { name: "$Order", snippet: "$Order(${1:subscript})", doc: "Percorre os subscritos de um array/global em ordem." },
  { name: "$Data", snippet: "$Data(${1:var})", doc: "Verifica se uma variável está definida (e se tem descendentes)." },
  { name: "$Select", snippet: "$Select(${1:cond}:${2:value})", doc: "Avalia condições em sequência, retorna o valor da primeira verdadeira." },
  { name: "$Case", snippet: "$Case(${1:expr},${2:val}:${3:result},:${4:default})", doc: "Compara uma expressão contra vários valores possíveis." },
  { name: "$ListBuild", snippet: "$ListBuild(${1:val1})", doc: "Constrói uma $list a partir de valores." },
  { name: "$ListGet", snippet: "$ListGet(${1:list}${2:,position})", doc: "Extrai um elemento de uma $list pela posição." },
  { name: "$ListLength", snippet: "$ListLength(${1:list})", doc: "Número de elementos de uma $list." },
  { name: "$Increment", snippet: "$Increment(${1:var})", doc: "Incrementa atomicamente um contador/global." },
  { name: "$Extract", snippet: "$Extract(${1:string}${2:,start${3:,end}})", doc: "Extrai uma substring por posição de caractere." },
  { name: "$Length", snippet: "$Length(${1:string}${2:,delim})", doc: "Tamanho de uma string, ou número de peças se delim informado." },
  { name: "$Find", snippet: "$Find(${1:string},${2:substring})", doc: "Posição de uma substring dentro de uma string." },
  { name: "$Translate", snippet: "$Translate(${1:string},${2:from}${3:,to})", doc: "Substitui/remove caracteres de uma string." },
  { name: "$ZDateTime", snippet: "$ZDateTime(${1:$Horolog})", doc: "Formata um valor $Horolog como data/hora." },
  { name: "$ZDate", snippet: "$ZDate(${1:$Horolog})", doc: "Formata um valor $Horolog como data." },
  { name: "$ClassName", snippet: "$ClassName(${1:oref})", doc: "Nome da classe de uma referência de objeto." },
  { name: "$IsObject", snippet: "$IsObject(${1:expr})", doc: "Verifica se um valor é uma referência de objeto válida." },
  { name: "$This", snippet: "$This", doc: "Referência ao objeto atual (dentro de um método de instância)." },
  { name: "$Random", snippet: "$Random(${1:n})", doc: "Número aleatório entre 0 e n-1." },
  { name: "$Justify", snippet: "$Justify(${1:expr},${2:width})", doc: "Formata um valor justificado numa largura fixa." },
  { name: "$System", snippet: "$System.${1:Util}", doc: "Acesso às classes utilitárias do sistema (%SYSTEM.*) — continue digitando após o ponto." },
  { name: "$ZConvert", snippet: "$ZConvert(${1:string},${2:code})", doc: "Converte uma string (maiúsculas/minúsculas, codificação, etc)." },
  { name: "$ZStrip", snippet: "$ZStrip(${1:string},${2:code})", doc: "Remove espaços/caracteres de controle de uma string." },
  { name: "$Horolog", snippet: "$Horolog", doc: "Data e hora atuais do sistema, no formato interno (dias,segundos)." },
  { name: "$Job", snippet: "$Job", doc: "Número do processo atual." },
  { name: "$Username", snippet: "$Username", doc: "Nome do usuário autenticado no processo atual." },
  { name: "$Namespace", snippet: "$Namespace", doc: "Namespace atual do processo." },
  { name: "$Test", snippet: "$Test", doc: "Resultado (0/1) do último comando condicional (If/Lock com timeout, etc)." },
];

interface Snippet {
  label: string;
  doc: string;
  body: string;
}

const SNIPPETS: Snippet[] = [
  {
    label: "Class",
    doc: "Esqueleto de definição de classe",
    body: "Class ${1:Package.ClassName} Extends ${2:%RegisteredObject}\n{\n\n$0\n}\n",
  },
  {
    label: "ClassMethod",
    doc: "Esqueleto de ClassMethod",
    body: "ClassMethod ${1:MethodName}(${2:}) As ${3:%Status}\n{\n\t$0\n}",
  },
  {
    label: "Method",
    doc: "Esqueleto de Method (instância)",
    body: "Method ${1:MethodName}(${2:}) As ${3:%Status}\n{\n\t$0\n}",
  },
  {
    label: "Property",
    doc: "Declaração de propriedade",
    body: "Property ${1:Name} As ${2:%String};",
  },
  {
    label: "Parameter",
    doc: "Declaração de parâmetro de classe",
    body: "Parameter ${1:Name} = ${2:\"value\"};",
  },
  {
    label: "Index",
    doc: "Declaração de índice",
    body: "Index ${1:Name} On ${2:Property};",
  },
  {
    label: "Trigger",
    doc: "Esqueleto de Trigger",
    body: "Trigger ${1:Name} [ Event = ${2:INSERT} ]\n{\n\t$0\n}",
  },
  {
    label: "Query",
    doc: "Esqueleto de Query",
    body: "Query ${1:Name}(${2:}) As %SQLQuery(CONTAINID = 1)\n{\n\tSELECT $0\n}",
  },
  {
    label: "XData",
    doc: "Bloco de dados XData (ex: UrlMap)",
    body: "XData ${1:UrlMap}\n{\n$0\n}",
  },
  {
    label: "trycatch",
    doc: "Bloco Try/Catch",
    body: "Try {\n\t$1\n}\nCatch ${2:ex} {\n\t$0\n}",
  },
  {
    label: "for",
    doc: "Loop For numérico",
    body: "For ${1:i}=${2:1}:${3:1}:${4:10} {\n\t$0\n}",
  },
  {
    label: "ifelse",
    doc: "If / Else",
    body: "If ${1:condition} {\n\t$2\n} Else {\n\t$0\n}",
  },
];

let registered = false;

function memberSuggestions(
  monaco: typeof Monaco,
  members: ClassMember[],
  range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  return members.map((member) => ({
    label: member.name,
    kind: member.kind === "property" ? monaco.languages.CompletionItemKind.Property : monaco.languages.CompletionItemKind.Method,
    insertText: member.name,
    detail: member.detail ?? (member.kind === "property" ? "property" : member.classMethod ? "class method" : "method"),
    range,
  }));
}

/** Registers keyword/intrinsic-function/snippet completions, plus `##class(...)` class-name
 * completion sourced from whatever namespace ConnectionsPanel last listed (see classIndex.ts), and
 * member completion after a dot — `##class(X).`, `..` (self-reference), or `variable.` where
 * `variable`'s type could be resolved from a formal parameter or property declaration (see
 * classMembers.ts / objectscriptTypeResolver.ts). */
export function registerObjectScriptCompletion(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(OBJECTSCRIPT_LANGUAGE_ID, {
    triggerCharacters: ["$", "#", "."],
    async provideCompletionItems(model, position) {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const wordInfo = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endColumn: wordInfo.endColumn,
      };

      if (/##class\(\s*[\w.]*$/i.test(textUntilPosition)) {
        const classes = getKnownClasses();
        return {
          suggestions: classes.map((name) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: name,
            range,
          })),
        };
      }

      // ##class(Some.Class). — only class methods (incl. %New/%Open/...) are callable this way.
      const classMemberMatch = /##class\(\s*([%\w][\w.]*)\s*\)\s*\.\s*[%\w]*$/i.exec(textUntilPosition);
      if (classMemberMatch) {
        const members = await getClassMembers(classMemberMatch[1]);
        return { suggestions: memberSuggestions(monaco, members.filter((m) => m.classMethod), range) };
      }

      // ..Property / ..Method() — self-reference to the current class's own members.
      if (/(?:^|[^.])\.\.\s*[%\w]*$/.test(textUntilPosition)) {
        const className = parseCurrentClassName(model);
        if (className) {
          const members = await getClassMembers(className);
          return { suggestions: memberSuggestions(monaco, members, range) };
        }
      }

      // variable. — resolvable when the variable's type is written down (a formal parameter or a
      // Property declaration) or inferable from a `Set x = ##class(Y).Method(...)` assignment.
      const varMatch = /([%\p{L}_][\p{L}\p{N}_]*)\.\s*[%\w]*$/u.exec(textUntilPosition);
      if (varMatch) {
        const className = await resolveVariableType(model, position, varMatch[1]);
        if (className) {
          const members = await getClassMembers(className);
          return { suggestions: memberSuggestions(monaco, members, range) };
        }
      }

      // $System.Util. — member completion for a $SYSTEM.* utility class (a real class under the
      // hood, so this reuses the normal class-member lookup once resolved to its %SYSTEM.X name).
      const systemMemberMatch = /\$system\.(\w+)\.\s*[%\w]*$/i.exec(textUntilPosition);
      if (systemMemberMatch) {
        const members = await getClassMembers(`%SYSTEM.${systemMemberMatch[1]}`);
        return { suggestions: memberSuggestions(monaco, members.filter((m) => m.classMethod), range) };
      }

      // $System. — which %SYSTEM.* utility class.
      if (/\$system\.\w*$/i.test(textUntilPosition)) {
        return {
          suggestions: SYSTEM_CLASSES.map((entry) => ({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: entry.name,
            detail: entry.detail,
            range,
          })),
        };
      }

      // As Type — Property/Parameter/method-return type position.
      if (/\bAs\s+[%\w]*$/i.test(textUntilPosition)) {
        return {
          suggestions: DATA_TYPES.map((entry) => ({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: entry.name,
            detail: entry.detail,
            range,
          })),
        };
      }

      if (/\$[\w]*$/.test(textUntilPosition)) {
        return {
          suggestions: INTRINSIC_FUNCTIONS.map((fn) => ({
            label: fn.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: fn.snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: fn.doc,
            detail: "ObjectScript intrinsic",
            range,
          })),
        };
      }

      const suggestions: Monaco.languages.CompletionItem[] = [
        ...collectLocalIdentifiers(model, position).map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: name,
          detail: "variável local",
          range,
        })),
        ...COMMANDS.map((command) => ({
          label: command,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: command,
          detail: "comando",
          range,
        })),
        ...CLASS_KEYWORDS.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          detail: "palavra-chave de classe",
          range,
        })),
        ...SNIPPETS.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: snippet.doc,
          detail: "snippet",
          range,
        })),
      ];
      return { suggestions };
    },
  });
}
