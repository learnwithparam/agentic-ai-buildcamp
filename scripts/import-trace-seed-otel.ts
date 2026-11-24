/**
 * OTel-based trace seed importer.
 *
 * Unlike scripts/import-trace-seed.ts (which uses the public batch ingestion REST
 * API and can therefore only ever create SPAN/GENERATION/EVENT observations), this
 * importer replays each snapshot trace through the Langfuse OpenTelemetry SDK. That
 * is the only ingestion path that preserves the richer observation types: AGENT,
 * TOOL, CHAIN, RETRIEVER, EVALUATOR, GUARDRAIL, and EMBEDDING, exactly as the live agent
 * emits them and as the export captured them.
 *
 * How it works per trace bundle:
 *   1. propagateAttributes(...) sets trace-level attrs (name, sessionId, userId, tags,
 *      version, metadata) on every span created inside the callback.
 *   2. Observations are created parent-first via startObservation(name, attrs, {asType,
 *      startTime, parentSpanContext}). The first (root) observation starts a fresh OTel
 *      trace; every other observation is attached to its parent's captured span context,
 *      so the whole tree lands in one trace. Timestamps are backdated via startTime/end().
 *   3. The root sets trace input/output via setTraceIO(...).
 *   4. OTel-generated trace/observation IDs are captured so scores (which have no OTel
 *      path) can be re-pointed and sent via the REST score-create batch afterwards.
 *
 * All timestamps are shifted uniformly so the newest seeded event lands more than
 * 5 minutes before now, preserving the original spread. Topics only picks up a
 * trace after its last activity is outside that window.
 *
 * On top of the exported file, this script also synthesises a handful of edge-case
 * turns that the calm, in-scope export is missing: out-of-scope asks, ALL-CAPS
 * rages, and more "where is that?" follow-ups, so the monitoring evaluators
 * ("Out of scope request", "user_all_caps_signal", "User Disagreement") have real
 * positive cases to fire on. They are built by cloning a real bundle as a template
 * and swapping in the new wording, so their observation tree, token usage/cost, and
 * score shape match genuine traffic exactly. Pass --no-edge-cases to seed only the
 * file. See the EDGE-CASE TRAFFIC section below.
 *
 * NOT idempotent: OpenTelemetry generates fresh trace/span ids on every run, so each
 * invocation creates a brand-new set of traces (re-running doubles the data). This is
 * the inherent tradeoff of the OTel path vs the REST importer, which pins ids and can
 * be re-run safely. Run once, or clean up prior seed traces before re-running.
 *
 * Usage:
 *   npm run langfuse:seed:otel -- --input data/seed-traffic-followups-traces.json
 *   npm run langfuse:seed:otel -- --input <file> --limit 10
 *   npm run langfuse:seed:otel -- --input <file> --dry-run
 *   npm run langfuse:seed:otel -- --no-scores       (replay traces + observations only)
 *   npm run langfuse:seed:otel -- --no-edge-cases   (seed only the exported file)
 */
import "../src/server/load-env";

// Stamp the same environment the REST importer uses ("production" by default) before
// the span processor is constructed, so seeded spans carry the expected environment.
const SEED_ENVIRONMENT = process.env.LANGFUSE_SEED_ENVIRONMENT || "production";
process.env.LANGFUSE_TRACING_ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || SEED_ENVIRONMENT;

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import {
  propagateAttributes,
  startObservation,
  type LangfuseObservation,
  type LangfuseObservationType,
  type ObservationLevel
} from "@langfuse/tracing";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../src/server/env";
import {
  TraceSeedObservation,
  TraceSeedScore,
  TraceSeedSnapshot,
  TraceSeedTraceBundle,
  chunkIngestionBatch,
  hasFlag,
  orderObservationsParentFirst,
  readNumberFlag,
  readStringFlag,
  readTraceSeedSnapshot
} from "./langfuse-trace-seed-lib";

type SpanCtx = ReturnType<LangfuseObservation["otelSpan"]["spanContext"]>;
type ScoreEvent = Parameters<LangfuseClient["api"]["scores"]["create"]>[0][number];

// startObservation has per-asType overloads; we drive asType dynamically from the
// snapshot, so wrap it in a single loose signature to keep the call site simple.
const startObs = startObservation as unknown as (
  name: string,
  attributes: Record<string, unknown>,
  options: { asType?: LangfuseObservationType; startTime?: Date; parentSpanContext?: SpanCtx }
) => LangfuseObservation;

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });

