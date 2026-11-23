// Module 04: the agent answers only from active documents, and its claim is checked.
import { HCP_GOLDEN, HCP_LAB_CASES } from "../data/catalog/golden-hcp";
import { answerGrounded, checkClaim, groundedPrompt } from "../packages/core/src/grounded";
import { activeDocuments, ingestAll, resetDocuments } from "../packages/core/src/ingestion";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "pharma-a", agentName: "grounded-check" };
const OLD_DOSE_QUESTION = "What is the OncoX dose in the United States?";

async function freshStart(): Promise<void> {
  await resetDocuments();
  await ingestAll();
}

function questionOf(name: string): string {
  const found = [...HCP_GOLDEN.cases, ...HCP_LAB_CASES].find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found.question;
}

async function mustNotCallModel(): Promise<string> {
  throw new Error("The model was called with no document to read.");
}

const saysTheNewDose = async () => "Take 150 mg once daily with food. [oncox-us-label-v2]";

export const checks: Check[] = [
  {
    name: "The prompt holds only the active label, with its id",
    tryNext: "Build the prompt from the active documents only, each under its id in brackets.",
    run: async () => {
      await freshStart();
      const documents = await activeDocuments("OncoX", "US");
      const prompt = groundedPrompt(OLD_DOSE_QUESTION, documents);
      expect(prompt.includes("[oncox-us-label-v2]"), "The prompt does not show the label id.");
      expect(prompt.includes("150 mg"), "The prompt is missing the current dose.");
      expect(!prompt.includes("100 mg"), "The old dose reached the prompt.");
    },
  },
  {
    name: "A cited answer from the label is accepted",
    tryNext: "Accept an answer that cites a shown document and uses only its numbers.",
    run: async () => {
      await freshStart();
      const result = await answerGrounded(OLD_DOSE_QUESTION, TAGS, saysTheNewDose);
      expect(result.route === "answer", `The route was ${result.route}, wanted answer.`);
      expect(result.citations.includes("oncox-us-label-v2"), "The answer lost its citation.");
    },
  },
  {
    name: "An invented dose is refused",
    tryNext: "Check every number in the answer against the cited document.",
    run: async () => {
      await freshStart();
      const invented = async () => "Take 100 mg once daily. [oncox-us-label-v2]";
      const result = await answerGrounded(OLD_DOSE_QUESTION, TAGS, invented);
      expect(result.route === "refuse", "A number that is not in the label was accepted.");
    },
  },
  {
    name: "An answer with no citation is refused",
    tryNext: "Refuse an answer that cites no document, or one that was never shown.",
    run: async () => {
      await freshStart();
      const bare = async () => "Take it with food.";
      const unseen = async () => "Take it with food. [oncox-us-label-v3]";
      for (const generate of [bare, unseen]) {
        const result = await answerGrounded(OLD_DOSE_QUESTION, TAGS, generate);
        expect(result.route === "refuse", "An uncited answer was accepted.");
      }
    },
  },
  {
    name: "A question with no current document never reaches the model",
    tryNext: "When no active document matches, refuse before the model call.",
    run: async () => {
      await freshStart();
      for (const name of ["not-approved-in-country", "expired-draft-hidden"]) {
        const result = await answerGrounded(questionOf(name), TAGS, mustNotCallModel);
        expect(result.route === "refuse", `${name} was not refused.`);
      }
    },
  },
  {
    name: "A model that says the documents are silent is refused",
    tryNext: "When the model replies NOT_IN_DOCUMENTS, return a refusal.",
    run: async () => {
      await freshStart();
      const silent = async () => "NOT_IN_DOCUMENTS";
      const result = await answerGrounded(questionOf("unanswerable-refused"), TAGS, silent);
      expect(result.route === "refuse", "A silent document did not lead to a refusal.");
      expect(
        result.text.includes("do not say"),
        "The refusal does not say the documents are silent.",
      );
    },
  },
  {
    name: "A claim that uses a number outside its source is caught",
    tryNext: "In checkClaim, return a problem when a number is not in the cited document.",
    run: async () => {
      await freshStart();
      const documents = await activeDocuments("OncoX", "US");
      const problem = checkClaim("Take 75 mg. [oncox-us-label-v2]", documents);
      expect(problem !== undefined, "A number outside the source passed the check.");
    },
  },
];
