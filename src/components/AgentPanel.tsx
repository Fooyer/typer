import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseAgentLine, toolIcon, type TranscriptItem } from "../utils/agentTranscript";
import { renderMarkdown } from "../utils/markdown";
import {
  addPromptHistoryEntry,
  clearPromptHistory,
  loadPromptHistory,
  tagLatestPromptHistoryEntry,
  type PromptHistoryEntry,
} from "../utils/promptHistory";
import {
  clearActiveSessionId,
  loadActiveSessionId,
  saveActiveSessionId,
} from "../utils/agentSession";
import { loadSpecsDirOverride } from "../utils/specsPreference";
import type { LogLevel } from "./OutputPanel";

interface AgentPanelProps {
  connectionId: string;
  namespace: string;
  onLog: (message: string, level?: LogLevel) => void;
  /** Called after a pending write is approved AND actually lands on the server (not just clicked
   * "approve" — a compile failure after approval does not fire this), so the caller can refresh
   * the file explorer and reload any open tab for that document without the user having to do it
   * by hand. */
  onDocumentSaved?: (connectionId: string, namespace: string, docName: string) => void;
}

interface TranscriptEntry {
  item: TranscriptItem;
  stderr: boolean;
}

interface PendingWriteItem {
  pendingId: string;
  name: string;
  patch: string;
}

interface HistoryEntry {
  name: string;
  patch: string;
  /** "failed" is approved-but-not-saved (e.g. a compile error after the user said yes) — kept
   * distinct from "approved" so the history doesn't show a green checkmark for a change that
   * never actually landed on the server. */
  status: "approved" | "discarded" | "failed";
}

interface ReviewBatch {
  id: string;
  prompt: string;
  entries: HistoryEntry[];
}

type ReviewRow =
  | { key: string; kind: "batch"; prompt: string }
  | { key: string; kind: "entry"; entryKey: string; entry: HistoryEntry };

// Fixed row heights make the history list virtualizable with simple arithmetic instead of
// measuring real DOM nodes — an expanded entry doesn't grow to fit its diff, the diff itself
// scrolls internally at a fixed height (see .agent-panel-diff-entry-row .agent-panel-diff-patch),
// so every row's height is always one of exactly two known values.
const BATCH_ROW_HEIGHT = 30;
const ENTRY_ROW_HEIGHT = 28;
const ENTRY_DIFF_HEIGHT = 280;
const REVIEW_OVERSCAN = 6;

// If nothing has come from the agent in this long while it's still marked "running", opencode has
// likely wedged (or crashed without opencode itself noticing) rather than genuinely still thinking
// — long enough to not false-positive on a slow bash/webfetch call, short enough to not leave the
// user staring at a silent spinner for minutes wondering if anything is happening.
const STALL_MS = 60_000;
const STALL_CHECK_INTERVAL_MS = 2_000;

function reviewRowHeight(row: ReviewRow, expanded: Set<string>): number {
  if (row.kind === "batch") return BATCH_ROW_HEIGHT;
  return ENTRY_ROW_HEIGHT + (expanded.has(row.entryKey) ? ENTRY_DIFF_HEIGHT : 0);
}

function renderDiffLines(patch: string) {
  return patch.split("\n").map((line, index) => {
    const className =
      line.startsWith("+") && !line.startsWith("+++")
        ? "diff-add"
        : line.startsWith("-") && !line.startsWith("---")
          ? "diff-del"
          : line.startsWith("@@")
            ? "diff-hunk"
            : undefined;
    return (
      <div key={index} className={className}>
        {line || " "}
      </div>
    );
  });
}