// ===========================================================================
// EDGE-CASE TRAFFIC
//
// The exported file is mostly calm, in-scope label questions, so three monitoring
// evaluators never see a positive. We synthesise a handful of out-of-scope asks,
// ALL-CAPS rages, and "where is that?" follow-ups by cloning a real bundle and
// swapping in new wording. Cloning keeps the full AGENT -> 3x GENERATION ->
// 2x TOOL tree, token usage/cost, key ordering, and score shape identical to a
// genuine export. Each turn also gets the four boolean scores with the correct
// values so dashboards light up (the --no-scores path still re-scores live).
// ===========================================================================

// CardioZ US dose single turn, and the DermaClear label follow-up turn. Both are
// stable ids from data/seed-traffic-followups-traces.json.
const SINGLE_TURN_TEMPLATE_ID = "012ac64622bfcbbbd9bc7170961555be";
const FOLLOW_UP_TEMPLATE_ID = "20e8d27315a17811b3818a7a330ecf25";
const EDGE_CASE_TAG = "seed-edge-case";

type EdgeScoreValues = {
  outOfScope: 0 | 1;
  allCaps: 0 | 1;
  disagreement: 0 | 1;
  followUp: 0 | 1;
};

type EdgeCase = {
  category: "out-of-scope" | "all-caps" | "follow-up";
  template: "single" | "follow-up";
  question: string; // first user message
  answer?: string; // first assistant answer (follow-up templates only)
  followUp?: string; // follow-up user message (follow-up templates only)
  finalAnswer: string; // assistant answer that becomes trace.output.answer
  searchQuery: string; // search_help_library query
  scores: EdgeScoreValues;
  comments: { outOfScope: string; allCaps: string; disagreement: string; followUp: string };
};

const NO_PRIOR_TURN_DISAGREEMENT =
  "There is no prior assistant response in the conversation history to evaluate disagreement against; the latest message is the user's first turn, so the score is false.";
const FRESH_TURN_FOLLOW_UP =
  "The latest message is a standalone first question, not a follow-up that depends on a prior exchange.";

