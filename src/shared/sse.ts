import type { StreamEvent } from "./messages";

// Reads server-sent events one block at a time: "event: name", then "data: {json}", then a blank
// line. The chat page and the medinfo CLI (lesson 19) read the same stream with this one reader.
export async function* readEvents(body: ReadableStream<BufferSource>): AsyncGenerator<StreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data) yield { event: name, data: JSON.parse(data) };
      end = buffer.indexOf("\n\n");
    }
  }
}
