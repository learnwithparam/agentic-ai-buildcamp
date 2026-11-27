import "../src/server/load-env";
import { LangfuseClient } from "@langfuse/client";
import { env } from "../src/server/env";
import { PROMPT_VARIANTS } from "./prompt-variants";
import { runMain } from "./run-main";

type WorkshopPromptVariant = keyof typeof PROMPT_VARIANTS;

function resolvePromptVariant(variantName: string): {
  name: WorkshopPromptVariant;
  prompt: string;
} {
  const normalizedVariantName = variantName.trim() || "default";

  if (normalizedVariantName in PROMPT_VARIANTS) {
    const name = normalizedVariantName as WorkshopPromptVariant;
    return { name, prompt: PROMPT_VARIANTS[name] };
  }

  throw new Error(
    `Unsupported WORKSHOP_PROMPT_VARIANT "${variantName}". ` +
      `Supported variants: ${Object.keys(PROMPT_VARIANTS).join(", ")}.`
  );
}

async function main() {
  // A variant for one publish is a flag, since the env file wins over the shell.
  const variantFlag = process.argv.indexOf("--variant");
  const variant = resolvePromptVariant((variantFlag >= 0 ? process.argv[variantFlag + 1] : "") || env.workshopPromptVariant);

  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    throw new Error("Langfuse credentials are required to publish prompts.");
  }

  const langfuse = new LangfuseClient({
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl
  });

  const name = env.langfusePromptName || "hcp-medinfo-agent";
  // .env wins over the shell (load-env overrides), so a label for one publish is a flag:
  // `npm run prompt:publish -- --label staging` leaves production where it is.
  const flag = process.argv.indexOf("--label");
  const label = (flag >= 0 ? process.argv[flag + 1] : "") || env.langfusePromptLabel || "production";

  await langfuse.prompt.create({
    name,
    type: "text",
    prompt: variant.prompt,
    labels: [label]
  });

  console.log(`Published prompt "${name}" (${variant.name} variant) with label "${label}".`);
}

void runMain(main, { name: "Prompt publish" });