const EDGE_CASES: EdgeCase[] = [
  // --- Out-of-scope asks (in-scope = false) ---------------------------------
  {
    category: "out-of-scope",
    template: "single",
    question: "Can you write the prescription for my patient so I can print it?",
    finalAnswer:
      "I'm sorry, I can't write prescriptions. I only answer questions about our medicines from their approved labels.\n\nIf it helps, I can tell you the dose on the current label for the medicine and country you are prescribing for. Which medicine is it?",
    searchQuery: "write a prescription for a patient",
    scores: { outOfScope: 1, allCaps: 0, disagreement: 0, followUp: 0 },
    comments: {
      outOfScope:
        "The clinician is asking the assistant to write a prescription. This assistant only answers label questions about the company's medicines, so writing prescriptions is outside its scope.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement: NO_PRIOR_TURN_DISAGREEMENT,
      followUp: FRESH_TURN_FOLLOW_UP
    }
  },
  {
    category: "out-of-scope",
    template: "single",
    question: "Which statin from another company works best with CardioZ?",
    finalAnswer:
      "I'm sorry, I can't compare or recommend other companies' medicines. I can only answer from the labels of our own medicines.\n\nThe current CardioZ US label does not list any combination advice. For questions about another company's product, please contact that company's medical information team.",
    searchQuery: "statin combination with CardioZ",
    scores: { outOfScope: 1, allCaps: 0, disagreement: 0, followUp: 0 },
    comments: {
      outOfScope:
        "The clinician is asking for a recommendation about another company's medicine. The assistant only covers the company's own labels, so this is outside its scope.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement: NO_PRIOR_TURN_DISAGREEMENT,
      followUp: FRESH_TURN_FOLLOW_UP
    }
  },
  {
    category: "out-of-scope",
    template: "single",
    question: "Can you book me a seat at the oncology congress in Vienna?",
    finalAnswer:
      "I'm sorry, I can't book events. I only answer questions about our medicines from their approved labels.\n\nIf you have a question about OncoX or another of our medicines, I'm happy to help with that.",
    searchQuery: "book a seat at the oncology congress",
    scores: { outOfScope: 1, allCaps: 0, disagreement: 0, followUp: 0 },
    comments: {
      outOfScope:
        "The clinician is asking the assistant to book a congress seat. Event booking is outside the scope of a medical information desk.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement: NO_PRIOR_TURN_DISAGREEMENT,
      followUp: FRESH_TURN_FOLLOW_UP
    }
  },
  // --- ALL-CAPS frustration -------------------------------------------------
  {
    category: "all-caps",
    template: "single",
    question: "I NEED THE ONCOX DOSE IN GERMANY RIGHT NOW, THE PATIENT IS WAITING",
    finalAnswer:
      "Understood. Here is the OncoX Germany label, version 1:\n\n1. Take 100 mg once daily with food.\n\nIn Germany only the 100 mg tablet is approved.",
    searchQuery: "OncoX dose Germany",
    scores: { outOfScope: 0, allCaps: 1, disagreement: 0, followUp: 0 },
    comments: {
      outOfScope: "The clinician is asking for the OncoX dose in Germany, which is within the assistant's scope.",
      allCaps: "Detected an all-caps run longer than 5 letters.",
      disagreement: NO_PRIOR_TURN_DISAGREEMENT,
      followUp: FRESH_TURN_FOLLOW_UP
    }
  },
  {
    category: "all-caps",
    template: "single",
    question: "WHERE DO I REPORT A SIDE EFFECT, I CANNOT FIND IT ANYWHERE",
    finalAnswer:
      "Sorry it was hard to find. Here is how to report it:\n\n1. Report every suspected side effect within 24 hours.\n2. Send it to the drug safety team at safety@medinfo.example.\n3. Include the medicine, the dose, when it started and what happened.",
    searchQuery: "report a side effect",
    scores: { outOfScope: 0, allCaps: 1, disagreement: 0, followUp: 0 },
    comments: {
      outOfScope: "The clinician is asking how to report a side effect, which is within the assistant's scope.",
      allCaps: "Detected an all-caps run longer than 5 letters.",
      disagreement: NO_PRIOR_TURN_DISAGREEMENT,
      followUp: FRESH_TURN_FOLLOW_UP
    }
  },
  {
    // ALL-CAPS frustration that is also a disagreement after a prior answer.
    category: "all-caps",
    template: "follow-up",
    question: "What is the CardioZ dose in the US?",
    answer: "The current CardioZ US label, version 3, says:\n\n1. Take 20 mg each morning.\n2. Do not use in pregnancy.",
    followUp: "THAT IS WRONG, OUR PHARMACY STILL GIVES 10 MG",
    finalAnswer:
      "I understand the confusion. The 10 mg dose came from the older version 2 label, which was replaced.\n\n1. The current CardioZ US label is version 3, effective 2025-06-01.\n2. It says to take 20 mg each morning.\n\nPlease ask the pharmacy to check the effective date on their copy of the label.",
    searchQuery: "CardioZ US label version 2 10 mg",
    scores: { outOfScope: 0, allCaps: 1, disagreement: 1, followUp: 1 },
    comments: {
      outOfScope: "The clinician is still asking about the CardioZ US dose, which is within the assistant's scope.",
      allCaps: "Detected an all-caps run longer than 5 letters.",
      disagreement:
        "The clinician says the previous answer is wrong (\"THAT IS WRONG\"). This is an explicit signal that they do not accept the prior answer.",
      followUp:
        "The message refers back to the previous dose (\"THAT\") and cannot be understood without it, so it is a follow-up."
    }
  },
  // --- "Where is that?" follow-ups ------------------------------------------
  {
    category: "follow-up",
    template: "follow-up",
    question: "How should DermaClear be applied?",
    answer: "The DermaClear US label, version 2, and the 2026 safety letter say:\n\n1. Apply a thin layer twice daily.\n2. Do not use on broken skin.",
    followUp: "Sorry, which document says not on broken skin?",
    finalAnswer:
      "That line comes from the safety letter, not the label itself.\n\n1. The DermaClear safety letter of 2026-09-10 adds: do not use on broken skin.\n2. The DermaClear US label, version 2, gives the twice daily dose.",
    searchQuery: "DermaClear safety letter broken skin",
    scores: { outOfScope: 0, allCaps: 0, disagreement: 1, followUp: 1 },
    comments: {
      outOfScope: "The clinician is still asking about DermaClear, which is within the assistant's scope.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement:
        "The clinician asks which document a line came from, with \"Sorry\", signalling the prior answer did not make its source clear.",
      followUp:
        "The message refers to a line in the previous answer, so it is a follow-up rather than a standalone question."
    }
  },
  {
    category: "follow-up",
    template: "follow-up",
    question: "How long should patients wait to drive after NeuroCalm?",
    answer: "The NeuroCalm Germany patient FAQ says:\n\n1. Wait 8 hours after a tablet before you drive.",
    followUp: "And is that on the US label too?",
    finalAnswer:
      "The 8 hour wait comes from the NeuroCalm Germany patient FAQ, not the US label.\n\n1. The NeuroCalm US label, version 1, says: take 25 mg at bedtime.",
    searchQuery: "NeuroCalm US label driving",
    scores: { outOfScope: 0, allCaps: 0, disagreement: 0, followUp: 1 },
    comments: {
      outOfScope: "The clinician is still asking about NeuroCalm, which is within the assistant's scope.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement:
        "The clinician asks a neutral clarifying question and does not express dissatisfaction with the prior answer.",
      followUp:
        "\"that\" refers to the driving wait in the previous answer, so the message is a follow-up."
    }
  },
  {
    category: "follow-up",
    template: "follow-up",
    question: "How many puffs of Breathe-EZ per dose?",
    answer: "The Breathe-EZ US label, version 1, says:\n\n1. Use 2 puffs every 4 to 6 hours when needed.",
    followUp: "Okay, and how often is that in a day?",
    finalAnswer:
      "The Breathe-EZ US label, version 1, gives the spacing, not a daily total:\n\n1. Use 2 puffs every 4 to 6 hours when needed.",
    searchQuery: "Breathe-EZ how often per day",
    scores: { outOfScope: 0, allCaps: 0, disagreement: 0, followUp: 1 },
    comments: {
      outOfScope: "The clinician is still asking about Breathe-EZ dosing, which is within the assistant's scope.",
      allCaps: "No all-caps run longer than 5 letters detected.",
      disagreement:
        "The clinician asks a neutral clarifying question and does not express dissatisfaction with the prior answer.",
      followUp:
        "\"that\" refers to the dose in the previous answer, so the message is a follow-up."
    }
  }
];

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// Collision-checked hex ids in the same style as the export.
function makeEdgeHexFactory(used: Set<string>) {
  let counter = 0;
  return (length: number) => {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const digest = createHash("sha256")
        .update(`edge-case-seed:${counter}:${attempt}`)
        .digest("hex")
        .slice(0, length);
      counter += 1;
      if (!used.has(digest)) {
        used.add(digest);
        return digest;
      }
    }
    throw new Error("Could not allocate a unique hex id for an edge-case seed.");
  };
}

