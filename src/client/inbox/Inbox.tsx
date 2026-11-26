import { useEffect, useState } from "react";
import { decide, loadInbox, type ReviewItem } from "../chat/api";
import type { AnswerRun } from "../../shared/run";
import { CHECK, TIER } from "../chat/RunSteps";
import { formatDue, timeLeft } from "./format";

// Lesson 13. The reviewer inbox. A reviewer sees what waits for their role in their company,
// soonest deadline first, and decides it here. A doctor sees what their own questions raised and
// what became of it. The server decides who may see and decide what; this page only shows it.

const KIND = {
  draft: "Draft for review",
  adverse_event: "Adverse event report",
  email: "Email for medical review",
  outreach: "Outreach step",
} as const;
const ACTIONS: Record<
  ReviewItem["kind"],
  Array<{ decision: ReviewItem["status"]; label: string; primary?: boolean }>
> = {
  draft: [
    { decision: "approved", label: "Approve and send", primary: true },
    { decision: "rejected", label: "Reject" },
  ],
  adverse_event: [
    { decision: "filed", label: "Filed in the safety database", primary: true },
    { decision: "dismissed", label: "Not an adverse event" },
  ],
  // Lesson 14.
  email: [
    { decision: "approved", label: "Approve the email", primary: true },
    { decision: "rejected", label: "Send it back" },
  ],
  outreach: [
    { decision: "approved", label: "Approve the step", primary: true },
    { decision: "rejected", label: "Reject" },
  ],
};
// What each kind shows above its two texts.
const PARTS: Record<ReviewItem["kind"], [string, string]> = {
  draft: ["The doctor asked", "The draft"],
  adverse_event: ["The doctor asked", "What the desk replied"],
  email: ["What was checked", "The fact-check"],
  outreach: ["The step", "The plan"],
};
const STATUS: Record<ReviewItem["status"], string> = {
  waiting: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  filed: "Filed",
  dismissed: "Dismissed",
};
const plain = (text: string) => text.replace(/\*\*|__/g, "");

