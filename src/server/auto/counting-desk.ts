import type { EventDesk } from "../events/handlers";

// Lesson 17, for sweep.test.ts and sweep.live.ts. The sweep's promises are about its own loop:
// when it stops and what it may touch. So the agents it calls are counted, not run: every
// question gets a fixed draft and every plan a fixed step. The sweep's own model call, the
// picker, is never stood in for: it is the real model in sweep.live.ts, and must not run in
// sweep.test.ts.
export function countingDesk(onStep: () => Promise<void> = async () => {}) {
  const asked: string[] = [];
  const planned: string[] = [];
  const desk = {
    agent: {
      readThread: async () => ({ messages: [] }),
      runTurn: async (turn: { threadId: string; user: { userId: string }; today?: string }) => {
        asked.push(`${turn.user.userId} ${turn.today} ${turn.threadId}`);
        await onStep();
        return { messages: [{ id: "a", type: "ai", content: [{ type: "text", text: "REVIEW_REQUIRED\n\nUse 2.5mg [cardionex-uspi-v3, 2.2]." }], tool_calls: [] }] };
      }
    },
    factChecker: async () => {
      throw new Error("The sweep never fact-checks.");
    },
    outreachPlanner: async (input: { query: string; user: { userId: string; roles: string[] } }) => {
      planned.push(`${input.user.userId} ${input.user.roles.join(",")} ${input.query}`);
      await onStep();
      return { report: `NEEDS_APPROVAL: a step for ${input.query.match(/HCP-\d+/)?.[0]}.`, itemId: `item-${planned.length}` };
    }
  } as unknown as EventDesk;
  return { desk, asked, planned };
}

// OpenFGA as the sweep of pharma_a sees it: its own company's doctors only.
export const fgaOfPharmaA = () => ({ listObjects: async () => ({ objects: ["hcp:HCP-1001", "hcp:HCP-1002", "hcp:HCP-1003"] }) }) as never;
