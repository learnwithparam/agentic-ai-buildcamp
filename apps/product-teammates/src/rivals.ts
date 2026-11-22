// A small local website that plays the four rival pricing pages.
// It shows last week's pages or this week's pages, so a lab never touches the open web.
import { join } from "node:path";
import { ROOT } from "../../../scripts/root";

export type Week = "before" | "after";
export type RivalSite = { url: string; show: (week: Week) => void; stop: () => void };
export type World = { fetchRival: (name: string) => Promise<string> };

export function startRivalSite(): RivalSite {
  let week: Week = "before";
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1).toLowerCase();
      const file = Bun.file(join(ROOT, ".data", "competitors", `${name}-${week}.html`));
      if (!(await file.exists())) return new Response("No such rival", { status: 404 });
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

export function siteWorld(url: string): World {
  return {
    fetchRival: async (name) => {
      const reply = await fetch(`${url}/${name.toLowerCase()}`);
      return reply.text();
    },
  };
}
