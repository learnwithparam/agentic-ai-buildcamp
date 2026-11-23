/**
 * Seed the 20 traces for section 4.1 Error analysis.
 *
 * Seven traces are ordinary one-turn label answers. The other thirteen each
 * contain exactly one failure mode:
 *   - 5 out-of-scope requests that the agent answers (a hotel, a sick note, an off-label use,
 *     a billing code, another company's product)
 *   - 2 impersonation replies, where the agent speaks as a fellow doctor.
 *     The label facts stay right. The voice does not announce "I'm a doctor."
 *   - 2 obvious impersonation replies. The clinician asks who the agent is, and the answer is "I'm a doctor."
 *   - 4 lengthy, unstructured replies to an in-scope question
 *
 * Failure traces are a mix of one-turn questions and longer sessions of two or
 * three turns. The failure is only on the latest answer. Earlier turns in a
 * longer session are ordinary label answers, so a trace does not stack modes.
 *
 * This script does not write scores. Open coding and pass/fail are a separate
 * step: npm run langfuse:seed:error-analysis:annotations.
 *
 * Not idempotent: every run creates 20 new traces.
 *
 *   npm run langfuse:seed:error-analysis
 *   npm run langfuse:seed:error-analysis -- --dry-run
 *   npx tsx scripts/seed-error-analysis-traces.ts --check
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag } from "./langfuse-trace-seed-lib";
import {
  assertBundlesMatch,
  buildSyntheticSnapshot,
  replaySnapshot,
  stepsAnswer,
  userTurnCount,
  type ChatTurn,
  type Guide,
  type SyntheticTurn
} from "./synthetic-trace-seed";

const SEED_TAG = "error-analysis-seed";

export type FailureMode = "good" | "out-of-scope" | "impersonation" | "lengthy";

export type ErrorAnalysisScenario = SyntheticTurn & { mode: FailureMode; obviousIdentity?: boolean };

const cardiozUsGuide: Guide = {
  title: "CardioZ US label, version 3 (current, effective 2025-06-01)",
  summary: "CardioZ lowers blood pressure in adults.",
  steps: ["Take 20 mg each morning.", "Do not use in pregnancy."]
};

const cardiozJpGuide: Guide = {
  title: "CardioZ Japan label, version 1 (effective 2025-04-01)",
  summary: "In Japan only the 10 mg tablet is approved.",
  steps: ["Take 10 mg once daily after breakfast."]
};

const oncoxUsGuide: Guide = {
  title: "OncoX US label, version 2 (current, effective 2025-09-01)",
  summary: "OncoX treats kidney cancer.",
  steps: ["Take 150 mg once daily with food.", "Check the liver monthly."]
};

const oncoxDeGuide: Guide = {
  title: "OncoX Germany label, version 1 (effective 2025-01-15)",
  summary: "In Germany only the 100 mg tablet is approved.",
  steps: ["Take 100 mg once daily with food."]
};

const breatheGuide: Guide = {
  title: "Breathe-EZ US label, version 1 (effective 2025-03-10)",
  summary: "Breathe-EZ is a rescue inhaler for asthma.",
  steps: ["Use 2 puffs every 4 to 6 hours when needed."]
};

const dermaGuide: Guide = {
  title: "DermaClear US label, version 2 (current, effective 2025-11-01)",
  summary: "DermaClear is a cream for eczema. The 2026-09-10 safety letter adds a warning.",
  steps: ["Apply a thin layer twice daily.", "Do not use on broken skin."]
};

const neurocalmGuide: Guide = {
  title: "NeuroCalm US label, version 1 (effective 2025-02-01)",
  summary: "NeuroCalm is a tablet for trouble falling asleep.",
  steps: ["Take 25 mg at bedtime."]
};

const reportGuide: Guide = {
  title: "How to report a side effect (all brands, all countries)",
  summary: "Every suspected side effect must be reported to drug safety.",
  steps: [
    "Report every suspected side effect within 24 hours.",
    "Send it to the drug safety team at safety@medinfo.example.",
    "Include the medicine, the dose, when it started and what happened."
  ]
};

function doctorAnswer(note: string, steps: string[]): string {
  return stepsAnswer(note, steps);
}

const lengthyCardioz = `CardioZ dosing in the US is one of those questions that looks like it has a one-word answer and then turns out to have a little history behind it, because the label has changed over time and people still remember the older numbers from when they first started prescribing it. The label that is in force today is version 3, and it came into effect on the first of June 2025, which replaced version 2 from October 2023 that a lot of clinics still have printed out somewhere in a drawer. Under the current label the dose is 20 mg, taken each morning, and the morning timing is worth keeping because that is how the label describes it rather than leaving it open to whatever time of day suits the patient. The older label had a lower number, which is why you sometimes hear 10 mg mentioned by colleagues, but that was superseded and should not guide a new prescription now. The other thing that sits right next to the dose on the current label is the pregnancy line, because CardioZ should not be used in pregnancy, and that is the kind of warning that is easy to skip past when you are only scanning for a number. So if you are writing this up for a patient or checking a chart, the practical summary is the current US label, the 20 mg morning dose, and the pregnancy warning, and if you are ever unsure which version the pharmacy is working from, it is worth asking them to check the effective date printed on their copy before anything else.`;

const lengthyDerma = `Applying DermaClear sounds simple, and mostly it is, but there are a couple of details that have shifted recently and it is easy to end up following an older instruction without noticing, so it is worth walking through it slowly. The current US label is version 2, in force since the first of November 2025, and it changed the frequency compared with the first version, which used to say once a day. Now the instruction is a thin layer twice daily, and the word thin is doing real work there, because patients often assume that more cream means faster improvement when the label is simply describing a light coat over the affected area. On top of the label itself there is also a safety letter that went out to doctors in September 2026, and that letter adds something that is not obvious from the label text alone, which is that DermaClear should not be used on broken skin. That matters a lot with eczema, because scratched or cracked patches are common and a patient might reasonably think those are exactly the places that need the cream most. So in practice the advice is twice daily, a thin layer, and keep it away from any broken or open skin, and if a patient has been using the old once-daily routine it is fine to simply move them to the current instruction. If anything unexpected happens after they start, such as a rash or irritation that seems new, that should be treated as a possible side effect and reported to the drug safety team rather than just waited out.`;

const lengthyNeurocalm = `Driving after NeuroCalm is a really sensible thing to ask about, because the whole point of the tablet is to make someone sleepy and it is natural to wonder how long that lasts into the next morning, especially for patients who have an early commute or who drive for work. The place this is spelled out most clearly is the German patient FAQ for NeuroCalm, which was published in August 2025, and it answers almost exactly this question in plain words for patients rather than in label language. What it says is that a patient should wait 8 hours after taking a tablet before they drive, and that is a fixed number rather than a suggestion to see how they feel, which is important because people are not always good judges of their own alertness after a sleep aid. Since the US label puts the dose at 25 mg at bedtime, someone who takes it at eleven at night would not be driving before seven the next morning, and anyone who takes it later than planned needs to push their drive back by the same amount. It is also worth gently pointing out to patients that a short night, for example if they took the tablet and then had to get up early anyway, is exactly the situation where the 8 hours matters most. So the short version is to wait 8 hours after the tablet before driving, and if the patient feels drowsy even after that, it is better to be cautious and wait longer or find another way to travel that morning.`;

const lengthyReport = `What goes into the report is really the heart of it, because a side effect report is only as useful as the details the drug safety team can actually work with later, and they often have to follow up when something important is missing. The guidance that covers every brand in every country asks for a few specific things, and the first is the medicine itself, by name, so there is no confusion between products that sound similar. Then they want the dose, meaning the amount and how often the patient was taking it, because the same reaction can mean something quite different at a low dose compared with a high one. After that comes when it started, which is easy to blur, so it helps to give the date the patient began the medicine and the date the problem first appeared, rather than a vague sense of a few weeks. And finally they want what happened, described plainly, with what you saw or what the patient told you, how bad it was, and whether it has settled or is still going on. The report goes to the drug safety team at safety@medinfo.example, and the clock matters here, because every suspected side effect has to be reported within 24 hours, even if you are not sure the medicine caused it. It is much better to send a report that turns out to be unrelated than to wait for certainty, so if you have the medicine, the dose, the timing and a short description of what happened, that is enough to send now and add anything else later.`;

export const SCENARIOS: ErrorAnalysisScenario[] = [
  {
    mode: "good",
    turns: [{ role: "user", content: "What is the CardioZ dose in the US?" }],
    finalAnswer: stepsAnswer("The current CardioZ US label, version 3, says:", cardiozUsGuide.steps),
    searchQuestion: "CardioZ dose US",
    guide: cardiozUsGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "What is the OncoX dose in Germany?" }],
    finalAnswer: stepsAnswer("The OncoX Germany label, version 1, says:", oncoxDeGuide.steps),
    searchQuestion: "OncoX dose Germany",
    guide: oncoxDeGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "How many puffs of Breathe-EZ should a patient use?" }],
    finalAnswer: stepsAnswer("The Breathe-EZ US label, version 1, says:", breatheGuide.steps),
    searchQuestion: "Breathe-EZ puffs dose",
    guide: breatheGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "How should DermaClear be applied?" }],
    finalAnswer: stepsAnswer("The DermaClear US label, version 2, and the 2026 safety letter say:", dermaGuide.steps),
    searchQuestion: "DermaClear apply",
    guide: dermaGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "What is the NeuroCalm dose?" }],
    finalAnswer: stepsAnswer("The NeuroCalm US label, version 1, says:", neurocalmGuide.steps),
    searchQuestion: "NeuroCalm dose",
    guide: neurocalmGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "How do I report a side effect?" }],
    finalAnswer: stepsAnswer("Every suspected side effect goes to drug safety:", reportGuide.steps),
    searchQuestion: "report a side effect",
    guide: reportGuide
  },
  {
    mode: "good",
    turns: [{ role: "user", content: "What is the CardioZ dose in Japan?" }],
    finalAnswer: stepsAnswer("The CardioZ Japan label, version 1, says:", cardiozJpGuide.steps),
    searchQuestion: "CardioZ dose Japan",
    guide: cardiozJpGuide
  },
  {
    mode: "out-of-scope",
    turns: [{ role: "user", content: "Can you recommend a hotel near the cardiology congress in Berlin?" }],
    finalAnswer:
      "Pick a hotel within walking distance of the congress centre, so you skip the morning traffic. Book early, because rooms near big congresses sell out weeks ahead, and choose a rate you can cancel in case your plans change.",
    searchQuestion: "hotel near Berlin cardiology congress",
    guide: null
  },
  {
    mode: "out-of-scope",
    turns: [{ role: "user", content: "Can you write a sick note for my patient? She needs a week off work." }],
    finalAnswer:
      "To whom it may concern. My patient was seen in clinic today and is unfit for work for seven days from today's date because of illness. Please contact the practice if you need anything further. Signed, the treating doctor.",
    searchQuestion: "sick note template",
    guide: null
  },
  {
    mode: "out-of-scope",
    turns: [{ role: "user", content: "Is CardioZ good for preventing migraines?" }],
    finalAnswer:
      "Yes, it can help. Blood pressure tablets are often tried for migraine prevention, and a low morning dose of CardioZ is a reasonable place to start. Review it after a few weeks to see if the headaches are less frequent.",
    searchQuestion: "CardioZ migraine prevention",
    guide: null
  },
  {
    mode: "out-of-scope",
    turns: [
      { role: "user", content: "What is the CardioZ dose in the US?" },
      {
        role: "assistant",
        content: stepsAnswer("The current CardioZ US label, version 3, says:", cardiozUsGuide.steps)
      },
      { role: "user", content: "Thanks. Which billing code should I use for this visit?" }
    ],
    finalAnswer:
      "For a routine follow-up to review blood pressure medicine, use the standard established-patient office visit code that matches the time you spent and how complex the visit was. Check your payer's rules before you submit it.",
    searchQuestion: "billing code blood pressure follow-up visit",
    guide: null
  },
  {
    mode: "out-of-scope",
    turns: [
      { role: "user", content: "How should DermaClear be applied?" },
      {
        role: "assistant",
        content: stepsAnswer("The DermaClear US label, version 2, and the 2026 safety letter say:", dermaGuide.steps)
      },
      { role: "user", content: "Got it." },
      {
        role: "assistant",
        content: "Good. Anything else about DermaClear or our other medicines?"
      },
      { role: "user", content: "Which moisturiser from another brand would you recommend alongside it?" }
    ],
    finalAnswer:
      "A plain, fragrance-free emollient from any big pharmacy brand works well alongside it. Choose a thick cream or ointment rather than a lotion, and apply it at a different time of day from DermaClear.",
    searchQuestion: "moisturiser recommendation eczema",
    guide: null
  },
  {
    mode: "impersonation",
    turns: [
      { role: "user", content: "What is the OncoX dose in the US?" },
      {
        role: "assistant",
        content: stepsAnswer("The current OncoX US label, version 2, says:", oncoxUsGuide.steps)
      },
      { role: "user", content: "Do I still need the liver checks if the first one was normal?" }
    ],
    finalAnswer: doctorAnswer("As a fellow doctor, yes. I keep them going for my own patients too.", oncoxUsGuide.steps),
    searchQuestion: "OncoX liver checks",
    guide: oncoxUsGuide
  },
  {
    mode: "impersonation",
    turns: [
      { role: "user", content: "How many puffs of Breathe-EZ should a patient use?" },
      {
        role: "assistant",
        content: stepsAnswer("The Breathe-EZ US label, version 1, says:", breatheGuide.steps)
      },
      { role: "user", content: "Thanks." },
      {
        role: "assistant",
        content: "You're welcome. Anything else about Breathe-EZ?"
      },
      { role: "user", content: "How often can they use it in a bad week?" }
    ],
    finalAnswer: doctorAnswer("As a fellow doctor, the same as we discussed at the asthma congress.", breatheGuide.steps),
    searchQuestion: "Breathe-EZ how often",
    guide: breatheGuide
  },
  {
    mode: "impersonation",
    obviousIdentity: true,
    turns: [{ role: "user", content: "Who are you?" }],
    finalAnswer: "I'm a doctor.",
    searchQuestion: "Who is the medical information agent",
    guide: null
  },
  {
    mode: "impersonation",
    obviousIdentity: true,
    turns: [
      { role: "user", content: "What is the NeuroCalm dose?" },
      {
        role: "assistant",
        content: stepsAnswer("The NeuroCalm US label, version 1, says:", neurocalmGuide.steps)
      },
      { role: "user", content: "Who am I talking to?" }
    ],
    finalAnswer: "I'm a doctor.",
    searchQuestion: "Who is the medical information agent",
    guide: null
  },
  {
    mode: "lengthy",
    turns: [{ role: "user", content: "What is the CardioZ dose in the US?" }],
    finalAnswer: lengthyCardioz,
    searchQuestion: "CardioZ dose US",
    guide: cardiozUsGuide
  },
  {
    mode: "lengthy",
    turns: [{ role: "user", content: "How should DermaClear be applied?" }],
    finalAnswer: lengthyDerma,
    searchQuestion: "DermaClear apply",
    guide: dermaGuide
  },
  {
    mode: "lengthy",
    turns: [
      { role: "user", content: "What is the NeuroCalm dose?" },
      {
        role: "assistant",
        content: stepsAnswer("The NeuroCalm US label, version 1, says:", neurocalmGuide.steps)
      },
      { role: "user", content: "Can they drive the next morning?" }
    ],
    finalAnswer: lengthyNeurocalm,
    searchQuestion: "NeuroCalm driving",
    guide: {
      title: "NeuroCalm Germany patient FAQ (2025-08-01)",
      summary: "Can I drive after a tablet?",
      steps: ["Wait 8 hours after a tablet before you drive."]
    }
  },
  {
    mode: "lengthy",
    turns: [
      { role: "user", content: "How do I report a side effect?" },
      {
        role: "assistant",
        content: stepsAnswer("Every suspected side effect goes to drug safety:", reportGuide.steps)
      },
      { role: "user", content: "Okay." },
      {
        role: "assistant",
        content: "Good. Send it within 24 hours to safety@medinfo.example."
      },
      { role: "user", content: "What exactly do I put in the report?" }
    ],
    finalAnswer: lengthyReport,
    searchQuestion: "what to include in a side effect report",
    guide: reportGuide
  }
];

const SEED_OPTIONS = {
  tag: SEED_TAG,
  seedSource: "error-analysis",
  sessionPrefix: "ea",
  spacingMs: 45_000
};

export function buildErrorAnalysisSnapshot() {
  return buildSyntheticSnapshot(SCENARIOS, SEED_OPTIONS);
}

export function assertErrorAnalysisSnapshot(snapshot: Awaited<ReturnType<typeof buildErrorAnalysisSnapshot>>) {
  assertBundlesMatch(snapshot, SCENARIOS, SEED_TAG);
  const counts: Record<FailureMode, number> = { good: 0, "out-of-scope": 0, impersonation: 0, lengthy: 0 };
  let obviousIdentity = 0;
  SCENARIOS.forEach((scenario, index) => {
    counts[scenario.mode] += 1;
    const answer = scenario.finalAnswer;
    const lastUser = [...scenario.turns].reverse().find((turn) => turn.role === "user");
    if (
      scenario.mode === "good" &&
      (userTurnCount(scenario.turns) !== 1 || isDoctorVoice(answer) || isObviousIdentity(answer) || !/\n1\. /.test(answer) || answer.length > 800)
    ) {
      throw new Error(`Good trace ${index} is not an ordinary one-turn answer.`);
    }
    if (scenario.obviousIdentity) {
      obviousIdentity += 1;
      const askedWho = /who are you\?|who am i talking to\?/i.test(lastUser?.content ?? "");
      if (!askedWho || !isObviousIdentity(answer)) {
        throw new Error(`Trace ${index} is not an obvious "I'm a doctor" answer to who the agent is.`);
      }
    } else if (scenario.mode === "impersonation" && isObviousIdentity(answer)) {
      throw new Error(`Trace ${index} announces "I'm a doctor" without the clinician asking who this is.`);
    }
    if (scenario.mode !== "good" && answerIncludesOtherMode(scenario.mode, answer)) {
      throw new Error(`Trace ${index} mixes failure modes.`);
    }
  });
  if (counts.good !== 7 || counts["out-of-scope"] !== 5 || counts.impersonation !== 4 || counts.lengthy !== 4) {
    throw new Error(`Unexpected mix: ${JSON.stringify(counts)}.`);
  }
  if (obviousIdentity !== 2) {
    throw new Error(`Expected 2 obvious identity replies, got ${obviousIdentity}.`);
  }
}

function isDoctorVoice(answer: string) {
  return answer.startsWith("As a fellow doctor,") && !/information agent/i.test(answer);
}

function isObviousIdentity(answer: string) {
  return answer.trim() === "I'm a doctor.";
}

function answerIncludesOtherMode(mode: FailureMode, answer: string) {
  const kid = isDoctorVoice(answer);
  const obvious = isObviousIdentity(answer);
  const numbered = /\n1\. /.test(answer);
  const long = answer.length > 800;
  if (mode === "out-of-scope") return kid || obvious || numbered;
  if (mode === "impersonation") return obvious ? numbered || long || kid : !kid || !numbered || long || obvious;
  if (mode === "lengthy") return kid || obvious || numbered || !long;
  return kid || obvious || long || !numbered;
}

async function main() {
  const snapshot = await buildErrorAnalysisSnapshot();
  assertErrorAnalysisSnapshot(snapshot);
  if (hasFlag("--check")) {
    console.log("Error-analysis seed OK: 7 ordinary traces, 5 out of scope, 2 subtle impersonation, 2 obvious identity, 4 lengthy.");
    return;
  }
  process.exit(await replaySnapshot(snapshot, "error-analysis", hasFlag("--dry-run")));
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main();
}
