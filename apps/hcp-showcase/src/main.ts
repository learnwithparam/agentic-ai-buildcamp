// bun run serve starts the web chat and the MCP door. bun run ask asks from the command line.
import { cliText, serve } from "../../../packages/core/src/surfaces";
import { liveAgent } from "../../../packages/core/src/team";

const PORT = Number(process.env.PORT ?? 3000);

if (process.argv[2] === "serve") {
  const server = serve(liveAgent(), PORT, true);
  console.log(`The team is on http://localhost:${server.port}`);
} else {
  console.log(await cliText(process.argv.slice(2), liveAgent()));
}