// Deep-walk every string leaf: ISO timestamps shift by offsetMs; other strings go
// through a two-phase replacement (old -> sentinel -> new) so swaps never cascade.
function transformEdgeStrings(
  value: unknown,
  offsetMs: number,
  swaps: Array<{ from: string; token: string; to: string }>
): unknown {
  if (typeof value === "string") {
    if (ISO_TIMESTAMP_RE.test(value)) {
      return new Date(Date.parse(value) + offsetMs).toISOString();
    }
    let next = value;
    for (const { from, token } of swaps) {
      if (from) next = next.split(from).join(token);
    }
    for (const { token, to } of swaps) {
      next = next.split(token).join(to);
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformEdgeStrings(item, offsetMs, swaps));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key] = transformEdgeStrings(raw, offsetMs, swaps);
    }
    return out;
  }
  return value;
}

// Longest run of consecutive A–Z letters: mirrors the all-caps code evaluator.
function longestUpperRun(text: string) {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char >= "A" && char <= "Z") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function edgeTemplateSearchQuery(bundle: TraceSeedTraceBundle) {
  const tool = bundle.observations.find(
    (obs) => obs.type === "TOOL" && obs.name === "search_help_library"
  );
  const input = tool?.input as { question?: string } | undefined;
  if (!input?.question) throw new Error("Template search_help_library tool has no question.");
  return input.question;
}

function edgeRootAgentId(bundle: TraceSeedTraceBundle) {
  const root = bundle.observations.find((obs) => obs.type === "AGENT");
  if (!root) throw new Error("Template bundle has no AGENT root observation.");
  return root.id;
}

