import type * as Monaco from "monaco-editor";
import { wireTextmateGrammar } from "./textmate/bridge";

export const OBJECTSCRIPT_LANGUAGE_ID = "objectscript";
const OBJECTSCRIPT_CLASS_SCOPE = "source.objectscript_class";

export const COMMANDS = [
  "break",
  "catch",
  "close",
  "continue",
  "do",
  "d",
  "else",
  "e",
  "for",
  "f",
  "goto",
  "g",
  "halt",
  "h",
  "hang",
  "if",
  "i",
  "job",
  "j",
  "kill",
  "k",
  "lock",
  "l",
  "merge",
  "m",
  "new",
  "n",
  "open",
  "o",
  "quit",
  "q",
  "read",
  "r",
  "return",
  "set",
  "s",
  "throw",
  "try",
  "tstart",
  "tcommit",
  "trollback",
  "use",
  "u",
  "view",
  "while",
  "w",
  "write",
  "xecute",
  "x",
  "zkill",
  "znspace",
  "ztrap",
  "zwrite",
];

export const CLASS_KEYWORDS = [
  "Class",
  "Extends",
  "Method",
  "ClassMethod",
  "Property",
  "Parameter",
  "Index",
  "Trigger",
  "XData",
  "Storage",
  "Query",
  "Relationship",
  "ForeignKey",
  "Projection",
  "Import",
  "Include",
];

let readyPromise: Promise<void> | null = null;

/** Resolves once the ported TextMate grammar is wired in, so callers can wait to avoid an initial Monarch-highlighted flash. */
export function registerObjectScriptLanguage(monaco: typeof Monaco): Promise<void> {
  if (readyPromise) return readyPromise;

  monaco.languages.register({
    id: OBJECTSCRIPT_LANGUAGE_ID,
    extensions: [".cls", ".mac", ".int", ".inc"],
    aliases: ["ObjectScript", "objectscript"],
  });

  monaco.languages.setLanguageConfiguration(OBJECTSCRIPT_LANGUAGE_ID, {
    // Default word boundaries treat $ and % as separators, splitting "$Get"/"%RegisteredObject"/"$$$Macro"
    // into pieces — this keeps them as one word for hover, double-click-select, etc.
    wordPattern: /[$%]{0,3}[A-Za-z_]\w*/,
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  // Instant fallback tokenizer shown while the ported TextMate grammar (below) loads asynchronously.
  monaco.languages.setMonarchTokensProvider(OBJECTSCRIPT_LANGUAGE_ID, {
    ignoreCase: true,
    defaultToken: "",
    commands: COMMANDS,
    classKeywords: CLASS_KEYWORDS,
    tokenizer: {
      root: [
        [/^Class\s/, { token: "keyword.class", next: "@classHeader" }],
        [/^(Method|ClassMethod|Property|Parameter|Index|Trigger|Query|XData)\b/, "keyword.class"],
        { include: "@code" },
      ],
      classHeader: [[/$/, { token: "", next: "@root" }], { include: "@code" }],
      code: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],
        [/##class\s*\(/, { token: "annotation", next: "@classRef" }],
        [/##(super|method|this)\b/, "annotation"],
        [/\$\$\$\w+/, "macro"],
        [/\$\$?\w+/, "variable.predefined"],
        [
          /\b\w+\b/,
          {
            cases: {
              "@commands": "keyword",
              "@classKeywords": "keyword.class",
              "@default": "identifier",
            },
          },
        ],
        [/""/, "string.escape"],
        [/"/, "string", "@string"],
        [/\d+(\.\d+)?/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[<>=+\-*/_'&!]/, "operator"],
      ],
      classRef: [
        [/[^)]+/, "type"],
        [/\)/, { token: "annotation", next: "@pop" }],
      ],
      string: [
        [/""/, "string.escape"],
        [/[^"]+/, "string"],
        [/"/, "string", "@pop"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });

  readyPromise = wireTextmateGrammar(monaco, OBJECTSCRIPT_LANGUAGE_ID, OBJECTSCRIPT_CLASS_SCOPE);
  return readyPromise;
}
