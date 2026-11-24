// Lesson 13. Patient identifiers leave the doctor's message before anything else reads it: the
// model, the trace, the checkpoint in Postgres and the reviewer inbox all get the scrubbed text.
// A rule in code, not a line in the prompt, because a prompt can be talked out of it.
//
// It finds the identifiers that have a shape: record numbers, email addresses, phone numbers and
// US social security numbers. A patient's name has no shape, so the safety reviewer still reads
// every report before it is filed.

const PATTERNS: Array<[RegExp, string]> = [
  // MRN-88412, MRN 88412, MRN: 88412, medical record number 88412, record no. 88412
  [/\b(?:MRN|medical record (?:number|no\.?)|record (?:number|no\.?))\s*[:#-]?\s*[A-Z0-9-]*\d[A-Z0-9-]*/gi, "[record number removed]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email removed]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ID number removed]"],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone number removed]"]
];

export type Scrubbed = { text: string; removed: number };

export function scrubPhi(text: string): Scrubbed {
  let removed = 0;
  let out = text;
  for (const [pattern, label] of PATTERNS) {
    out = out.replace(pattern, () => {
      removed++;
      return label;
    });
  }
  return { text: out, removed };
}
