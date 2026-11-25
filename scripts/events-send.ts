// Lesson 16. npm run events:send -- EVT-01
//
// Sends one fixture event from data/hcp/events/events.jsonl to the running app's webhook, signed
// with the sending company's secret (read inside this process, never printed). Add --as pharma_b
// to sign it as another company, or --times 2 to deliver it twice, as a queue retry does.
import "../src/server/load-env";
import { env } from "../src/server/env";
import { fixtureById } from "../src/server/events/events";
import { deliver } from "../src/server/events/send";
import { eventSecrets } from "../src/server/events/webhook";

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const eventId = process.argv[2];
if (!eventId || eventId.startsWith("--")) throw new Error("Name a fixture event, for example: npm run events:send -- EVT-01");
const event = fixtureById(eventId);
const sender = flag("--as") ?? event.tenant_id;
const secret = eventSecrets()[sender];
if (!secret) throw new Error(`No EVENT_SECRET_${sender.toUpperCase()} is set. Run npm run identity:setup again: lesson 16 adds it.`);

for (let n = 1; n <= Number(flag("--times") ?? "1"); n++) {
  const { status, body } = await deliver(`http://127.0.0.1:${env.port}`, sender, secret, event);
  console.log(`Delivery ${n} of ${event.event_id} as ${sender}: ${status} ${body.status ?? ""}`.trim());
  if (body.report ?? body.error) console.log(`  ${body.report ?? body.error}`);
}
console.log("Open the event inbox (/events) to see what it started.");