// Step 2B. The evidence a reviewer decides with: why the item came to them, the label sections the
// answer rests on, and whether its citations passed the check. It is the run record the chat shows
// under the answer, saved with the item when it was made.
function Evidence({ run }: { run: AnswerRun }) {
  const hits = [
    ...new Map(
      run.lookups
        .flatMap((lookup) => lookup.hits)
        .map((hit) => [`${hit.doc_id} ${hit.section}`, hit]),
    ).values(),
  ];
  return (
    <aside className="evidence" aria-label="Evidence">
      <div className="label">Why it came to you</div>
      <p className="evidence-line">
        The desk {TIER[run.tier] ?? run.tier}. {run.reason}
      </p>
      {hits.length > 0 && (
        <>
          <div className="label">What it rests on</div>
          <ul className="run-hits">
            {hits.map((hit) => (
              <li key={`${hit.doc_id}-${hit.section}`}>
                <code>
                  {hit.doc_id} {hit.section}
                </code>
                {hit.score !== undefined && (
                  <span className="run-score">{hit.score.toFixed(2)}</span>
                )}
                <span
                  className={
                    hit.status === "active"
                      ? "run-status"
                      : "run-status run-status-off"
                  }
                >
                  {hit.country} ·{" "}
                  {hit.status === "active" ? "in force" : hit.status}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {run.check && (
        <>
          <div className="label">The citation check</div>
          <p className="evidence-line">
            <span
              className={`status status-${run.check.outcome === "passed" ? "pass" : run.check.outcome === "rewritten" ? "wait" : "fail"}`}
            >
              {run.check.outcome}
            </span>{" "}
            {CHECK[run.check.outcome]}
          </p>
          {run.check.problems.length > 0 && (
            <ul className="run-problems">
              {run.check.problems.map((problem) => (
                <li key={problem}>The first answer {problem}.</li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

// The clock is the rule the item falls under: hours from when it was made to when it is due.
const ruleHours = (item: ReviewItem) =>
  Math.round(
    (new Date(item.dueAt).getTime() - new Date(item.createdAt).getTime()) /
      3_600_000,
  );

function Item({
  item,
  reviewer,
  onDecided,
}: {
  item: ReviewItem;
  reviewer: boolean;
  onDecided: (item: ReviewItem) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const late =
    item.status === "waiting" && new Date(item.dueAt).getTime() < Date.now();
  const send = async (decision: ReviewItem["status"]) => {
    setBusy(true);
    setError("");
    try {
      onDecided(await decide(item.id, decision, note));
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <article
      className={
        item.kind === "adverse_event"
          ? "card inbox-item inbox-safety"
          : "card inbox-item"
      }
    >
      <div className="card-head">
        <span>{KIND[item.kind]}</span>
        {item.status === "waiting" ? (
          <span className={`status ${late ? "status-fail" : "status-wait"}`}>
            Due {formatDue(item.dueAt)}, {timeLeft(item.dueAt)} (
            {ruleHours(item)}-hour rule)
          </span>
        ) : (
          <span
            className={`status ${item.status === "rejected" || item.status === "dismissed" ? "status-fail" : "status-pass"}`}
          >
            {STATUS[item.status]}
          </span>
        )}
      </div>
      <div className={item.run ? "card-body inbox-split" : "card-body"}>
        <div>
          <div className="label">{PARTS[item.kind][0]}</div>
          <p className="inbox-question">{item.question}</p>
          <div className="label">{PARTS[item.kind][1]}</div>
          <div className="approval-draft">{plain(item.body)}</div>
          {item.note && (
            <>
              <div className="label">Reviewer&apos;s note</div>
              <p className="inbox-question">{item.note}</p>
            </>
          )}
          {reviewer && item.status === "waiting" && (
            <>
              <label className="label" htmlFor={`note-${item.id}`}>
                Note (optional)
              </label>
              <textarea
                id={`note-${item.id}`}
                className="inbox-note"
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="approval-actions">
                {ACTIONS[item.kind].map((action) => (
                  <button
                    key={action.decision}
                    type="button"
                    className={`button${action.primary ? " button-primary" : ""}`}
                    disabled={busy}
                    onClick={() => void send(action.decision)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              {error && <p className="inbox-error">{error}</p>}
            </>
          )}
        </div>
        {item.run && <Evidence run={item.run} />}
      </div>
    </article>
  );
}

export function Inbox() {
  const [state, setState] = useState<
    { reviewer: boolean; items: ReviewItem[] } | { failed: string } | null
  >(null);
  useEffect(() => {
    loadInbox()
      .then(setState)
      .catch((error: Error) => setState({ failed: error.message }));
  }, []);
  if (!state) return <main className="inbox" aria-busy="true" />;
  if ("failed" in state) {
    return (
      <main className="inbox">
        <h1>The inbox is not reachable</h1>
        <p>{state.failed}</p>
      </main>
    );
  }
  const decided = (item: ReviewItem) =>
    setState({
      ...state,
      items: state.items.filter((other) => other.id !== item.id),
    });
  return (
    <main className="inbox">
      <h1>
        {state.reviewer
          ? "Waiting for your review"
          : "What your questions sent for review"}
      </h1>
      <p className="inbox-lead">
        {state.reviewer
          ? "Soonest deadline first. Each decision is recorded with your name and the time. Nothing here reaches a doctor until it is decided, and you never decide an item your own request raised."
          : "A draft waits for a medical reviewer before it is sent. A report of something that happened to a patient goes to the drug safety team."}
      </p>
      {state.items.length === 0 ? (
        <p className="inbox-empty">
          {state.reviewer
            ? "Nothing is waiting for you."
            : "None of your questions needed a reviewer."}
        </p>
      ) : (
        state.items.map((item) => (
          <Item
            key={item.id}
            item={item}
            reviewer={state.reviewer}
            onDecided={decided}
          />
        ))
      )}
    </main>
  );
}
