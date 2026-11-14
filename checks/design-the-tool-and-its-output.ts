// tool.yaml: a tool named for its job, a description that says when to use it, fixed output
// fields that the example fits, and an error that tells the model what to try next.
import type { Rule } from "../scripts/verify";
import { hasFile, readYaml, validate } from "./design-lib";

type OutputSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
};
type ToolFile = {
  name?: unknown;
  description?: unknown;
  input?: Record<string, { type?: unknown; description?: unknown }>;
  output_schema?: OutputSchema;
  example_output?: unknown;
  error_example?: { error?: unknown; fix?: unknown };
};

function toolIn(folder: string): ToolFile {
  if (!hasFile(folder, "tool.yaml")) return {};
  return readYaml<ToolFile>(folder, "tool.yaml") ?? {};
}

const GENERIC_NAMES = ["tool", "helper", "data", "invoices", "run", "do", "get"];

function nameIsAJob(folder: string): boolean {
  const name = toolIn(folder).name;
  if (typeof name !== "string" || GENERIC_NAMES.includes(name)) return false;
  return /^[a-z]+(_[a-z]+)+$/.test(name);
}

function saysWhenToUse(folder: string): boolean {
  const description = String(toolIn(folder).description ?? "");
  return /use when/i.test(description) && /do not use/i.test(description);
}

function everyInputIsDescribed(folder: string): boolean {
  const fields = Object.values(toolIn(folder).input ?? {});
  if (fields.length === 0) return false;
  return fields.every(
    (field) => typeof field.type === "string" && String(field.description ?? "").trim().length > 5,
  );
}

function outputHasFixedFields(folder: string): boolean {
  const schema = toolIn(folder).output_schema;
  const names = Object.keys(schema?.properties ?? {});
  if (schema?.type !== "object" || names.length < 2) return false;
  const required = schema.required ?? [];
  const hasChoice = names.some((field) => Array.isArray(schema.properties?.[field]?.enum));
  return names.every((field) => required.includes(field)) && hasChoice;
}

function exampleFitsTheSchema(folder: string): boolean {
  const tool = toolIn(folder);
  if (!tool.output_schema || !outputHasFixedFields(folder)) return false;
  // The example must also carry only fields the schema names.
  const allowed = Object.keys(tool.output_schema.properties ?? {});
  const example = tool.example_output;
  if (typeof example !== "object" || example === null) return false;
  const extra = Object.keys(example).filter((field) => !allowed.includes(field));
  return extra.length === 0 && validate(tool.output_schema as never, example).length === 0;
}

function errorHasAFix(folder: string): boolean {
  const error = toolIn(folder).error_example;
  return String(error?.error ?? "").trim().length > 5 && String(error?.fix ?? "").trim().length > 5;
}

export default [
  {
    says: "the tool is named for its job in snake case, such as look_up_invoice",
    test: nameIsAJob,
    tryNext: "use a verb and a thing joined by an underscore, and avoid words like tool or invoices",
  },
  {
    says: "the description says when to use it and when not",
    test: saysWhenToUse,
    tryNext: 'write one sentence that starts "Use when" and one that starts "Do not use"',
  },
  {
    says: "every input field has a type and a description",
    test: everyInputIsDescribed,
    tryNext: "under input, give each field a type and a short description with an example",
  },
  {
    says: "the output has fixed required fields and an enum for its choice",
    test: outputHasFixedFields,
    tryNext: "list every field under required and give the status field an enum of allowed words",
  },
  {
    says: "the example output fits the output schema",
    test: exampleFitsTheSchema,
    tryNext: "make the example carry every required field, with the right type and no extras",
  },
  {
    says: "the error example says what went wrong and what to try next",
    test: errorHasAFix,
    tryNext: "fill in error with the cause and fix with the next call the model should make",
  },
] satisfies Rule[];
