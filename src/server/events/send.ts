import { Webhook } from "standardwebhooks";
import type { HcpEvent } from "./events";

// Lesson 16. How a sender signs one delivery, the Standard Webhooks way: the event id, the time
// and the exact body, signed with the company's secret. npm run events:send and the dataset run
// both send through this, to the same webhook the app serves.
export function signDelivery(secret: string, event: HcpEvent, at = new Date()) {
  const body = JSON.stringify(event);
  const signature = new Webhook(secret).sign(event.event_id, at, body);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": event.event_id,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": signature
    }
  };
}

export async function deliver(baseUrl: string, tenantId: string, secret: string, event: HcpEvent) {
  const { body, headers } = signDelivery(secret, event);
  const response = await fetch(`${baseUrl}/events/${tenantId}`, { method: "POST", headers, body });
  return { status: response.status, body: (await response.json()) as { eventId?: string; status?: string; deliveries?: number; report?: string; error?: string } };
}
