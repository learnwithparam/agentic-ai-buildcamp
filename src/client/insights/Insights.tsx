import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { createThread, loadThread, streamRun } from "../chat/api";
import { MarkdownText, OtherToolCard, Thinking } from "../chat/parts";

// Lesson 22. The insights page: the same thread as the chat, on its own routes (/api/insights),
// with two tool cards. query_sales shows the SQL that ran and how many rows came back, or why it
// was refused. show_chart draws the rows the server checked against the last result.

const BASE = "/api/insights";
const SUGGESTIONS = [
  "Which territories grew new prescriptions over the last 12 weeks?",
  "Show total prescriptions by month for each territory.",
  "Which territory and period has the fewest prescribers?"
];

type QueryResult = { ok: boolean; sql?: string; columns?: string[]; rows?: unknown[]; truncated?: boolean; refused?: string };
type ChartResult = { ok: boolean; error?: string; chart?: { kind: "line" | "bar"; title: string; x: string; series: string[] }; rows?: Array<Record<string, unknown>> };

function parse<T>(result: unknown): T | undefined {
  if (typeof result !== "string") return result as T | undefined;
  try {
    return JSON.parse(result) as T;
  } catch {
    return undefined;
  }
}

const QueryCard: ToolCallMessagePartComponent = ({ args, result, status }) => {
  const query = parse<QueryResult>(result);
  const sql = typeof args?.sql === "string" ? args.sql : "";
  const running = status.type === "running";
  return (
    <details className="card thinking">
      <summary className="card-head">
        <span className="label">query_sales</span>
        <span>{running ? "running the query" : query?.ok ? `${query.rows?.length ?? 0} rows${query.truncated ? ", cut at 500" : ""}` : "refused"}</span>
        {running ? <span className="status status-wait">running</span> : query?.ok ? <span className="status status-pass">done</span> : <span className="status status-fail">refused</span>}
      </summary>
      <div className="card-body">
        {query && !query.ok && <p className="refusal">{query.refused}</p>}
        <pre className="sql">{sql}</pre>
      </div>
    </details>
  );
};

// The series take the ink and the status colours, in order, so a chart reads on the light canvas.
const SERIES_COLOURS = ["var(--fg)", "var(--pass)", "var(--wait)", "var(--fail)", "var(--muted)", "var(--fg2)"];

const ChartCard: ToolCallMessagePartComponent = ({ result, status }) => {
  const drawn = parse<ChartResult>(result);
  if (status.type === "running" || !drawn) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="label">show_chart</span>
          <span className="status status-wait">drawing</span>
        </div>
      </div>
    );
  }
  if (!drawn.ok || !drawn.chart || !drawn.rows) return <div className="card"><div className="card-body"><p className="refusal">{drawn.error}</p></div></div>;
  const { chart, rows } = drawn;
  const axes = [
    <CartesianGrid key="grid" stroke="var(--line)" vertical={false} />,
    <XAxis key="x" dataKey={chart.x} tick={{ fill: "var(--muted)", fontSize: 12 }} stroke="var(--line)" />,
    <YAxis key="y" tick={{ fill: "var(--muted)", fontSize: 12 }} stroke="var(--line)" width={48} />,
    <Tooltip key="tip" contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontFamily: "var(--sans)" }} />,
    <Legend key="legend" wrapperStyle={{ fontSize: 12 }} />
  ];
  return (
    <figure className="card chart">
      <figcaption className="card-head">
        <span className="label">chart</span>
        <span>{chart.title}</span>
      </figcaption>
      <div className="card-body chart-body">
        <ResponsiveContainer width="100%" height={280}>
          {chart.kind === "line" ? (
            <LineChart data={rows}>
              {axes}
              {chart.series.map((name, index) => (
                <Line key={name} type="monotone" dataKey={name} stroke={SERIES_COLOURS[index]} strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={rows}>
              {axes}
              {chart.series.map((name, index) => (
                <Bar key={name} dataKey={name} fill={SERIES_COLOURS[index]} isAnimationActive={false} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
};

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message-user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message-assistant">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          Reasoning: Thinking,
          tools: { by_name: { query_sales: QueryCard, show_chart: ChartCard }, Fallback: OtherToolCard }
        }}
      />
    </MessagePrimitive.Root>
  );
}

export function Insights({ company }: { company: string }) {
  const runtime = useLangGraphRuntime({
    create: () => createThread(BASE),
    load: (threadId) => loadThread(threadId, BASE),
    stream: async function* (messages, config) {
      const { externalId } = await config.initialize();
      if (!externalId) throw new Error("No thread id");
      yield* streamRun(externalId, messages, config, BASE);
    }
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <div className="column">
            <AuiIf condition={(state) => state.thread.isEmpty}>
              <div className="empty">
                <h1>Ask about {company}&apos;s sales</h1>
                <p>Answers come from your company&apos;s prescription totals. Groups of fewer than 11 prescribers are hidden.</p>
                <div className="suggestions">
                  {SUGGESTIONS.map((prompt) => (
                    <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send asChild>
                      <button type="button" className="suggestion">
                        {prompt}
                      </button>
                    </ThreadPrimitive.Suggestion>
                  ))}
                </div>
              </div>
            </AuiIf>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input className="composer-input" placeholder="Ask a question about your sales" autoFocus />
          <ComposerPrimitive.Send className="button button-primary">Send</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
