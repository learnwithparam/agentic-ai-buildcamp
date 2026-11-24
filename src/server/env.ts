import "./load-env";

export const env = {
  port: Number(process.env.PORT ?? 8787),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "openai/gpt-6-luna",
  decisionModel: process.env.DECISION_MODEL ?? "openai/gpt-6-luna-decisions",
  decisionsUrl: process.env.DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions",
  gatewayUrl: process.env.LANGFUSE_GATEWAY_URL ?? "http://localhost:3031",
  gatewayKeyMedinfoApp: process.env.GATEWAY_KEY_MEDINFO_APP ?? "",
  gatewayKeyEvalRunner: process.env.GATEWAY_KEY_EVAL_RUNNER ?? "",
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  langfusePromptName: process.env.LANGFUSE_PROMPT_NAME ?? "hcp-medinfo-agent",
  langfusePromptLabel: process.env.LANGFUSE_PROMPT_LABEL ?? "production",
  workshopPromptVariant: process.env.WORKSHOP_PROMPT_VARIANT ?? "default",
  datasetName: process.env.DATASET_NAME ?? "hcp-medinfo-workshop"
};

export function isLangfuseConfigured() {
  return Boolean(env.langfusePublicKey && env.langfuseSecretKey);
}
