// Questions no lesson names, the kind a doctor asks once the scripted ones are done. Each needs a
// cited answer from the asker's own company, or the right refusal. npm run demo:open plays them
// (scripts/demo-turns.ts), and a live demo is ready only when 90 percent or more come back right.

const ANA = "ana.rivera@pharma-a.example.com";
const LUKAS = "lukas.weber@pharma-a.example.com";
const CHIDI = "chidi.okafor@pharma-b.example.com";
const YUI = "yui.tanaka@pharma-b.example.com";

const CARDIONEX_CITED = /\[cardionex-[\w-]+, [\d.]+\]/;
const NEUROVEX_CITED = /\[neurovex-[\w-]+, [\d.]+\]/;
const WITHHELD = /INSUFFICIENT_CONTEXT|ASK_FOLLOW_UP|OFF_LABEL_REFUSAL/;

const cited = (pattern: RegExp) => ({ tier: "answer", reply: pattern, notReply: WITHHELD });
const refused = { tier: "stop" };
const reported = { tier: "safety" };

export type OpenQuestion = { email: string; ask: string; expect: Record<string, unknown> };

export const OPEN_QUESTIONS: OpenQuestion[] = [
  { email: ANA, ask: "Can she take CardioNex with spironolactone?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "What happened to potassium in the CLARION-HF trial?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Is CardioNex approved in Japan for HFrEF?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "How long should a patient wait after stopping an ACE inhibitor before starting CardioNex?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Can CardioNex be used during pregnancy?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Is there a dose change for moderate liver impairment?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "What should I do about a missed dose of CardioNex?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "How should CardioNex tablets be stored?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Does rifampin change CardioNex levels?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "What does an overdose of CardioNex look like?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Is CardioNex covered by insurers without prior authorization?", expect: cited(CARDIONEX_CITED) },
  { email: ANA, ask: "Can I give CardioNex to a patient with HFpEF, LVEF 55 percent?", expect: refused },
  { email: ANA, ask: "My patient's lips swelled two days after starting CardioNex.", expect: reported },
  { email: LUKAS, ask: "What is the starting dose of CardioNex in Germany?", expect: cited(CARDIONEX_CITED) },
  { email: LUKAS, ask: "Which patients must not take CardioNex in Germany?", expect: cited(CARDIONEX_CITED) },
  { email: CHIDI, ask: "What is the starting dose of NeuroVex?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "How fast can the NeuroVex dose go up?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Does NeuroVex need a lower dose in kidney disease?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "What side effects were seen in the NeuroVex trial?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Did NeuroVex reduce pain scores in the trial?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Can NeuroVex be taken with opioids?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Is NeuroVex safe in pregnancy?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "How should NeuroVex be stopped?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Can older patients take the full NeuroVex dose?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "What is NeuroVex approved for?", expect: cited(NEUROVEX_CITED) },
  { email: CHIDI, ask: "Can I use NeuroVex for migraine?", expect: refused },
  { email: CHIDI, ask: "A patient fainted the day after a NeuroVex dose increase.", expect: reported },
  { email: CHIDI, ask: "What is the dose of CardioNex in kidney disease?", expect: { notReply: CARDIONEX_CITED } },
  { email: YUI, ask: "Is NeuroVex approved in Japan?", expect: cited(NEUROVEX_CITED) },
  { email: YUI, ask: "What is the NeuroVex dose in Japan?", expect: cited(NEUROVEX_CITED) }
];
