// The terminal surface behind `bun run chat`. It asks the server, shows words as they arrive,
// then draws the chart and the table from the same spec the web page uses.
import type { Spec } from "@json-render/core";
import { Box, render, renderToString, Text, useApp } from "ink";
import { useEffect, useState } from "react";

export type CliEvent = { kind: "word"; text: string } | { kind: "chart"; spec: Spec };
export type Bar = { label: string; percent: number };
export type Table = { columns: string[]; rows: string[][] };

const BAR_WIDTH = 30;

type Props = Record<string, unknown>;
function propsOf(spec: Spec, type: string): Props[] {
  return Object.values(spec.elements)
    .filter((element) => element.type === type)
    .map((element) => element.props as Props);
}

export function barsOf(spec: Spec): Bar[] {
  return propsOf(spec, "Progress").map((props) => ({
    label: String(props.label),
    percent: Number(props.value),
  }));
}

export function tableOf(spec: Spec): Table | undefined {
  const props = propsOf(spec, "Table")[0];
  if (props === undefined) return undefined;
  return { columns: props.columns as string[], rows: props.rows as string[][] };
}

// #region step:surfaces
function parseEvent(block: string): CliEvent | undefined {
  const lines = block.split("\n");
  const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
  if (data === undefined || data === "[DONE]") return undefined;
  if (lines.includes("event: chart")) return { kind: "chart", spec: JSON.parse(data) as Spec };
  const word = JSON.parse(data).choices?.[0]?.delta?.content;
  return typeof word === "string" ? { kind: "word", text: word } : undefined;
}

// Ask the server and hand back each word and the chart as they arrive.
export async function* askServer(
  base: string,
  question: string,
  person: string,
): AsyncGenerator<CliEvent> {
  const messages = [{ role: "user", content: question }];
  const headers = { "content-type": "application/json", "x-person": person };
  const reply = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages }),
  });
  if (reply.body === null) return;
  let waiting = "";
  for await (const piece of reply.body.pipeThrough(new TextDecoderStream())) {
    const blocks = (waiting + piece).split("\n\n");
    waiting = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseEvent(block);
      if (event !== undefined) yield event;
    }
  }
}

function BarRows(props: { bars: Bar[] }) {
  const width = Math.max(...props.bars.map((bar) => bar.label.length));
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.bars.map((bar) => (
        <Box key={bar.label}>
          <Text>{bar.label.padEnd(width + 1)}</Text>
          <Text color="cyan">{"█".repeat(Math.round((bar.percent / 100) * BAR_WIDTH))}</Text>
        </Box>
      ))}
    </Box>
  );
}

function TableRows(props: { table: Table }) {
  const { columns, rows } = props.table;
  const widths = columns.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">
        {line(columns)}
      </Text>
      <Text dimColor>{widths.map((size) => "─".repeat(size)).join("  ")}</Text>
      {rows.map((row) => (
        <Text key={row[0]}>{line(row)}</Text>
      ))}
    </Box>
  );
}

export function ReplyView(props: { text: string; chart?: Spec }) {
  const bars = props.chart === undefined ? [] : barsOf(props.chart);
  const table = props.chart === undefined ? undefined : tableOf(props.chart);
  return (
    <Box flexDirection="column">
      <Text color="green">{props.text}</Text>
      {bars.length > 0 && <BarRows bars={bars} />}
      {table !== undefined && <TableRows table={table} />}
    </Box>
  );
}

// One frame of the screen as plain text with colour codes. Tests compare it to a snapshot.
export function frameOf(text: string, chart: Spec | undefined, columns = 80): string {
  return renderToString(<ReplyView text={text} chart={chart} />, { columns });
}
// #stub
//~ // TODO(surfaces): ask the server, stream the words, and draw the chart and table in Ink
//~ export async function* askServer(
//~   _base: string,
//~   _question: string,
//~   _person: string,
//~ ): AsyncGenerator<CliEvent> {}
//~
//~ export function ReplyView(props: { text: string; chart?: Spec }) {
//~   return <Text>{props.text}</Text>;
//~ }
//~
//~ export function frameOf(text: string, _chart: Spec | undefined, _columns = 80): string {
//~   return text;
//~ }
// #endregion

type AppProps = { base: string; person: string; question: string };

function App(props: AppProps) {
  const { exit } = useApp();
  const [text, setText] = useState("");
  const [chart, setChart] = useState<Spec | undefined>(undefined);
  useEffect(() => {
    (async () => {
      for await (const event of askServer(props.base, props.question, props.person)) {
        if (event.kind === "word") setText((before) => before + event.text);
        else setChart(event.spec);
      }
      exit();
    })();
  }, [props.base, props.question, props.person, exit]);
  return <ReplyView text={text} chart={chart} />;
}

function flag(args: string[], name: string, fallback: string): string {
  const found = args.indexOf(name);
  return found === -1 || found + 1 >= args.length ? fallback : args[found + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const question = flag(args, "--question", "");
  if (question === "") {
    console.log('Add --question "your question". Start the server first with: bun run serve');
    process.exit(1);
  }
  const base = flag(args, "--url", process.env.CHAT_URL ?? "http://localhost:3000");
  render(<App base={base} person={flag(args, "--person", "alice")} question={question} />);
}
