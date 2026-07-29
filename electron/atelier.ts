/**
 * Minimal client for InterSystems' Atelier REST API (the same API used by the official
 * vscode-objectscript extension) — lets an IDE browse/edit/compile classes and routines on a
 * remote IRIS/Caché server without a native driver, just HTTP(S) + Basic auth.
 */
export interface AtelierConnectionConfig {
  host: string;
  port: number;
  https: boolean;
  pathPrefix?: string;
  username: string;
  password: string;
}

export interface AtelierResponse<T = unknown> {
  status: { errors: string[]; summary: string };
  console: string[];
  result: T;
}

export interface AtelierServerInfo {
  version: string;
  id: string;
  api: number;
  namespaces: string[];
}

export interface AtelierDocNameEntry {
  name: string;
  cat: string;
  date?: string;
}

export interface AtelierDocument {
  name: string;
  ts: string;
  cat: string;
  enc: boolean;
  content: string[];
}

class AtelierError extends Error {}

/**
 * Session cookies per connection, so repeated calls reuse one CSP/IRIS session instead of each
 * Basic-Auth request spinning up a new one — IRIS Community/eval licenses only allow a handful of
 * concurrent sessions, and hammering it with unauthenticated-per-request calls exhausts that pool
 * fast (surfaces as random 503 Service Unavailable / 409 Conflict errors).
 */
const cookieJar = new Map<string, string[]>();

function cookieKey(config: AtelierConnectionConfig): string {
  return `${config.username}@${config.host}:${config.port}${config.pathPrefix ?? ""}`;
}

function updateCookies(key: string, setCookieHeaders: string[]) {
  if (!setCookieHeaders.length) return;
  const merged = [...(cookieJar.get(key) ?? [])];
  for (const raw of setCookieHeaders) {
    const pair = raw.split(";")[0];
    const name = pair.split("=")[0];
    const index = merged.findIndex((c) => c.startsWith(`${name}=`));
    if (index >= 0) merged[index] = pair;
    else merged.push(pair);
  }
  cookieJar.set(key, merged);
}

export function clearSession(config: AtelierConnectionConfig): void {
  cookieJar.delete(cookieKey(config));
}

function buildUrl(
  config: AtelierConnectionConfig,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
) {
  const prefix = config.pathPrefix
    ? config.pathPrefix.startsWith("/")
      ? config.pathPrefix
      : `/${config.pathPrefix}`
    : "";
  const query = params
    ? Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(
          ([key, value]) =>
            `${key}=${encodeURIComponent(typeof value === "boolean" ? (value ? "1" : "0") : String(value))}`,
        )
    : [];
  const queryString = query.length ? `?${query.join("&")}` : "";
  return `${config.https ? "https" : "http"}://${config.host}:${config.port}${prefix}/api/atelier/${path}${queryString}`;
}