function buildEdgeScores(
  edge: EdgeCase,
  newTraceId: string,
  newRootId: string,
  timestamp: string,
  latestUserText: string,
  hex: (length: number) => string
): TraceSeedScore[] {
  const score = (
    name: string,
    value: 0 | 1,
    comment: string,
    extraMetadata: Record<string, unknown> = {}
  ): TraceSeedScore => ({
    id: hex(32),
    traceId: newTraceId,
    observationId: newRootId,
    name,
    value,
    timestamp,
    comment,
    dataType: "BOOLEAN",
    environment: "default",
    metadata: {
      job_configuration_id: "[id]",
      job_execution_id: hex(32),
      target_observation_id: newRootId,
      target_trace_id: newTraceId,
      ...extraMetadata
    }
  });

  return [
    score("user_all_caps_signal", edge.scores.allCaps, edge.comments.allCaps, {
      code_eval_runtime: "PYTHON",
      dispatcher_name: "aws-lambda",
      longest_run: longestUpperRun(latestUserText),
      text: latestUserText
    }),
    score("User Disagreement", edge.scores.disagreement, edge.comments.disagreement),
    score("asks_follow_up", edge.scores.followUp, edge.comments.followUp),
    score("Out of scope request", edge.scores.outOfScope, edge.comments.outOfScope)
  ];
}

// Clone a template bundle and swap in this edge case's wording, fresh ids, and scores.
function buildEdgeBundle(
  edge: EdgeCase,
  templates: { single: TraceSeedTraceBundle; followUp: TraceSeedTraceBundle },
  index: number,
  hex: (length: number) => string
): TraceSeedTraceBundle {
  const template = edge.template === "single" ? templates.single : templates.followUp;
  const clone = JSON.parse(JSON.stringify(template)) as TraceSeedTraceBundle;

  // Spread the new turns a few minutes past the rest of the window so they are the
  // most recent traffic; computeTimestampOffsetMs later lands the newest more than
  // 5 minutes before now.
  const offsetMs = (index + 1) * 60_000;

  const swaps: Array<{ from: string; token: string; to: string }> = [];
  const swap = (from: string, to: string) =>
    swaps.push({ from, token: ` EDGE${swaps.length} `, to });

  const templateInput = template.trace.input as { messages: Array<{ role: string; content: string }> };
  const messages = templateInput.messages;
  const templateAnswer = (template.trace.output as { answer: string }).answer;
  swap(messages[0].content, edge.question);
  swap(edgeTemplateSearchQuery(template), edge.searchQuery);
  swap(templateAnswer, edge.finalAnswer);
  if (edge.template === "follow-up") {
    if (!edge.answer || !edge.followUp) {
      throw new Error(`Follow-up edge case "${edge.question}" is missing answer/followUp.`);
    }
    swap(messages[1].content, edge.answer);
    swap(messages[2].content, edge.followUp);
  }

  // Allocate fresh structural ids (kept out of the free-text string transform).
  const newTraceId = hex(32);
  const newSessionId = `seed-session-${hex(12)}`;
  const newUserId = `seed-user-${hex(12)}`;
  const obsIdMap = new Map<string, string>();
  for (const obs of clone.observations) obsIdMap.set(obs.id, hex(16));

  if (template.trace.sessionId) swap(template.trace.sessionId, newSessionId);
  if (template.trace.userId) swap(template.trace.userId, newUserId);
  swap(template.trace.id, newTraceId);

  const bundle = transformEdgeStrings(clone, offsetMs, swaps) as TraceSeedTraceBundle;

  bundle.trace.id = newTraceId;
  bundle.trace.sessionId = newSessionId;
  bundle.trace.userId = newUserId;
  for (const obs of bundle.observations) {
    obs.traceId = newTraceId;
    obs.id = obsIdMap.get(obs.id) ?? obs.id;
    obs.parentObservationId = obs.parentObservationId
      ? obsIdMap.get(obs.parentObservationId) ?? obs.parentObservationId
      : null;
  }

  // Mark + tag for filtering in Langfuse.
  const metadata = (bundle.trace.metadata ?? {}) as Record<string, unknown>;
  metadata.seedEdgeCase = edge.category;
  bundle.trace.metadata = metadata as TraceSeedTraceBundle["trace"]["metadata"];
  if (!bundle.trace.tags.includes(EDGE_CASE_TAG)) {
    bundle.trace.tags = [...bundle.trace.tags, EDGE_CASE_TAG];
  }

  const newRootId = obsIdMap.get(edgeRootAgentId(template)) ?? edgeRootAgentId(template);
  const latestUserText = edge.template === "follow-up" ? (edge.followUp as string) : edge.question;
  const scoreTimestamp = new Date(
    Date.parse(template.trace.timestamp) + offsetMs + 8_000
  ).toISOString();
  bundle.scores = buildEdgeScores(edge, newTraceId, newRootId, scoreTimestamp, latestUserText, hex);

  return bundle;
}

