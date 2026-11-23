import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// This module lives in src/server during development and dist/server after build.
// In both cases, ../../.env points at the repository-level workshop config.
config({
  path: path.resolve(currentDir, "../../.env"),
  override: true,
  quiet: true
});
