import { createContext, useContext } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { AnswerRun, RunLookup } from "../../shared/run";

// Step 2B. "How this answer was made", under each reply: the same steps as the trace, from the
// record the graph keeps per reply (src/shared/run.ts). The chat fills the record from the
// stream's values events and from the thread's saved state on a reload.
export const RunsContext = createContext<Record<string, AnswerRun>>({});

export const TIER: Record<string, string> = {
  answer: "answered from the labels",
  review: "drafted for a medical reviewer",
  safety: "treated as a possible side effect report",
  stop: "stopped with a fixed reply"
};

export const CHECK: Record<string, string> = {
  passed: "every citation and number was found in its section",
  rewritten: "the first answer failed, so it was written again",
  withheld: "the answer failed twice, so it was not sent"
};

function Lookup({ lookup }: { lookup: RunLookup }) {
  return (
    <>
      <p className="run-line">
        <code>{lookup.tool}</code> {lookup.asked ? `"${lookup.asked}"` : ""}
        {lookup.failed ? " failed" : ` found ${lookup.hits.length} section${lookup.hits.length === 1 ? "" : "s"}`}
      </p>
      {lookup.hits.length > 0 && (
        <ul className="run-hits">
          {lookup.hits.map((hit) => (
            <li key={`${hit.doc_id}-${hit.section}`}>
              <code>
                {hit.doc_id} {hit.section}
              </code>
              {hit.score !== undefined && <span className="run-score">{hit.score.toFixed(2)}</span>}
              <span className={hit.status === "active" ? "run-status" : "run-status run-status-off"}>
                {hit.country} · {hit.status === "active" ? "in force" : hit.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function RunSteps() {
  const id = useAuiState((state) => state.message.id);
  const run = useContext(RunsContext)[id];
  if (!run) return null;
  return (
    <details className="run">
      <summary>How this answer was made</summary>
      <ol className="run-steps">
        <li>
          <span className="run-step">Sorted</span>
          <div>
            <p className="run-line">
              {TIER[run.tier] ?? run.tier}
              {run.reason ? `: ${run.reason}` : ""}
            </p>
          </div>
        </li>
        {run.lookups.length > 0 && (
          <li>
            <span className="run-step">Looked up</span>
            <div>
              {run.lookups.map((lookup, index) => (
                <Lookup key={index} lookup={lookup} />
              ))}
            </div>
          </li>
        )}
        {run.check && (
          <li>
            <span className="run-step">Checked</span>
            <div>
              <p className="run-line">
                <span className={`status status-${run.check.outcome === "passed" ? "pass" : run.check.outcome === "rewritten" ? "wait" : "fail"}`}>{run.check.outcome}</span>{" "}
                {CHECK[run.check.outcome]}
              </p>
              {run.check.problems.length > 0 && (
                <ul className="run-problems">
                  {run.check.problems.map((problem) => (
                    <li key={problem}>The first answer {problem}.</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        )}
      </ol>
    </details>
  );
}
