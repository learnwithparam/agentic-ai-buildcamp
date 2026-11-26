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

export const OtherToolCard: ToolCallMessagePartComponent = ({ toolName, status }) => (
  <div className="card">
    <div className="card-head">
      <span className="label">{toolName}</span>
      <StatusChip running={status.type === "running"} />
    </div>
  </div>
);

// Fix 0. One card for the label lookups: what was asked, then each section or version found.
type LookupResult = Partial<LabelHit> & {
  text?: string;
  note?: string;
  sections?: LabelHit[];
  uses?: LabelHit[];
  versions?: { doc_id: string; status: string; reason: string }[];
};

export const LookupCard: ToolCallMessagePartComponent = ({ toolName, args, result, status }) => {
  const out = parse<LookupResult>(result);
  const asked = Object.values((args ?? {}) as Record<string, unknown>).filter((value) => typeof value === "string").join(", ");
  const rows = [
    ...(out?.doc_id && out.section ? [{ id: `${out.doc_id}, ${out.section}`, meta: `${out.country} · ${out.status}`, title: out.title }] : []),
    ...[...(out?.sections ?? []), ...(out?.uses ?? [])].map((hit) => ({ id: `${hit.doc_id}, ${hit.section}`, meta: `${hit.country} · ${hit.status}`, title: hit.title })),
    ...(out?.versions ?? []).map((version) => ({ id: version.doc_id, meta: version.status, title: version.reason }))
  ];
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">{toolName}</span>
        <span>{asked}</span>
        <StatusChip running={status.type === "running"} />
      </div>
      {rows.length > 0 || out?.note ? (
        <div className="card-body">
          {out?.note ? <p>{out.note}</p> : null}
          <ul className="sources">
            {rows.map((row) => (
              <li className="source" key={row.id}>
                <span className="source-id">[{row.id}]</span>
                <span>{row.title}</span>
                <span className="source-meta">{row.meta}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
