// A planted mistake: an eval that never fails catches nothing.
import type { Run } from "../../../../operate-lib";

export default function (_run: Run): string | null {
  return null;
}
