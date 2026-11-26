import "../src/server/load-env";
import { LangfuseClient } from "@langfuse/client";
import { env } from "../src/server/env";
import { loadAllCases } from "./hcp-cases";
import { runMain } from "./run-main";

async function main() {
  const cases = loadAllCases();
  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    throw new Error("Langfuse credentials are required to seed a dataset.");
  }

  const langfuse = new LangfuseClient({
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl
  });

  try {
    await langfuse.api.datasets.create({
      name: env.datasetName,
      description: "HCP medinfo cases from the pinned dataset repo copy in data/hcp",
      metadata: {
        source: "data/hcp/evals/medinfo.yaml, fact-check.yaml, outreach.yaml, a2a.yaml, events.yaml, autonomy.yaml",
        workshop: "langfuse-hcp-medinfo"
      }
    });
  } catch (error) {
    if (!(error instanceof Error) || !/exists|duplicate/i.test(error.message)) {
      throw error;
    }
  }

  for (const item of cases) {
    await langfuse.api.datasetItems.create({
      id: item.id,
      datasetName: env.datasetName,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata
    });
  }

  await langfuse.flush();
  console.log(`Seeded dataset "${env.datasetName}" with ${cases.length} items.`);
}

void runMain(main, { name: "Dataset seed" });
