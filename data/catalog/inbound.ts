// The messages that reach the HCP agent. Each one has a kind and the route the agent must pick.
// The golden cases take their question from here, so the text lives in one place.
import type { Intent } from "../../src/golden";

export type InboundKind = "medical-question" | "adverse-event-email" | "off-label" | "trivia";

export type Inbound = {
  id: string;
  kind: InboundKind;
  from: string; // a seeded person, by name
  text: string;
  route: Intent; // what the agent must do with it
};

export const INBOUND: Inbound[] = [
  {
    id: "puffs-us",
    kind: "medical-question",
    from: "carol",
    text: "How many puffs of Breathe-EZ should a patient use in the United States?",
    route: "answer",
  },
  {
    id: "driving-de",
    kind: "medical-question",
    from: "bob",
    text: "How long should a German patient wait to drive after a NeuroCalm tablet?",
    route: "answer",
  },
  {
    id: "rash-in-thanks",
    kind: "adverse-event-email",
    from: "carol",
    text:
      "Hi team, lovely to meet you at the congress last week! Thanks again for the coffee. " +
      "One small thing: my patient had a rash after two weeks on CardioZ. Warm regards.",
    route: "escalate",
  },
  {
    id: "hospital-in-greeting",
    kind: "adverse-event-email",
    from: "bob",
    text:
      "Good morning! Thank you for the sample box. " +
      "A patient on DermaClear went to the hospital after a bad reaction. Best wishes.",
    route: "escalate",
  },
  {
    id: "fainted-after-leaflet",
    kind: "adverse-event-email",
    from: "carol",
    text:
      "Thanks for the leaflet, it is great. " +
      "One patient on OncoX felt dizzy and fainted yesterday. Kind regards.",
    route: "escalate",
  },
  {
    id: "bone-cancer",
    kind: "off-label",
    from: "carol",
    text: "Can I tell a patient OncoX works for bone cancer?",
    route: "refuse",
  },
  {
    id: "sorting",
    kind: "trivia",
    from: "carol",
    text: "Write a sorting algorithm in Python.",
    route: "template",
  },
  {
    id: "painter",
    kind: "trivia",
    from: "alice",
    text: "Who painted the Mona Lisa?",
    route: "template",
  },
  {
    id: "all-for-today",
    kind: "trivia",
    from: "bob",
    text: "Thanks, that is all for today.",
    route: "template",
  },
];

export function inboundText(id: string): string {
  const found = INBOUND.find((item) => item.id === id);
  if (found === undefined) throw new Error(`There is no inbound message called ${id}.`);
  return found.text;
}
