import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext, type TaskStore, type User } from "@a2a-js/sdk/server";
import { DatabaseTaskStore } from "@a2a-js/sdk/server/database";
import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import type { ReviewItem } from "../reviews";
import type { Identity } from "../users";

// Lesson 15. Where A2A tasks live. A task that waits for a reviewer can wait for days, so it is
// a row in the app's Postgres (migration 005), not an object in this process.

// The caller, as the A2A server knows them. The identity comes only from the verified token.
export class TokenUser implements User {
  constructor(readonly identity: Identity) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.identity.userId;
  }
}

export const identityOfCaller = (context: ServerCallContext): Identity => {
  if (!(context.user instanceof TokenUser)) throw new Error("An A2A call reached an agent without a verified token.");
  return context.user.identity;
};

// Each task belongs to one person in one company. The owner is read from the token, never from
// the request: a caller who names another tenant in the request still only reaches their own rows.
export const ownerOf = (context: ServerCallContext) => {
  const { tenantId, userId } = identityOfCaller(context);
  return `${tenantId}:${userId}`;
};

const TABLE = "a2a_tasks";

export function createTaskStore(pool: pg.Pool): TaskStore {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  return new DatabaseTaskStore(db, { tableName: TABLE, ownerResolver: ownerOf });
}

// The store's scope for a caller, when a task is read or written outside an A2A request: when a
// reviewer's decision settles the task the caller left waiting.
export const contextFor = (identity: Identity) => new ServerCallContext({ user: new TokenUser(identity) });

// Which task waits on which inbox item, so a reviewer's decision reaches the task.
export class TaskReviews {
  constructor(
    private pool: pg.Pool,
    private store: TaskStore
  ) {}

  async link(itemId: string, taskId: string, caller: Identity) {
    await this.pool.query("INSERT INTO a2a_task_reviews (item_id, task_id, tenant, owner) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
      itemId,
      taskId,
      caller.tenantId,
      caller.userId
    ]);
  }

  // Approved completes every task waiting on the item; sent back rejects it. The reviewer's note
  // goes in the status message, so the agent that asked reads why.
  async settle(item: ReviewItem): Promise<string[]> {
    const { rows } = await this.pool.query<{ task_id: string; tenant: string; owner: string }>(
      "SELECT task_id, tenant, owner FROM a2a_task_reviews WHERE item_id = $1",
      [item.id]
    );
    const settled: string[] = [];
    for (const row of rows) {
      const context = contextFor({ userId: row.owner, tenantId: row.tenant, name: "", email: "", country: "", roles: [] });
      const task = await this.store.load(row.task_id, context);
      if (!task || task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) continue;
      await this.store.save(settledTask(task, item), context);
      settled.push(task.id);
    }
    return settled;
  }
}

export function settledTask(task: Task, item: ReviewItem): Task {
  const approved = item.status === "approved";
  const [who, what] = item.kind === "outreach" ? ["A sales rep", "step"] : ["A medical reviewer", "email"];
  const words = approved ? `${who} approved the ${what}.` : `${who} sent the ${what} back.`;
  return {
    ...task,
    status: {
      state: approved ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_REJECTED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: `${task.id}-decision`,
        contextId: task.contextId,
        taskId: task.id,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: "text", value: item.note ? `${words} Note: ${item.note}` : words }, metadata: undefined, filename: "", mediaType: "text/plain" }],
        metadata: { itemId: item.id, decision: item.status },
        extensions: [],
        referenceTaskIds: []
      }
    }
  };
}