// Synthesise the full set of edge-case bundles from templates in the snapshot.
function buildEdgeCaseBundles(snapshot: TraceSeedSnapshot): TraceSeedTraceBundle[] {
  const findTemplate = (id: string) => {
    const bundle = snapshot.traces.find((entry) => entry.trace.id === id);
    if (!bundle) {
      throw new Error(
        `Edge-case template ${id} not found in the snapshot. Pass --no-edge-cases to seed only the file, ` +
          `or point --input at data/seed-traffic-followups-traces.json.`
      );
    }
    return bundle;
  };
  const templates = {
    single: findTemplate(SINGLE_TURN_TEMPLATE_ID),
    followUp: findTemplate(FOLLOW_UP_TEMPLATE_ID)
  };

  // Collision-proof new ids against every id already in the file.
  const used = new Set<string>();
  for (const bundle of snapshot.traces) {
    used.add(bundle.trace.id);
    for (const obs of bundle.observations) used.add(obs.id);
    for (const score of bundle.scores) used.add(score.id);
  }
  const hex = makeEdgeHexFactory(used);

  return EDGE_CASES.map((edge, index) => buildEdgeBundle(edge, templates, index, hex));
}

async function main() {
  const inputPath = readStringFlag("--input");
  if (!inputPath) throw new Error("Pass --input <traces.json>. The seed scripts pass it for you.");
  const limit = readNumberFlag("--limit");
  const dryRun = hasFlag("--dry-run");
  const includeScores = !hasFlag("--no-scores");
  const includeEdgeCases = !hasFlag("--no-edge-cases");

  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required to seed traces.");
  }

  const snapshot = await readTraceSeedSnapshot(inputPath);
  validateSnapshot(snapshot, inputPath);

  const fileBundles = typeof limit === "number" ? snapshot.traces.slice(0, limit) : snapshot.traces;
  // Synthesised edge cases are always appended in full (never sliced by --limit) so the
  // monitoring evaluators get their positive cases regardless of how much file traffic is seeded.
  const edgeCaseBundles = includeEdgeCases ? buildEdgeCaseBundles(snapshot) : [];
  const bundles = [...fileBundles, ...edgeCaseBundles];

  const combined: TraceSeedSnapshot = { ...snapshot, traces: bundles };
  const nowMs = Date.now();
  const offsetMs = computeTimestampOffsetMs(combined, nowMs);
  logTimestampShift(combined, offsetMs, nowMs);

  const totalObservations = bundles.reduce((sum, b) => sum + b.observations.length, 0);
  const totalScores = includeScores ? bundles.reduce((sum, b) => sum + b.scores.length, 0) : 0;
  const typeCounts = countObservationTypes(bundles);
  console.log(
    `Replaying ${bundles.length} traces via OTel ` +
      `(${totalObservations} observations, ${includeScores ? `${totalScores} scores` : "scores skipped"}) into ${env.langfuseBaseUrl}.`
  );
  if (includeEdgeCases) {
    const byCategory = edgeCaseBundles.reduce<Record<string, number>>((acc, b) => {
      const category = String((b.trace.metadata as Record<string, unknown>).seedEdgeCase);
      acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `  includes ${edgeCaseBundles.length} synthesised edge-case turns (${Object.entries(byCategory)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}). Pass --no-edge-cases to skip.`
    );
  }
  console.log(`Observation types preserved: ${formatTypeCounts(typeCounts)}.`);

  if (dryRun) {
    console.log("Dry run only. No spans or scores were sent.");
    return;
  }

  sdk.start();

  const scoreEvents: ScoreEvent[] = [];
  for (const [index, bundle] of bundles.entries()) {
    const { realTraceId, realObservationIds } = await replayTrace(bundle, offsetMs);
    if (includeScores) {
      for (const score of bundle.scores) {
        scoreEvents.push(buildScoreEvent(score, offsetMs, realTraceId, realObservationIds));
      }
    }
    console.log(`  [${index + 1}/${bundles.length}] ${bundle.trace.name ?? "trace"} (${bundle.observations.length} obs) ✓`);
  }

  // Flush spans first so the traces exist before their scores reference them.
  await langfuseSpanProcessor.forceFlush();
  if (includeScores) {
    await sendScores(scoreEvents);
  }
  await sdk.shutdown();

  console.log(
    `Done. Seeded ${bundles.length} traces, ${totalObservations} observations, ` +
      `${includeScores ? `${scoreEvents.length} scores` : "0 scores (skipped)"}.`
  );
}

