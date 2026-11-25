import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import express from "express";
import { createPool, migrate } from "../db";
import { env } from "../env";
import { LABEL_SECTIONS, replacedBy, statusOn } from "../labels";
import type { MedinfoAgent } from "../medinfo-agent";
import { cite, fixtureById, type EventResult, type HcpEvent } from "./events";
import { createEventHandler, type EventHandler } from "./handlers";
import { deliver, signDelivery } from "./send";
import { handleJob, InlineQueue, MemoryEventStore, PostgresEventStore, startEventQueue, type EventStore } from "./store";
import { createEventRouter, eventSecrets } from "./webhook";

// Lesson 16. What the event desk promises, without a model call:
//   - a label is in force from its effective date, so the same search reads differently on two days;
//   - only a delivery signed with the sender's own secret is taken, and only about the sender's company;
//   - the same event id is stored once and handled once, however often it arrives;
//   - a handled email keeps no record number at rest;
//   - a job that keeps failing ends in the dead letter queue, and the inbox shows it failed.

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
const pool = createPool(env.testDatabaseUrl);
before(() => migrate(pool));
after(() => pool.end());

const run = randomUUID().slice(0, 8);
// Each test's events get their own ids, so the Postgres runs never meet an earlier run's rows.
const event = (id: string, extra: Partial<HcpEvent> = {}): HcpEvent =>
  ({ ...fixtureById("EVT-04"), event_id: `${id}-${run}`, ...extra }) as HcpEvent;
const handled = (report: string): EventResult => ({ outcome: "HANDLED", report, itemIds: [] });

test("a label is in force from its effective date, not from the day it was written", () => {
  const v2 = LABEL_SECTIONS.find((section) => section.docId === "cardionex-uspi-v2")!;
  const v3 = LABEL_SECTIONS.find((section) => section.docId === "cardionex-uspi-v3")!;
  assert.equal(statusOn(v2, "2026-11-23"), "active");
  assert.equal(statusOn(v3, "2026-11-23"), v3.status, "a label not yet in force keeps its own status");
  assert.equal(statusOn(v2, "2027-03-01"), "superseded");
  assert.equal(statusOn(v3, "2027-03-01"), "active");
  assert.equal(replacedBy("cardionex-uspi-v2", "2026-11-23"), undefined);
  assert.equal(replacedBy("cardionex-uspi-v2", "2027-03-01"), "cardionex-uspi-v3");
});

test("each company's signing secret comes from its own EVENT_SECRET_ line", () => {
  assert.deepEqual(eventSecrets({ EVENT_SECRET_PHARMA_A: "whsec_a", EVENT_SECRET_PHARMA_B: "", OTHER: "x" }), { pharma_a: "whsec_a" });
});

// One store contract, run on both stores: the app's (Postgres) and the dataset run's (memory).
const stores: Array<[string, () => EventStore]> = [
  ["memory", () => new MemoryEventStore()],
  ["Postgres", () => new PostgresEventStore(pool)]
];
for (const [name, makeStore] of stores) {
  describe(`the ${name} event store`, () => {
    test("stores an id once, counts every delivery, and queues only the first", async () => {
      const store = makeStore();
      const queue = new InlineQueue();
      const sent: string[] = [];
      const counting = { send: async (job: { eventId: string }) => void sent.push(job.eventId) };
      const first = await store.receive("pharma_a", event(`once-${name}`), counting);
      const again = await store.receive("pharma_a", event(`once-${name}`), counting);
      assert.equal(first.first, true);
      assert.equal(again.first, false);
      assert.equal(again.row.deliveries, 2);
      assert.deepEqual(sent, [`once-${name}-${run}`]);
      assert.equal((await store.get("pharma_a", `once-${name}-${run}`))?.status, "queued");
      // The same id from another company is another event: ids are per sender.
      assert.equal((await store.receive("pharma_b", event(`once-${name}`, { tenant_id: "pharma_b" }), queue)).first, true);
    });

    test("a job that runs twice handles the event once", async () => {
      const store = makeStore();
      const queue = new InlineQueue();
      let runs = 0;
      const handle = (async () => (runs++, handled("HANDLED once"))) as unknown as EventHandler;
      await store.receive("pharma_a", event(`twice-${name}`), queue);
      const job = { tenantId: "pharma_a", eventId: `twice-${name}-${run}` };
      await handleJob(store, handle, job);
      await handleJob(store, handle, job);
      assert.equal(runs, 1);
      const row = await store.get("pharma_a", job.eventId);
      assert.equal(row?.status, "handled");
      assert.equal(row?.result?.report, "HANDLED once");
    });

    test("a handled email keeps its scrubbed text, never the record number", async () => {
      const store = makeStore();
      const email = { ...fixtureById("EVT-02"), event_id: `email-${name}-${run}` } as HcpEvent;
      assert.match(JSON.stringify(email), /MRN-77310/, "the fixture carries a record number");
      await store.receive("pharma_a", email, new InlineQueue());
      await store.complete("pharma_a", email.event_id, handled("PV_ESCALATION"));
      assert.doesNotMatch(JSON.stringify((await store.get("pharma_a", email.event_id))?.payload), /MRN-77310/);
    });

    test("an event that failed shows as failed, and a handled one is never marked failed", async () => {
      const store = makeStore();
      await store.receive("pharma_a", event(`fail-${name}`), new InlineQueue());
      await store.fail("pharma_a", `fail-${name}-${run}`, "boom");
      assert.equal((await store.get("pharma_a", `fail-${name}-${run}`))?.status, "failed");
      await store.complete("pharma_a", `fail-${name}-${run}`, handled("done on a retry"));
      await store.fail("pharma_a", `fail-${name}-${run}`, "late failure");
      assert.equal((await store.get("pharma_a", `fail-${name}-${run}`))?.status, "handled");
    });
  });
}

