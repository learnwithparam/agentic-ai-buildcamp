// bun run serve starts the Hono server. bun run ask asks from the command line.
import { decide, pendingFor } from "../../../packages/core/src/approvals";
import { startServer } from "../../../packages/core/src/server";
import { cliText } from "../../../packages/core/src/surfaces";
import { liveAgent } from "../../../packages/core/src/team";

const PORT = Number(process.env.PORT ?? 3000);

if (process.argv[2] === "serve") {
  const agent = liveAgent();
  const deps = {
    agent: async (question: string, person: string) => ({
      text: (await agent(question, person)).text,
    }),
    pending: pendingFor,
    resume: async (id: string, decision: "approve" | "reject", person: string) => {
      const status = await decide(Number(id), person, decision === "approve");
      return { text: `Approval ${id} is ${status}.` };
    },
  };
  const server = startServer(deps, PORT);
  console.log(`The team is on http://localhost:${server.port}`);
} else {
  console.log(await cliText(process.argv.slice(2), liveAgent()));
}
