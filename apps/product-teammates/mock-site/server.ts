// A small local website that plays one rival, Pulsedesk. It keeps a history of its pages.
// Each week folder holds the pricing and changelog pages as they looked that week.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const HISTORY = join(import.meta.dir, "history");
export const WEEKS = readdirSync(HISTORY).sort();
export type MockSite = { url: string; show: (week: string) => void; stop: () => void };

export function startMockSite(): MockSite {
  let week = WEEKS[0];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      const file = Bun.file(join(HISTORY, week, `${name}.html`));
      if (!(await file.exists())) return new Response("No such page", { status: 404 });
      return new Response(file, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    show: (next) => {
      week = next;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