// A dedicated component (rather than parsing inline in the transcript's .map) so React can key off
// the `text` prop and skip re-parsing a message that already streamed in once a *later* message
// arrives and re-renders the list — opencode's replies are markdown, and rendering the raw string
// showed the literal `**`/`#`/backtick syntax instead of formatted text.
function AgentMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="agent-msg-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AgentPanel({ connectionId, namespace, onLog, onDocumentSaved }: AgentPanelProps) {
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [pendingWrites, setPendingWrites] = useState<PendingWriteItem[]>([]);
  const [reviews, setReviews] = useState<ReviewBatch[]>([]);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => new Set());
  const [reviewScrollTop, setReviewScrollTop] = useState(0);
  const [reviewViewportHeight, setReviewViewportHeight] = useState(0);
  // Saved across tab close/reopen and app restarts (see promptHistory.ts) — loaded once, since a
  // given AgentPanel instance is always scoped to one fixed connectionId+namespace for its whole
  // lifetime (a different one gets its own tab, its own mount).
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[]>(() =>
    loadPromptHistory(connectionId, namespace),
  );
  // The opencode chat this AgentPanel is currently continuing — null means the next prompt starts a
  // brand-new one. Persisted (see agentSession.ts) so it survives closing/reopening this tab.
  const [sessionId, setSessionId] = useState<string | null>(() =>
    loadActiveSessionId(connectionId, namespace),
  );
  // Both side drawers (code changes, prompt history) share one rail — only one open at a time,
  // starting closed so neither costs screen space until the user asks for it.
  const [activeDrawer, setActiveDrawer] = useState<"changes" | "prompts" | null>(null);
  // True once STALL_MS has passed since the last event with nothing new arriving — the run still
  // says "running" (opencode's process hasn't exited), but nothing suggests it's actually doing
  // anything anymore. See the stall-watch effect below.
  const [stalled, setStalled] = useState(false);
  // Live snippet of whatever reasoning text is streaming in right now — reasoning is only ever used
  // to drive the "Pensando…" loader below, never kept in `transcript`, since the full text is just
  // noise once the run has moved on (see the loader-building code near the bottom of this file).
  const [reasoningSnippet, setReasoningSnippet] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const currentBatchRef = useRef<{ id: string; prompt: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);
  const lastActivityRef = useRef<number>(Date.now());
  // Tracks whether the current run ever showed an explicit error line — read from `onDone` (not
  // React state, since that handler is registered once with an empty dep array and would otherwise
  // see a stale `transcript`) to tell a clean-but-silent process death (most likely the session
  // hitting the model's token/context limit — see the message below) apart from a run that already
  // explained itself.
  const sawErrorRef = useRef(false);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  useEffect(() => {
    if (!hasElectronAPI) return;
    const offEvent = window.electronAPI.agent.onEvent((payload) => {
      if (payload.runId !== runIdRef.current) return;
      lastActivityRef.current = Date.now();
      setStalled(false);
      const item = parseAgentLine(payload.line);
      if (!item) return;
      if (item.kind === "reasoning") {
        setReasoningSnippet(item.text.trim());
        return;
      }
      setReasoningSnippet(null);
      if (item.kind === "error") sawErrorRef.current = true;
      setTranscript((prev) => [...prev, { item, stderr: !!payload.stderr }]);
    });
    const offDone = window.electronAPI.agent.onDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setRunning(false);
      setStalled(false);
      setReasoningSnippet(null);
      setPendingWrites([]);
      // A nonzero exit that never showed an explicit error line usually means the process died
      // quietly rather than opencode reporting why — for a big prompt, the single most likely cause
      // is the session running out of the model's token/context budget mid-generation. Surfacing a
      // guess beats leaving the user staring at a transcript that just... stops.
      if (payload.code !== 0 && !sawErrorRef.current) {
        setTranscript((prev) => [
          ...prev,
          {
            stderr: true,
            item: {
              kind: "error",
              text:
                `O agente encerrou inesperadamente (código ${payload.code}) sem explicar o motivo. ` +
                `Isso costuma acontecer quando a sessão atinge o limite de tokens/contexto do modelo ` +
                `— inicie um Novo Chat para continuar.`,
            },
          },
        ]);
      }
      onLog(
        payload.code === 0 ? "Agente terminou." : `Agente terminou com código ${payload.code}.`,
        payload.code === 0 ? "success" : "error",
      );
    });
    const offPending = window.electronAPI.agent.onPendingWrite((payload) => {
      if (payload.runId !== runIdRef.current) return;
      lastActivityRef.current = Date.now();
      setStalled(false);
      setPendingWrites((prev) => [
        ...prev,
        { pendingId: payload.pendingId, name: payload.name, patch: payload.patch },
      ]);
    });
    // Fires once per run, as soon as opencode's first output line reveals which session it's using
    // (a brand-new one if this run didn't pass `--session`) — see agentRun.ts. Persisting it here
    // means the *next* prompt continues this same chat instead of opencode starting another one.
    const offSession = window.electronAPI.agent.onSession((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setSessionId(payload.sessionId);
      saveActiveSessionId(connectionId, namespace, payload.sessionId);
      const tagged = tagLatestPromptHistoryEntry(connectionId, namespace, payload.sessionId);
      if (tagged) setPromptHistory(tagged);
    });
    return () => {
      offEvent();
      offDone();
      offPending();
      offSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polls rather than a single setTimeout so it keeps re-checking against the latest
  // lastActivityRef instead of needing to be reset/rescheduled on every single event.
  useEffect(() => {
    if (!running) {
      setStalled(false);
      return;
    }
    const interval = setInterval(() => {
      setStalled(Date.now() - lastActivityRef.current > STALL_MS);
    }, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [transcript]);

  useEffect(() => {
    if (activeDrawer !== "changes") return;
    reviewListRef.current?.scrollTo({ top: reviewListRef.current.scrollHeight });
  }, [reviews, activeDrawer]);

  // Re-measures (and re-observes) whenever the drawer opens — it's unmounted while closed, so the
  // ref is null until then and an observer set up only once on mount would never find it.
  useLayoutEffect(() => {
    if (activeDrawer !== "changes") return;
    const el = reviewListRef.current;
    if (!el) return;
    setReviewViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) =>
      setReviewViewportHeight(entry.contentRect.height),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeDrawer]);

  const handleReviewScroll = useCallback(() => {
    setReviewScrollTop(reviewListRef.current?.scrollTop ?? 0);
  }, []);

  function toggleEntryExpanded(entryKey: string) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryKey)) next.delete(entryKey);
      else next.add(entryKey);
      return next;
    });
  }

  const reviewRows = useMemo<ReviewRow[]>(() => {
    const out: ReviewRow[] = [];
    for (const batch of reviews) {
      out.push({ key: `batch:${batch.id}`, kind: "batch", prompt: batch.prompt });
      batch.entries.forEach((entry, index) => {
        out.push({
          key: `entry:${batch.id}:${index}`,
          kind: "entry",
          entryKey: `${batch.id}:${index}`,
          entry,
        });
      });
    }
    return out;
  }, [reviews]);

  const reviewOffsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const row of reviewRows) {
      out.push(acc);
      acc += reviewRowHeight(row, expandedEntries);
    }
    out.push(acc);
    return out;
  }, [reviewRows, expandedEntries]);

  const reviewTotalHeight = reviewOffsets[reviewOffsets.length - 1] ?? 0;

  let reviewStartIndex = 0;
  while (
    reviewStartIndex < reviewRows.length &&
    reviewOffsets[reviewStartIndex + 1] <= reviewScrollTop
  )
    reviewStartIndex++;
  reviewStartIndex = Math.max(0, reviewStartIndex - REVIEW_OVERSCAN);
  let reviewEndIndex = reviewStartIndex;
  while (
    reviewEndIndex < reviewRows.length &&
    reviewOffsets[reviewEndIndex] < reviewScrollTop + reviewViewportHeight
  )
    reviewEndIndex++;
  reviewEndIndex = Math.min(reviewRows.length, reviewEndIndex + REVIEW_OVERSCAN);
  const visibleReviewRows = reviewRows.slice(reviewStartIndex, reviewEndIndex);

  async function runPrompt() {
    const submitted = prompt.trim();
    if (!submitted || running) return;
    currentBatchRef.current = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt: submitted,
    };
    setPromptHistory(
      addPromptHistoryEntry(connectionId, namespace, submitted, sessionId ?? undefined),
    );
    setTranscript([]);
    setError(null);
    setRunning(true);
    setStalled(false);
    setReasoningSnippet(null);
    sawErrorRef.current = false;
    lastActivityRef.current = Date.now();
    try {
      const specsDir = await window.electronAPI.specs.resolveDir(
        connectionId,
        namespace,
        loadSpecsDirOverride(connectionId, namespace),
      );
      runIdRef.current = await window.electronAPI.agent.run(
        connectionId,
        namespace,
        submitted,
        specsDir,
        undefined,
        sessionId ?? undefined,
      );
      setPrompt("");
    } catch (err) {
      const message = `Erro ao iniciar o agente: ${(err as Error).message}`;
      setError(message);
      onLog(message, "error");
      setRunning(false);
    }
  }

  // Starts a fresh chat: opencode gets no `--session` on the next run, so it creates a new one
  // instead of continuing this one. Clears what's on screen too, so it reads as a clean slate — the
  // 50-entry prompt Histórico still keeps this chat's prompts, just visually separated (see the
  // divider in the Histórico drawer) from whatever comes next.
  function startNewChat() {
    clearActiveSessionId(connectionId, namespace);
    setSessionId(null);
    setTranscript([]);
    setReviews([]);
    setPendingWrites([]);
    setError(null);
    setReasoningSnippet(null);
  }

  async function abort() {
    if (!runIdRef.current) return;
    try {
      await window.electronAPI.agent.abort(runIdRef.current);
    } catch (err) {
      setError(`Erro ao parar o agente: ${(err as Error).message}`);
    }
  }

  function handleClearPromptHistory() {
    clearPromptHistory(connectionId, namespace);
    setPromptHistory([]);
  }

  // Optimistic: the dialog closes (item removed from the queue) the instant the user clicks,
  // instead of waiting on the save/compile round trip — the actual write still happens and its
  // outcome is reported via onLog (and reflected in history) once it resolves, in the background.
  function resolvePending(pendingId: string, approved: boolean) {
    const item = pendingWrites.find((entry) => entry.pendingId === pendingId);
    if (!item) return;
    setPendingWrites((prev) => prev.filter((entry) => entry.pendingId !== pendingId));
    setResolvingIds((prev) => new Set(prev).add(pendingId));
    void (async () => {
      try {
        const result = await window.electronAPI.agent.resolvePendingWrite(pendingId, approved);
        const saved = approved && !!result?.saved;
        if (saved) {
          onLog(`${item.name}: aprovado e salvo no servidor.`, "success");
          result?.compileOutput?.forEach((line) => onLog(line, "info"));
          onDocumentSaved?.(connectionId, namespace, item.name);
        } else if (approved) {
          // The user said yes but the write didn't land — surface why instead of the generic
          // success message, so a compile failure doesn't look like it silently worked.
          onLog(
            `${item.name}: aprovado, mas falhou ao salvar no servidor — ${result?.error ?? "erro desconhecido"}.`,
            "error",
          );
        } else {
          onLog(`${item.name}: rejeitado.`, "info");
        }
        const batch = currentBatchRef.current;
        if (batch) {
          const historyEntry: HistoryEntry = {
            name: item.name,
            patch: item.patch,
            status: approved ? (saved ? "approved" : "failed") : "discarded",
          };
          setReviews((prev) => {
            const existing = prev.find((b) => b.id === batch.id);
            if (existing) {
              return prev.map((b) =>
                b.id === batch.id ? { ...b, entries: [...b.entries, historyEntry] } : b,
              );
            }
            return [...prev, { id: batch.id, prompt: batch.prompt, entries: [historyEntry] }];
          });
        }
      } catch (err) {
        onLog(
          `Erro ao ${approved ? "aprovar" : "rejeitar"} ${item.name}: ${(err as Error).message}`,
          "error",
        );
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev);
          next.delete(pendingId);
          return next;
        });
      }
    })();
  }

  if (!hasElectronAPI) {
    return (
      <div className="agent-panel">
        <p className="connection-status">Disponível apenas rodando no app Electron.</p>
      </div>
    );
  }

  const activeReview = pendingWrites[0] ?? null;

  // What to show in the loader while running: the review dialog already makes clear the agent is
  // waiting on a human, so there's nothing useful to add there. Otherwise, describe whatever the
  // last transcript item was — the tool it's currently running, or that it's writing a reply — and
  // fall back to "thinking" before the first event of a run has even arrived.
  const currentActivity =
    running && !activeReview
      ? (() => {
          if (reasoningSnippet) {
            const tail = reasoningSnippet.slice(-80);
            return `💭 ${tail}${reasoningSnippet.length > 80 ? "…" : ""}`;
          }
          const last = transcript[transcript.length - 1]?.item;
          if (!last) return "Pensando…";
          if (last.kind === "tool") return `${toolIcon(last.tool)} ${last.title ?? last.tool}`;
          if (last.kind === "text") return "💬 Escrevendo resposta…";
          return "Pensando…";
        })()
      : null;

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <span className="agent-panel-namespace">🤖 {namespace}</span>
        <button
          type="button"
          className="agent-panel-new-chat-button"
          onClick={startNewChat}
          disabled={running || (!sessionId && transcript.length === 0)}
          title="Encerrar este chat e começar um novo (o próximo prompt não continua a conversa atual)"
        >
          🆕 Novo Chat
        </button>
        {resolvingIds.size > 0 && (
          <span className="agent-panel-saving-badge">
            <span className="agent-panel-saving-spinner" />
            Salvando {resolvingIds.size} alteração(ões)…
          </span>
        )}
      </div>

      {error && (
        <div className="agent-panel-error">
          <span>⚠ {error}</span>
          <button type="button" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="agent-panel-body">
        <div className="agent-panel-history-rail">
          <div className="agent-panel-history-tabstrip">
            <button
              type="button"
              className={`agent-panel-history-tab${activeDrawer === "changes" ? " active" : ""}`}
              onClick={() =>
                setActiveDrawer((current) => (current === "changes" ? null : "changes"))
              }
              title="Alterações de código propostas pelo agente"
            >
              <span className="agent-panel-history-tab-icon">📝</span>
              <span className="agent-panel-history-tab-label">
                Alterações{reviews.length ? ` (${reviews.length})` : ""}
              </span>
            </button>
            <button
              type="button"
              className={`agent-panel-history-tab${activeDrawer === "prompts" ? " active" : ""}`}
              onClick={() =>
                setActiveDrawer((current) => (current === "prompts" ? null : "prompts"))
              }
              title="Histórico de prompts enviados"
            >
              <span className="agent-panel-history-tab-icon">🕘</span>
              <span className="agent-panel-history-tab-label">
                Histórico{promptHistory.length ? ` (${promptHistory.length})` : ""}
              </span>
            </button>
          </div>
          <div className={`agent-panel-history-drawer${activeDrawer ? " open" : ""}`}>
            {activeDrawer === "changes" && (
              <>
                <div className="agent-panel-review-header">
                  <h4>Alterações{reviews.length ? ` — ${reviews.length} rodada(s)` : ""}</h4>
                </div>
                <div
                  className="agent-panel-review-list"
                  ref={reviewListRef}
                  onScroll={handleReviewScroll}
                >
                  {reviews.length === 0 ? (
                    <p className="connection-status">
                      Nenhuma alteração ainda — execute um prompt.
                    </p>
                  ) : (
                    <div className="agent-review-rows" style={{ height: reviewTotalHeight }}>
                      {visibleReviewRows.map((row, i) => {
                        const top = reviewOffsets[reviewStartIndex + i];
                        if (row.kind === "batch") {
                          return (
                            <div
                              key={row.key}
                              className="agent-review-row-batch"
                              style={{ top, height: BATCH_ROW_HEIGHT }}
                              title={row.prompt}
                            >
                              {row.prompt}
                            </div>
                          );
                        }
                        const isExpanded = expandedEntries.has(row.entryKey);
                        return (
                          <div
                            key={row.key}
                            className="agent-review-row-entry"
                            style={{ top, height: reviewRowHeight(row, expandedEntries) }}
                          >
                            <button
                              type="button"
                              className={`agent-panel-diff-entry-summary agent-panel-diff-entry-${row.entry.status}`}
                              onClick={() => toggleEntryExpanded(row.entryKey)}
                            >
                              <span className="agent-review-row-toggle">
                                {isExpanded ? "▾" : "▸"}
                              </span>
                              <span>
                                {row.entry.status === "approved"
                                  ? "✅ "
                                  : row.entry.status === "failed"
                                    ? "⚠️ "
                                    : "✕ "}
                                {row.entry.name}
                              </span>
                            </button>
                            {isExpanded && (
                              <div
                                className="agent-panel-diff-patch"
                                style={{ height: ENTRY_DIFF_HEIGHT }}
                              >
                                {renderDiffLines(row.entry.patch)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
            {activeDrawer === "prompts" && (
              <>
                <div className="agent-panel-review-header">
                  <h4>Histórico{promptHistory.length ? ` — ${promptHistory.length}` : ""}</h4>
                  {promptHistory.length > 0 && (
                    <button
                      type="button"
                      className="agent-panel-history-clear"
                      onClick={handleClearPromptHistory}
                    >
                      Limpar
                    </button>
                  )}
                </div>
                <div className="agent-panel-prompt-history-list">
                  {promptHistory.length === 0 ? (
                    <p className="connection-status">Nenhum prompt enviado ainda.</p>
                  ) : (
                    promptHistory.map((entry, index) => {
                      // Most-recent-first list — a divider marks where the session id changes
                      // between one prompt and the next older one, i.e. a chat boundary.
                      const isChatBoundary =
                        index === 0 || entry.sessionId !== promptHistory[index - 1]?.sessionId;
                      return (
                        <Fragment key={index}>
                          {isChatBoundary && (
                            <div className="agent-panel-prompt-history-divider">💬 Chat</div>
                          )}
                          <button
                            type="button"
                            className="agent-panel-prompt-history-item"
                            title={entry.prompt}
                            onClick={() => setPrompt(entry.prompt)}
                          >
                            <span className="agent-panel-prompt-history-time">
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                            <span className="agent-panel-prompt-history-text">{entry.prompt}</span>
                          </button>
                        </Fragment>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="agent-panel-main">
          <div className="agent-panel-transcript" ref={transcriptRef}>
            {transcript.length === 0 && (
              <p className="connection-status">A saída do agente aparece aqui.</p>
            )}
            {transcript.map((entry, index) => {
              const { item } = entry;
              if (item.kind === "text") {
                return (
                  <div key={index} className="agent-msg agent-msg-text">
                    <AgentMarkdown text={item.text} />
                  </div>
                );
              }
              if (item.kind === "tool") {
                const failed = item.errorText !== undefined;
                return (
                  <details
                    key={index}
                    className={`agent-msg agent-msg-tool${failed ? " agent-msg-tool-failed" : ""}`}
                    // Auto-expanded so a failure is visible the moment it streams in, instead of
                    // hiding behind a collapsed <details> the same as every successful call.
                    open={failed}
                  >
                    <summary>
                      <span className="agent-tool-icon">{failed ? "⚠️" : toolIcon(item.tool)}</span>
                      <span className="agent-tool-name">{item.tool}</span>
                      {item.title && <span className="agent-tool-title">{item.title}</span>}
                    </summary>
                    {failed && <div className="agent-tool-error">{item.errorText}</div>}
                    {item.diff ? (
                      <div className="agent-panel-diff-patch">{renderDiffLines(item.diff)}</div>
                    ) : (
                      item.input !== undefined && (
                        <pre className="agent-tool-input">
                          {JSON.stringify(item.input, null, 2)}
                        </pre>
                      )
                    )}
                  </details>
                );
              }
              if (item.kind === "error") {
                return (
                  <div key={index} className="agent-msg agent-msg-alert">
                    <span className="agent-msg-alert-icon">⚠️</span>
                    <span>{item.text}</span>
                  </div>
                );
              }
              return (
                <div
                  key={index}
                  className={`agent-msg agent-msg-raw${entry.stderr ? " agent-msg-error" : ""}`}
                >
                  {item.text}
                </div>
              );
            })}
          </div>

          {running &&
            (stalled ? (
              <div className="agent-panel-stalled">
                <span>
                  ⚠ O agente não responde há mais de {Math.round(STALL_MS / 1000)}s — pode estar
                  travado.
                </span>
                <button type="button" className="agent-panel-secondary" onClick={abort}>
                  ■ Parar
                </button>
              </div>
            ) : (
              currentActivity && (
                <div className="agent-panel-loader">
                  <span className="agent-panel-loader-spinner" />
                  <span>{currentActivity}</span>
                </div>
              )
            ))}

          <div className="agent-panel-composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Peça algo ao opencode sobre este namespace…"
              disabled={running}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void runPrompt();
              }}
            />
            {running ? (
              <button
                type="button"
                className="agent-panel-run-button agent-panel-stop-button"
                onClick={abort}
              >
                ■ Parar
              </button>
            ) : (
              <button
                type="button"
                className="agent-panel-run-button"
                onClick={runPrompt}
                disabled={!prompt.trim()}
              >
                ▶ Executar (Ctrl+Enter)
              </button>
            )}
          </div>
        </div>
      </div>

      {activeReview && (
        <div className="agent-review-dialog-overlay">
          <div className="agent-review-dialog" key={activeReview.pendingId}>
            <div className="agent-review-dialog-header">
              <div className="agent-review-dialog-title">
                <span className="agent-review-dialog-icon">📝</span>
                <div>
                  <h3>{activeReview.name}</h3>
                  <span className="agent-review-dialog-subtitle">
                    Revisão de alteração proposta pelo agente
                  </span>
                </div>
              </div>
              {pendingWrites.length > 1 && (
                <span className="agent-review-dialog-count">1 de {pendingWrites.length}</span>
              )}
            </div>
            <div className="agent-review-dialog-diff">{renderDiffLines(activeReview.patch)}</div>
            <div className="agent-review-dialog-actions">
              <button
                type="button"
                className="agent-panel-secondary"
                onClick={() => resolvePending(activeReview.pendingId, false)}
              >
                ✕ Rejeitar
              </button>
              <button
                type="button"
                className="agent-panel-run-button"
                onClick={() => resolvePending(activeReview.pendingId, true)}
              >
                ✓ Aprovar e salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentPanel;