// Replays a single trace bundle through OTel, returning the real (OTel-generated)
// trace id and a snapshot-observation-id -> real-observation-id map for scores.
async function replayTrace(bundle: TraceSeedTraceBundle, offsetMs: number) {
  const { trace } = bundle;
  const ordered = orderObservationsParentFirst(bundle.observations);

  const spanCtxBySnapshotId = new Map<string, SpanCtx>();
  const realObservationIds = new Map<string, string>();
  let realTraceId = "";

  await propagateAttributes(
    {
      traceName: trace.name ?? undefined,
      sessionId: trace.sessionId ?? undefined,
      userId: trace.userId ?? undefined,
      tags: trace.tags.length > 0 ? trace.tags : undefined,
      version: trace.version ?? undefined,
      metadata: toStringMetadata(trace.metadata)
    },
    async () => {
      let rootCtx: SpanCtx | undefined;

      for (const observation of ordered) {
        const startTime = new Date(Date.parse(observation.startTime) + offsetMs);
        const endTime = observation.endTime
          ? new Date(Date.parse(observation.endTime) + offsetMs)
          : startTime;

        // Parent-first ordering guarantees the parent already exists. Anything whose
        // parent can't be resolved (orphan / extra root) is attached to the first root
        // so the bundle stays a single trace instead of fragmenting.
        const explicitParent = observation.parentObservationId
          ? spanCtxBySnapshotId.get(observation.parentObservationId)
          : undefined;
        const parentSpanContext = explicitParent ?? rootCtx;

        const created = startObs(observation.name ?? "observation", buildAttributes(observation, offsetMs), {
          asType: toAsType(observation.type),
          startTime,
          parentSpanContext
        });

        const spanContext = created.otelSpan.spanContext();
        spanCtxBySnapshotId.set(observation.id, spanContext);
        realObservationIds.set(observation.id, created.id);

        if (!rootCtx) {
          rootCtx = spanContext;
          // The trace shows its root observation's input and output, which the
          // snapshot already carries.
          realTraceId = created.traceId;
        }

        created.end(endTime);
      }
    }
  );

  return { realTraceId, realObservationIds };
}

function buildAttributes(observation: TraceSeedObservation, offsetMs: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    input: observation.input,
    output: observation.output,
    metadata: buildObservationMetadata(observation.metadata),
    level: (observation.level as ObservationLevel) ?? "DEFAULT",
    environment: SEED_ENVIRONMENT,
    version: observation.version ?? undefined,
    statusMessage: observation.statusMessage ?? undefined
  };

  if (observation.type === "GENERATION" || observation.type === "EMBEDDING") {
    return {
      ...base,
      model: observation.model ?? undefined,
      modelParameters: observation.modelParameters as Record<string, string | number> | undefined,
      usageDetails: observation.usageDetails,
      costDetails: observation.costDetails,
      completionStartTime: observation.completionStartTime
        ? new Date(Date.parse(observation.completionStartTime) + offsetMs)
        : undefined,
      prompt: observation.prompt
        ? { name: observation.prompt.name, version: observation.prompt.version }
        : undefined
    };
  }

  return base;
}

function buildScoreEvent(
  score: TraceSeedScore,
  offsetMs: number,
  realTraceId: string,
  realObservationIds: Map<string, string>
): ScoreEvent {
  const timestamp = new Date(Date.parse(score.timestamp) + offsetMs).toISOString();
  const observationId = score.observationId ? realObservationIds.get(score.observationId) : undefined;

  return {
    // Fresh id, not the snapshot's score id: OTel replay generates new trace ids
    // each run, and scores are upserted by id. Reusing a snapshot score id that a
    // previous import already created would upsert the OLD score (leaving it pointed
    // at the old trace) instead of attaching a score to this run's new trace.
    id: randomUUID(),
    traceId: realTraceId,
    observationId: observationId ?? undefined,
    name: score.name,
    // value is number for NUMERIC/BOOLEAN, string for CATEGORICAL/TEXT/CORRECTION.
    value: score.value as never,
    comment: score.comment ?? undefined,
    metadata: score.metadata,
    dataType: score.dataType,
    environment: SEED_ENVIRONMENT,
    timestamp
  } as ScoreEvent;
}