describe("the webhook", () => {
  const secrets = { pharma_a: `whsec_${randomBytes(24).toString("base64")}`, pharma_b: `whsec_${randomBytes(24).toString("base64")}` };
  const store = new MemoryEventStore();
  const queue = new InlineQueue();
  let base = "";
  let close = () => {};
  before(async () => {
    const app = express().use(createEventRouter({ secrets, store, queue }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  const post = (tenant: string, body: string, headers: Record<string, string>) => fetch(`${base}/events/${tenant}`, { method: "POST", headers, body });

  test("takes a signed event once, and answers a second delivery as a duplicate", async () => {
    const first = await deliver(base, "pharma_a", secrets.pharma_a, event("hook"));
    assert.deepEqual([first.status, first.body.status], [202, "accepted"]);
    const again = await deliver(base, "pharma_a", secrets.pharma_a, event("hook"));
    assert.deepEqual([again.status, again.body.status, again.body.deliveries], [200, "duplicate", 2]);
    assert.match(again.body.report ?? "", /^DUPLICATE_EVENT: /);
    assert.ok(again.body.report?.includes(cite(`hook-${run}`)));
  });

  test("refuses a delivery not signed with that company's own secret", async () => {
    const signed = signDelivery(secrets.pharma_a, event("forged"));
    const refused = {
      "signed with another company's secret": await post("pharma_b", signed.body, signed.headers),
      "a body changed after signing": await post("pharma_a", signed.body.replace("HCP-1003", "HCP-1001"), signed.headers),
      unsigned: await post("pharma_a", signed.body, { "Content-Type": "application/json" }),
      "signed an hour ago": await post("pharma_a", ...((s) => [s.body, s.headers] as const)(signDelivery(secrets.pharma_a, event("old"), new Date(Date.now() - 3_600_000))))
    };
    for (const [name, response] of Object.entries(refused)) assert.equal(response.status, 401, `${name} was taken`);
    assert.equal((await post("pharma_c", signed.body, signed.headers)).status, 404);
    assert.equal(await store.get("pharma_a", `forged-${run}`), null, "a refused delivery is never stored");
  });

  test("refuses another company's event at the door, without naming it", async () => {
    const other = fixtureById("EVT-06");
    const response = await deliver(base, "pharma_a", secrets.pharma_a, other);
    assert.equal(response.status, 422);
    assert.match(response.body.report ?? "", /^INSUFFICIENT_CONTEXT: /);
    assert.doesNotMatch(JSON.stringify(response.body), /[Nn]euro[Vv]ex/);
    assert.equal(await store.get("pharma_a", other.event_id), null);
  });

  test("refuses a body that is not an event, and an id that is not the event's own", async () => {
    const notAnEvent = signDelivery(secrets.pharma_a, { event_id: `junk-${run}`, type: "invoice.paid" } as unknown as HcpEvent);
    assert.equal((await post("pharma_a", notAnEvent.body, notAnEvent.headers)).status, 422);
    const real = event("swapped");
    const signed = signDelivery(secrets.pharma_a, real);
    const { Webhook } = await import("standardwebhooks");
    const now = new Date();
    const headers = { ...signed.headers, "webhook-id": "another-id", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(secrets.pharma_a).sign("another-id", now, signed.body) };
    assert.equal((await post("pharma_a", signed.body, headers)).status, 422);
  });
});

describe("the handlers", () => {
  // A stand-in desk that records each question and answers it with a fixed draft.
  const asked: string[] = [];
  const threads = new Map<string, string>();
  const agent = {
    readThread: async (threadId: string) => ({ messages: threads.has(threadId) ? [{ id: "a", type: "ai", content: [{ type: "text", text: threads.get(threadId)! }], tool_calls: [] }] : [] }),
    runTurn: async (turn: { threadId: string; today?: string; messages?: Array<{ content: string }> }) => {
      asked.push(`${turn.today} ${turn.messages?.[0].content}`);
      threads.set(turn.threadId, "REVIEW_REQUIRED\n\nUse 2.5mg [cardionex-uspi-v3, 2.2].");
      return { messages: [{ id: "a", type: "ai", content: [{ type: "text", text: threads.get(turn.threadId)! }], tool_calls: [] }] };
    }
  } as unknown as MedinfoAgent;
  const handle = createEventHandler({ agent, factChecker: (async () => ({})) as never, outreachPlanner: (async () => ({ report: "HOLD_OUTREACH" })) as never });

  test("a label in force redrafts each open answer that cites the label it replaced, on the day it took force", async () => {
    const label = fixtureById("EVT-01");
    const result = await handle(label, "pharma_a");
    assert.equal(result.outcome, "HANDLED");
    assert.match(result.report, /^LABEL_IN_FORCE: cardionex-uspi-v3 replaced cardionex-uspi-v2 on 2027-03-01/);
    assert.ok(result.report.includes("[answers, A-01]"), "the open answer that cites v2 is redrafted");
    assert.ok(!result.report.includes("[answers, A-02]"), "a closed answer is left alone");
    assert.ok(!result.report.includes("[answers, A-04]"), "another company's answer is never read");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^2027-03-01 /);
    // The same event again finds the draft on its thread and asks nothing more.
    await handle(label, "pharma_a");
    assert.equal(asked.length, 1);
  });

  test("an event about another company is refused before any agent reads it", async () => {
    const before = asked.length;
    const result = await handle(fixtureById("EVT-06"), "pharma_a");
    assert.equal(result.outcome, "INSUFFICIENT_CONTEXT");
    assert.doesNotMatch(result.report, /[Nn]euro[Vv]ex/);
    assert.equal(asked.length, before);
  });
});

test("the pg-boss queue runs each first delivery once, and dead-letters an event that keeps failing", { timeout: 60_000 }, async () => {
  const store = new PostgresEventStore(pool);
  let runs = 0;
  const handle = (async (incoming: HcpEvent) => {
    runs++;
    if (incoming.event_id.startsWith("broken")) throw new Error("the handler failed");
    return handled("HANDLED by the worker");
  }) as unknown as EventHandler;
  const queue = await startEventQueue(env.testDatabaseUrl!, store, handle, { retryLimit: 1, retryDelay: 1, retryBackoff: false });
  try {
    await store.receive("pharma_a", event("queued"), queue.queue);
    await store.receive("pharma_a", event("queued"), queue.queue);
    await store.receive("pharma_a", event("broken"), queue.queue);
    const settled = async (id: string, status: string) => {
      for (let wait = 0; wait < 40; wait++) {
        if ((await store.get("pharma_a", `${id}-${run}`))?.status === status) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    };
    assert.ok(await settled("queued", "handled"), "the worker handled the event");
    assert.ok(await settled("broken", "failed"), "the failing event reached the dead letter queue");
    assert.equal((await store.get("pharma_a", `broken-${run}`))?.error, "The event failed after every retry.");
    // queued ran once (two deliveries, one job); broken ran twice (the first try and one retry).
    assert.equal(runs, 3);
  } finally {
    await queue.stop();
  }
});
