import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseAgentLine, toolIcon, type TranscriptItem } from "../utils/agentTranscript";
import type { LogLevel } from "./OutputPanel";

interface AgentPanelProps {
  connectionId: string;
  namespace: string;
  onLog: (message: string, level?: LogLevel) => void;
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
  status: "approved" | "discarded";
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

function AgentPanel({ connectionId, namespace, onLog }: AgentPanelProps) {
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
  const runIdRef = useRef<string | null>(null);
  const currentBatchRef = useRef<{ id: string; prompt: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  useEffect(() => {
    if (!hasElectronAPI) return;
    const offEvent = window.electronAPI.agent.onEvent((payload) => {
      if (payload.runId !== runIdRef.current) return;
      const item = parseAgentLine(payload.line);
      if (!item) return;
      setTranscript((prev) => [...prev, { item, stderr: !!payload.stderr }]);
    });
    const offDone = window.electronAPI.agent.onDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setRunning(false);
      setPendingWrites([]);
      onLog(
        payload.code === 0 ? "Agente terminou." : `Agente terminou com código ${payload.code}.`,
        payload.code === 0 ? "success" : "error",
      );
    });
    const offPending = window.electronAPI.agent.onPendingWrite((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setPendingWrites((prev) => [
        ...prev,
        { pendingId: payload.pendingId, name: payload.name, patch: payload.patch },
      ]);
    });
    return () => {
      offEvent();
      offDone();
      offPending();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [transcript]);

  useEffect(() => {
    reviewListRef.current?.scrollTo({ top: reviewListRef.current.scrollHeight });
  }, [reviews]);

  useLayoutEffect(() => {
    const el = reviewListRef.current;
    if (!el) return;
    setReviewViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) =>
      setReviewViewportHeight(entry.contentRect.height),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    setTranscript([]);
    setError(null);
    setRunning(true);
    try {
      runIdRef.current = await window.electronAPI.agent.run(connectionId, namespace, submitted);
      setPrompt("");
    } catch (err) {
      const message = `Erro ao iniciar o agente: ${(err as Error).message}`;
      setError(message);
      onLog(message, "error");
      setRunning(false);
    }
  }

  async function abort() {
    if (!runIdRef.current) return;
    try {
      await window.electronAPI.agent.abort(runIdRef.current);
    } catch (err) {
      setError(`Erro ao parar o agente: ${(err as Error).message}`);
    }
  }

  async function resolvePending(pendingId: string, approved: boolean) {
    const item = pendingWrites.find((entry) => entry.pendingId === pendingId);
    if (!item) return;
    setResolvingIds((prev) => new Set(prev).add(pendingId));
    try {
      await window.electronAPI.agent.resolvePendingWrite(pendingId, approved);
      setPendingWrites((prev) => prev.filter((entry) => entry.pendingId !== pendingId));
      onLog(
        `${item.name}: ${approved ? "aprovado e salvo no servidor." : "rejeitado."}`,
        approved ? "success" : "info",
      );
      const batch = currentBatchRef.current;
      if (batch) {
        const historyEntry: HistoryEntry = {
          name: item.name,
          patch: item.patch,
          status: approved ? "approved" : "discarded",
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
  }

  if (!hasElectronAPI) {
    return (
      <div className="agent-panel">
        <p className="connection-status">Disponível apenas rodando no app Electron.</p>
      </div>
    );
  }

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <span className="agent-panel-namespace">🤖 {namespace}</span>
        <span className="agent-panel-sync-status">
          lê e escreve direto no servidor — sem cópia local
        </span>
      </div>

      {error && (
        <div className="agent-panel-error">
          <span>⚠ {error}</span>
          <button type="button" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="agent-panel-transcript" ref={transcriptRef}>
        {transcript.length === 0 && (
          <p className="connection-status">A saída do agente aparece aqui.</p>
        )}
        {transcript.map((entry, index) => {
          const { item } = entry;
          if (item.kind === "text") {
            return (
              <div key={index} className="agent-msg agent-msg-text">
                {item.text}
              </div>
            );
          }
          if (item.kind === "tool") {
            return (
              <details key={index} className="agent-msg agent-msg-tool">
                <summary>
                  <span className="agent-tool-icon">{toolIcon(item.tool)}</span>
                  <span className="agent-tool-name">{item.tool}</span>
                  {item.title && <span className="agent-tool-title">{item.title}</span>}
                </summary>
                {item.diff ? (
                  <div className="agent-panel-diff-patch">{renderDiffLines(item.diff)}</div>
                ) : (
                  item.input !== undefined && (
                    <pre className="agent-tool-input">{JSON.stringify(item.input, null, 2)}</pre>
                  )
                )}
              </details>
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

      {pendingWrites.map((pw) => (
        <div key={pw.pendingId} className="agent-pending-approval">
          <div className="agent-pending-approval-header">
            <span>⏸ Aguardando aprovação — {pw.name}</span>
          </div>
          <div className="agent-panel-diff-patch">{renderDiffLines(pw.patch)}</div>
          <div className="agent-pending-approval-actions">
            <button
              type="button"
              onClick={() => void resolvePending(pw.pendingId, true)}
              disabled={resolvingIds.has(pw.pendingId)}
            >
              ✓ Aprovar e salvar
            </button>
            <button
              type="button"
              className="agent-panel-secondary"
              onClick={() => void resolvePending(pw.pendingId, false)}
              disabled={resolvingIds.has(pw.pendingId)}
            >
              ✕ Rejeitar
            </button>
          </div>
        </div>
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

      <div className="agent-panel-review">
        <div className="agent-panel-review-header">
          <h4>Histórico{reviews.length ? ` — ${reviews.length} rodada(s)` : ""}</h4>
        </div>

        <div className="agent-panel-review-list" ref={reviewListRef} onScroll={handleReviewScroll}>
          {reviews.length === 0 ? (
            <p className="connection-status">Nenhuma alteração ainda — execute um prompt.</p>
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
                      <span className="agent-review-row-toggle">{isExpanded ? "▾" : "▸"}</span>
                      <span>
                        {row.entry.status === "approved" ? "✅ " : "✕ "}
                        {row.entry.name}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="agent-panel-diff-patch" style={{ height: ENTRY_DIFF_HEIGHT }}>
                        {renderDiffLines(row.entry.patch)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentPanel;