async function request<T>(
  config: AtelierConnectionConfig,
  method: string,
  path: string,
  options: { body?: unknown; params?: Record<string, string | number | boolean | undefined> } = {},
): Promise<AtelierResponse<T>> {
  const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  const key = cookieKey(config);
  const cookies = cookieJar.get(key) ?? [];
  let response: Response;
  try {
    response = await fetch(buildUrl(config, path, options.params), {
      method,
      headers: {
        Accept: "application/json",
        // Sent alongside any existing session cookie: if the cookie is still valid IRIS uses it
        // and ignores this; if it expired, this re-establishes a session without a round trip.
        Authorization: `Basic ${auth}`,
        ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    const reason =
      code === "ECONNREFUSED"
        ? "conexão recusada — o servidor está no ar nesse host/porta?"
        : code === "ENOTFOUND"
          ? "host não encontrado — confira o endereço."
          : code === "ECONNRESET" || code === "ETIMEDOUT"
            ? "conexão perdida ou expirou."
            : "falha de rede.";
    throw new AtelierError(`Não foi possível conectar a ${config.host}:${config.port} — ${reason}`);
  }

  updateCookies(key, response.headers.getSetCookie?.() ?? []);

  if (response.status === 401) {
    cookieJar.delete(key);
    throw new AtelierError("Autenticação falhou: usuário ou senha incorretos.");
  }
  if (response.status === 404) {
    throw new AtelierError(
      "Servidor não encontrado (404): verifique host, porta e prefixo de caminho.",
    );
  }
  if (!response.ok && response.status !== 400 && response.status !== 500) {
    throw new AtelierError(`Erro HTTP ${response.status}: ${response.statusText}`);
  }

  let data: AtelierResponse<T>;
  try {
    data = (await response.json()) as AtelierResponse<T>;
  } catch {
    throw new AtelierError(
      "Resposta do servidor não é um JSON válido — confirme se é um servidor IRIS/Caché com a API Atelier habilitada.",
    );
  }
  if (data.status?.summary) {
    throw new AtelierError(data.status.summary);
  }
  return data;
}

export async function getServerInfo(config: AtelierConnectionConfig): Promise<AtelierServerInfo> {
  const response = await request<{ content: AtelierServerInfo }>(config, "GET", "");
  return response.result.content;
}

/**
 * Lists documents via the same `%Library.RoutineMgr_StudioOpenDialog` stored procedure Studio and
 * vscode-objectscript use (through action/query), rather than the plain Atelier `docnames` REST
 * endpoint — `docnames` has no way to exclude system-provided classes/routines (its `filter` param
 * also doesn't reliably match names nested in packages), while this procedure's `systemFiles`
 * argument does the filtering server-side, matching what "regular" ObjectScript tooling shows.
 */
export async function listDocuments(
  config: AtelierConnectionConfig,
  namespace: string,
  includeSystem = false,
): Promise<AtelierDocNameEntry[]> {
  const spec = "*.cls,*.mac,*.int,*.inc";
  const systemFiles = includeSystem || namespace === "%SYS" ? "1" : "0";
  const response = await request<{ content: { Name: string; Type: string }[] }>(
    config,
    "POST",
    `v1/${namespace}/action/query`,
    {
      body: {
        query: "SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,?,?,?,?,?,?)",
        parameters: [spec, "1", "1", systemFiles, "1", "0", "0"],
      },
    },
  );
  return (response.result.content ?? []).map((entry) => ({ name: entry.Name, cat: entry.Type }));
}

export async function getDocument(
  config: AtelierConnectionConfig,
  namespace: string,
  name: string,
): Promise<AtelierDocument> {
  const response = await request<AtelierDocument>(
    config,
    "GET",
    `v1/${namespace}/doc/${encodeURIComponent(name)}`,
  );
  return response.result;
}

export async function saveDocument(
  config: AtelierConnectionConfig,
  namespace: string,
  name: string,
  contentLines: string[],
): Promise<void> {
  // ignoreConflict: this is a single-user dev tool with no local caching of the last-seen server
  // timestamp, so the Atelier API's optimistic-concurrency check (based on `mtime`) has nothing
  // valid to compare against and would otherwise always report a 409 Conflict.
  await request(config, "PUT", `v1/${namespace}/doc/${encodeURIComponent(name)}`, {
    body: { enc: false, content: contentLines, mtime: 0 },
    params: { ignoreConflict: true },
  });
}

export async function deleteDocument(
  config: AtelierConnectionConfig,
  namespace: string,
  name: string,
): Promise<void> {
  await request(config, "DELETE", `v1/${namespace}/doc/${encodeURIComponent(name)}`);
}

export interface RestCallResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

/**
 * Calls an arbitrary path on the connection's own host/port — used by the API tester to hit a
 * class's real %CSP.REST endpoints (resolved separately via Security.Applications), not the
 * /api/atelier/ API this file otherwise talks to. Runs here in the main process (not the renderer)
 * so the request carries Basic Auth cleanly and isn't subject to the renderer's CORS restrictions.
 */
export async function callRestRoute(
  config: AtelierConnectionConfig,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RestCallResult> {
  const url = `${config.https ? "https" : "http"}://${config.host}:${config.port}${path}`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  const finalHeaders: Record<string, string> = { Authorization: `Basic ${auth}`, ...headers };
  const upperMethod = method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(upperMethod) && body !== undefined && body !== "";

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: upperMethod,
      headers: finalHeaders,
      body: hasBody ? body : undefined,
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    const reason =
      code === "ECONNREFUSED"
        ? "conexão recusada — a aplicação está no ar nesse host/porta?"
        : code === "ENOTFOUND"
          ? "host não encontrado — confira o endereço."
          : code === "ECONNRESET" || code === "ETIMEDOUT"
            ? "conexão perdida ou expirou."
            : "falha de rede.";
    throw new AtelierError(`Não foi possível chamar ${url} — ${reason}`);
  }
  const durationMs = Date.now() - started;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const responseBody = await response.text();

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
    durationMs,
  };
}

export async function compileDocuments(
  config: AtelierConnectionConfig,
  namespace: string,
  docs: string[],
): Promise<string[]> {
  const response = await request<string[]>(config, "POST", `v1/${namespace}/action/compile`, {
    body: docs,
    params: { flags: "cuk", source: false },
  });
  return response.console;
}

export interface AtelierQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export async function runQuery(
  config: AtelierConnectionConfig,
  namespace: string,
  sql: string,
  parameters: unknown[] = [],
): Promise<AtelierQueryResult> {
  const response = await request<{ content: Record<string, unknown>[] }>(
    config,
    "POST",
    `v1/${namespace}/action/query`,
    {
      body: { query: sql, parameters },
    },
  );
  const rows = response.result.content ?? [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export interface AtelierSearchMatch {
  line: number;
  text: string;
}

export interface AtelierSearchFileResult {
  doc: string;
  matches: AtelierSearchMatch[];
}

/**
 * Server-side full-text search, added in the Atelier API in v2 (IRIS 2023.1+): IRIS greps document
 * content on the server and returns only the matches, instead of the caller downloading every
 * document to grep client-side. Older servers don't expose the v2 route at all (request() throws on
 * the resulting 404) — callers are expected to catch that and fall back to download-and-grep.
 *
 * The exact response shape wasn't verified against a live server when this was written (Documatic's
 * page for %Api.Atelier.v2 doesn't render statically); the shape-guard below throws a distinct error
 * if `result` doesn't look like { doc, matches: [{ line, text }] }[], so callers can tell "endpoint
 * doesn't exist" apart from "endpoint exists but replies differently than expected" and fall back
 * either way.
 */
export async function searchInFiles(
  config: AtelierConnectionConfig,
  namespace: string,
  query: string,
  documents: string,
  includeSystem = false,
): Promise<AtelierSearchFileResult[]> {
  const sys = includeSystem || namespace === "%SYS";
  const response = await request<unknown>(config, "GET", `v2/${namespace}/action/search`, {
    params: { query, documents, regex: false, sys, max: 5000 },
  });
  const raw = response.result as { content?: unknown } | unknown[] | null;
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.content) ? raw.content : null;
  if (!list)
    throw new AtelierError(
      "Formato de resposta inesperado do endpoint de busca (v2/action/search).",
    );
  for (const entry of list) {
    const e = entry as { doc?: unknown; matches?: unknown };
    if (typeof e?.doc !== "string" || !Array.isArray(e.matches)) {
      throw new AtelierError(
        "Formato de resultado inesperado do endpoint de busca (v2/action/search).",
      );
    }
    for (const m of e.matches as unknown[]) {
      const match = m as { line?: unknown; text?: unknown };
      if (typeof match?.line !== "number" || typeof match?.text !== "string") {
        throw new AtelierError(
          "Formato de ocorrência inesperado do endpoint de busca (v2/action/search).",
        );
      }
    }
  }
  return list as AtelierSearchFileResult[];
}

/**
 * Server-provided custom Studio menus ("server-side source control" — a class extending
 * `%Studio.Extension.Base` configured as the namespace's source control class can contribute
 * top-level menus, e.g. a custom "Radar" menu). Studio talks to this over its own binary protocol;
 * IRIS also ships `%Atelier_v1_Utils.Extension` as a SQL-callable bridge to the same mechanism —
 * this is exactly what vscode-objectscript's own "server-side source control" commands use
 * (via the same action/query endpoint we already use for the SQL runner), reverse-derived from its
 * `src/commands/studio.ts`.
 */
export interface StudioMenuItem {
  id: string;
  name: string;
  enabled: number;
  save?: number;
  separator?: number;
}

export interface StudioMenu {
  id: string;
  name: string;
  items: StudioMenuItem[];
}

export interface StudioUserAction {
  action: number;
  target: string;
  message: string;
  reload: boolean;
  doc: unknown;
  errorText: string;
}

export async function isStudioExtensionEnabled(
  config: AtelierConnectionConfig,
  namespace: string,
): Promise<boolean> {
  try {
    const result = await runQuery(
      config,
      namespace,
      "SELECT %Atelier_v1_Utils.Extension_ExtensionEnabled() AS Enabled",
      [],
    );
    return Boolean(result.rows[0]?.Enabled);
  } catch {
    return false;
  }
}

export async function getStudioMenus(
  config: AtelierConnectionConfig,
  namespace: string,
  menuType: "main" | "context",
  docName: string,
  selectedText = "",
): Promise<StudioMenu[]> {
  const result = await runQuery(
    config,
    namespace,
    "select * from %Atelier_v1_Utils.Extension_GetMenus(?,?,?)",
    [menuType, docName, selectedText],
  );
  return result.rows as unknown as StudioMenu[];
}

export async function invokeStudioUserAction(
  config: AtelierConnectionConfig,
  namespace: string,
  type: number,
  actionId: string,
  docName: string,
  selectedText = "",
): Promise<StudioUserAction | null> {
  const result = await runQuery(
    config,
    namespace,
    "select * from %Atelier_v1_Utils.Extension_UserAction(?, ?, ?, ?)",
    [String(type), actionId, docName, selectedText],
  );
  const rows = result.rows as unknown as StudioUserAction[];
  return rows.length ? rows[rows.length - 1] : null;
}

export async function invokeStudioAfterUserAction(
  config: AtelierConnectionConfig,
  namespace: string,
  type: number,
  actionId: string,
  docName: string,
  answer: string,
  msg: string,
): Promise<StudioUserAction | null> {
  const result = await runQuery(
    config,
    namespace,
    "select * from %Atelier_v1_Utils.Extension_AfterUserAction(?, ?, ?, ?, ?)",
    [String(type), actionId, docName, answer, msg],
  );
  const rows = result.rows as unknown as StudioUserAction[];
  return rows.length ? rows[rows.length - 1] : null;
}
