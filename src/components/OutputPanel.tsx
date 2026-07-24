import { useEffect, useRef } from "react";
import SearchPanel, { type SearchMatch } from "./SearchPanel";

export type LogLevel = "info" | "success" | "error";
export type OutputTab = "log" | "search";

export interface LogLine {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

export interface SearchPanelState {
  query: string;
  onQueryChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  onSearch: () => void;
  running: boolean;
  status: string;
  results: SearchMatch[];
  onOpenResult: (docName: string, line: number) => void;
  focusToken: number;
}

interface OutputPanelProps {
  lines: LogLine[];
  onClear: () => void;
  activeTab: OutputTab;
  onActiveTabChange: (tab: OutputTab) => void;
  search: SearchPanelState;
}

function OutputPanel({ lines, onClear, activeTab, onActiveTabChange, search }: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  return (
    <div className="output-panel">
      <div className="output-panel-header">
        <div className="output-panel-tabs">
          <button
            type="button"
            className={activeTab === "log" ? "active" : ""}
            onClick={() => onActiveTabChange("log")}
          >
            Saída
          </button>
          <button
            type="button"
            className={activeTab === "search" ? "active" : ""}
            onClick={() => onActiveTabChange("search")}
          >
            Pesquisar{search.results.length > 0 ? ` (${search.results.length})` : ""}
          </button>
        </div>
        {activeTab === "log" && (
          <button type="button" onClick={onClear}>
            Limpar
          </button>
        )}
      </div>
      <div className="output-panel-body" style={{ display: activeTab === "log" ? "block" : "none" }} ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="output-line output-line-info">Nenhuma saída ainda.</div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`output-line output-line-${line.level}`}>
              <span className="output-line-time">{line.time}</span> {line.message}
            </div>
          ))
        )}
      </div>
      <SearchPanel {...search} active={activeTab === "search"} />
    </div>
  );
}

export default OutputPanel;
