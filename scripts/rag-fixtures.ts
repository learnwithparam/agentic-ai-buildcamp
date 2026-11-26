// Writes src/server/rag/fixtures from the running Docling (npm run rag:setup), for the two PDFs
// rag.test.ts reads. Run it after the label PDFs change (npm run dataset:sync).
// npm run rag:fixtures
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/server/env";
import { convertPdf } from "../src/server/rag/extract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "src/server/rag/fixtures");
const manifest = JSON.parse(readFileSync(path.join(root, "data/hcp/pdf/manifest.json"), "utf8")) as { docs: { doc_id: string; pdf: string }[] };
const pdfOf = (docId: string) => path.join(root, manifest.docs.find((doc) => doc.doc_id === docId)!.pdf);

async function markdownOf(name: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([Buffer.from(bytes)], { type: "application/pdf" }), name);
  form.append("to_formats", "md");
  form.append("do_ocr", "false");
  const response = await fetch(`${env.doclingUrl}/v1/convert/file`, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
  const body = (await response.json()) as { document?: { md_content?: string } };
  if (!response.ok || !body.document?.md_content) throw new Error(`Docling gave no Markdown for ${name} (${response.status}).`);
  return body.document.md_content;
}

for (const docId of ["cardionex-clarion-hf-trial", "cardionex-uspi-v2"]) {
  const file = pdfOf(docId);
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await convertPdf(env.doclingUrl, { name: path.basename(file), bytes });
  writeFileSync(path.join(fixtures, `${docId}.docling.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${docId}.docling.json`);
  if (docId === "cardionex-clarion-hf-trial") {
    writeFileSync(path.join(fixtures, `${docId}.docling.md`), await markdownOf(path.basename(file), bytes));
    console.log(`wrote ${docId}.docling.md`);
  }
}
