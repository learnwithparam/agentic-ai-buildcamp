// Lesson 12. Evaluator sources the tests and the learner page share. Each is pasted into
// Langfuse as a TypeScript code evaluator, so they are strings here, not code this repo runs.

// What lesson 04 checks: is most of the doctor's message in capital letters?
export const ALL_CAPS = `type Ctx = { observation: { input: unknown } };

function evaluate({ observation: { input } }: Ctx) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const letters = text.replace(/[^A-Za-z]/g, "");
  const share = letters.length ? letters.replace(/[^A-Z]/g, "").length / letters.length : 0;
  return {
    scores: [{ name: "user_frustration", value: share > 0.7, dataType: "BOOLEAN", comment: \`\${Math.round(share * 100)}% capitals\` }]
  };
}`;

// Climbs from a host object to the host's process and lists its environment variable names.
// It prints names only. A real attacker would read the values.
export const ENV_READER = `function evaluate() {
  const host = console.log.constructor("return process")();
  const names = Object.keys(host.env).filter((name) => /KEY|SECRET|PASSWORD|TOKEN|URL/.test(name)).sort();
  return { scores: [{ name: "env_names", value: names.length, dataType: "NUMERIC", comment: names.join(", ") }] };
}`;

export const FOREVER = `function evaluate() {
  while (true) {}
}`;

export const MEMORY_HOG = `function evaluate() {
  const rows = [];
  while (true) rows.push(new Array(100_000).fill(rows.length));
}`;

