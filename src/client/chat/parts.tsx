import type { ReasoningMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

// How each part of an assistant message looks: text, thinking, and one card per tool.

export function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" />;
}

// The model titles each thought as **Title**; the first title previews the folded block.
const firstTitle = (text: string) => /^\s*\*\*(.+?)\*\*/m.exec(text)?.[1];

export const Thinking: ReasoningMessagePartComponent = ({ text, status }) => (
  <details className="card thinking">
    <summary className="card-head">
      <span className="label">Thinking</span>
      {status.type === "running" ? <span className="running">thinking...</span> : <span>{firstTitle(text) ?? "show"}</span>}
    </summary>
    <div className="card-body">
      {text.split("\n").map((line, index) => {
        // The model titles each thought as **Title**; show it bold, without the marks.
        const title = /^\*\*(.+)\*\*$/.exec(line.trim())?.[1];
        return title ? <strong key={index}>{title}</strong> : <span key={index}>{line + "\n"}</span>;
      })}
    </div>
  </details>
);

function parse<T>(result: unknown): T | undefined {
  if (typeof result !== "string") return result as T | undefined;
  try {
    return JSON.parse(result) as T;
  } catch {
    return undefined;
  }
}

function StatusChip({ running }: { running: boolean }) {
  return running ? <span className="status status-wait">running</span> : <span className="status status-pass">done</span>;
}

type LabelHit = { doc_id: string; section: string; title: string; status: string; effective_date: string; country: string };

export const SearchLabelsCard: ToolCallMessagePartComponent = ({ args, result, status }) => {
  const hits = parse<{ results?: LabelHit[] }>(result)?.results ?? [];
  const query = typeof args?.query === "string" ? args.query : "";
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">search_labels</span>
        <span>{query}</span>
        <StatusChip running={status.type === "running"} />
      </div>
      {hits.length > 0 ? (
        <div className="card-body">
          <ul className="sources">
            {hits.map((hit) => (
              <li className="source" key={`${hit.doc_id}-${hit.section}`}>
                <span className="source-id">
                  [{hit.doc_id}, {hit.section}]
                </span>
                <span>{hit.title}</span>
                <span className="source-meta">
                  {hit.country} · {hit.status} · {hit.effective_date}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export const DeskRulesCard: ToolCallMessagePartComponent = ({ result, status }) => {
  const desk = parse<{ rules?: string[] }>(result);
  return (
    <details className="card thinking">
      <summary className="card-head">
        <span className="label">get_desk_rules</span>
        <span>the desk's answering rules</span>
        <StatusChip running={status.type === "running"} />
      </summary>
      {desk?.rules?.length ? (
        <div className="card-body">
          <ul className="rules">
            {desk.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
};

export const OtherToolCard: ToolCallMessagePartComponent = ({ toolName, status }) => (
  <div className="card">
    <div className="card-head">
      <span className="label">{toolName}</span>
      <StatusChip running={status.type === "running"} />
    </div>
  </div>
);
