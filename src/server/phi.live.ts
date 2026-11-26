// Lesson 13, on the real model through the gateway (npm run check:live): what the finder
// returns for names and addresses the rules miss. The rules are proven in phi.test.ts.
import { stopTracing } from "../../scripts/live-spans";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useService } from "./gateway";
import { PhiVault, findOnly, findSpans, pseudonymise } from "./phi";
import { modelSpanFinder } from "./phi.model";

useService("eval-runner");
after(stopTracing);
const find = modelSpanFinder();

// Written with no cue the rules know: no title, no "my patient", no identifier beside the name.
const MISSED = [
  { text: "After the fall, the person we call Zelda Quimby was taken by her neighbour to the hospital, and the doctor says she should stop CardioNex.", name: "Zelda Quimby" },
  { text: "Quimby, Zelda is the surname-first entry in our chart for the woman who took 40 mg by mistake and now feels faint.", name: "Quimby, Zelda" },
  { text: "The man in bed 4 is Bartholomew Fenwick-Okafor and he has had a cough since starting CardioNex.", name: "Bartholomew Fenwick-Okafor" }
];

test("the finder names a patient the rules miss, in words that are in the text", async () => {
  for (const { text, name } of MISSED) {
    assert.deepEqual(findSpans(text).filter((span) => span.type === "name"), [], `the rules found a name in: ${text}`);
    const found = await find(text);
    assert.ok(found.length > 0, `no name found in: ${text}`);
    for (const item of found) assert.ok(text.includes(item.text), `${item.text} is not in the text`);
    const spans = findOnly(text, found);
    assert.ok(spans.some((span) => span.text.includes(name.split(/[ ,]+/)[0]!)), `${name} was not found in: ${text}`);
  }
});

test("the finder leaves the doctor, the clinic, the medicine and the numbers alone", async () => {
  const text = "I am Dr Sofia Marques at the Lakeside Heart Clinic. My patient is 70, eGFR 32, K 6.1, on CardioNex 20 mg since 3 Nov. What does section 5.1 say about CLARION-HF?";
  const found = await find(text);
  assert.deepEqual(found, [], `the finder returned ${JSON.stringify(found)}`);
});

test("the finder never sees what the rules already took, and the whole turn hides it", async () => {
  const vault = new PhiVault();
  const text = "Mrs Hanna Keller (DOB 14/03/1951) was driven by the person we call Zelda Quimby. Her potassium was 6.1 on CardioNex.";
  let sent = "";
  const out = await pseudonymise(text, vault, (scrubbed) => {
    sent = scrubbed;
    return find(scrubbed);
  });
  assert.ok(!sent.includes("Hanna Keller") && !sent.includes("14/03/1951"), `the finder was sent: ${sent}`);
  assert.ok(!out.text.includes("Zelda"), out.text);
  assert.match(out.text, /potassium was 6\.1/);
});