async function sendScores(scoreEvents: ScoreEvent[]) {
  if (scoreEvents.length === 0) return;

  const client = new LangfuseClient({
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl
  });

  const batches = chunkIngestionBatch(scoreEvents);
  for (const [index, batch] of batches.entries()) {
    console.log(`Sending score batch ${index + 1}/${batches.length} (${batch.length} scores)...`);
    const response = await client.api.scores.create(batch);
    if ("rejected" in response && response.rejected > 0) {
      const details = response.errors.map((error) => `- ${JSON.stringify(error)}`).join("\n");
      throw new Error(`Score import failed: Langfuse rejected ${response.rejected} scores:\n${details}`);
    }
  }
}

// Snapshot stores types uppercase (AGENT/TOOL/...); the SDK asType option is lowercase.
function toAsType(type: string): LangfuseObservationType {
  return type.toLowerCase() as LangfuseObservationType;
}

// Observation metadata accepts arbitrary values; tag the seed source for traceability.
function buildObservationMetadata(metadata: unknown): Record<string, unknown> {
  const marker = { langfuseSeedSource: "otel-import" };
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>), ...marker };
  }
  if (metadata === undefined || metadata === null) {
    return marker;
  }
  return { value: metadata, ...marker };
}

// Trace-level metadata via propagateAttributes only accepts string values <=200 chars.
function toStringMetadata(metadata: unknown): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const asString = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = asString.length > 200 ? asString.slice(0, 200) : asString;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function countObservationTypes(bundles: TraceSeedTraceBundle[]) {
  const counts: Record<string, number> = {};
  for (const bundle of bundles) {
    for (const observation of bundle.observations) {
      counts[observation.type] = (counts[observation.type] ?? 0) + 1;
    }
  }
  return counts;
}

function formatTypeCounts(counts: Record<string, number>) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} x${count}`)
    .join(", ");
}

// Topics waits about 5 minutes after a trace's last activity before it can use it.
// Land the newest seeded event strictly outside that window.
const NEWEST_EVENT_LAG_MS = 6 * 60_000;

// Uniformly shifts every seeded timestamp so the most recent lands
// NEWEST_EVENT_LAG_MS before `nowMs`, preserving the original spread and each
// trace's internal timing.
function computeTimestampOffsetMs(snapshot: TraceSeedSnapshot, nowMs: number) {
  const latestMs = newestTimestampMs(snapshot);
  return Number.isFinite(latestMs) ? nowMs - NEWEST_EVENT_LAG_MS - latestMs : 0;
}

function newestTimestampMs(snapshot: TraceSeedSnapshot) {
  let latestMs = Number.NEGATIVE_INFINITY;

  const consider = (value: string | null | undefined) => {
    if (!value) return;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latestMs) latestMs = parsed;
  };

  for (const bundle of snapshot.traces) {
    consider(bundle.trace.timestamp);
    for (const observation of bundle.observations) {
      consider(observation.startTime);
      consider(observation.endTime);
      consider(observation.completionStartTime);
    }
    for (const score of bundle.scores) {
      consider(score.timestamp);
    }
  }

  return latestMs;
}

function logTimestampShift(snapshot: TraceSeedSnapshot, offsetMs: number, nowMs: number) {
  const days = (offsetMs / (1000 * 60 * 60 * 24)).toFixed(1);
  const newestMs = newestTimestampMs(snapshot) + offsetMs;
  const ageMinutes = (nowMs - newestMs) / 60_000;
  if (!(ageMinutes > 5)) {
    throw new Error(`Newest seeded event is only ${ageMinutes.toFixed(2)} minutes before now.`);
  }
  console.log(
    `Shifting all timestamps forward by ${days} day(s) so the newest of ${snapshot.traces.length} traces lands ${ageMinutes.toFixed(1)} minutes before now.`
  );
}

function validateSnapshot(snapshot: TraceSeedSnapshot, inputPath: string) {
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported snapshot schema version ${snapshot.schemaVersion} in ${inputPath}.`);
  }
  if (!Array.isArray(snapshot.traces)) {
    throw new Error(`Snapshot ${inputPath} has no traces array.`);
  }
}

void main();
