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
  // Lesson 11. npm run identity:setup writes every value below to .env; none has a usable default secret.
  // The address the doctor opens. Keycloak sends them back here after sign-in.
  appUrl: process.env.APP_URL ?? "http://127.0.0.1:3333",
  // Keycloak: the realm that signs the doctors in, and this app's confidential client.
  oidcIssuer: process.env.OIDC_ISSUER ?? "http://localhost:8180/realms/medinfo",
  oidcClientId: process.env.OIDC_CLIENT_ID ?? "medinfo-chat",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  // Every access token for this API carries this audience; a token minted for another app is refused.
  oidcAudience: process.env.OIDC_AUDIENCE ?? "medinfo-api",
  // OpenFGA: who may read which document.
  fgaApiUrl: process.env.FGA_API_URL ?? "http://localhost:8280",
  fgaApiToken: process.env.FGA_API_TOKEN ?? "",
  fgaStoreId: process.env.FGA_STORE_ID ?? "",
  fgaModelId: process.env.FGA_MODEL_ID ?? "",
  // The app's own database (sessions now, conversations from lesson 13), in infra/docker-compose.yml.
  databaseUrl: process.env.DATABASE_URL ?? "",
  // npm run check writes and deletes rows here, never in the app's database.
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? "",
  datasetName: process.env.DATASET_NAME ?? "hcp-medinfo-workshop"
};

export function isLangfuseConfigured() {
  return Boolean(env.langfusePublicKey && env.langfuseSecretKey);
}
