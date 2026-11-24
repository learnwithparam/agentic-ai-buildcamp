import { useEffect, useState } from "react";
import { decide, loadInbox, type ReviewItem } from "../chat/api";
import { formatDue, timeLeft } from "./format";

// Lesson 13. The reviewer inbox. A reviewer sees what waits for their role in their company,
// soonest deadline first, and decides it here. A doctor sees what their own questions raised and
// what became of it. The server decides who may see and decide what; this page only shows it.

const KIND = { draft: "Draft for review", adverse_event: "Adverse event report" } as const;
const ACTIONS: Record<ReviewItem["kind"], Array<{ decision: ReviewItem["status"]; label: string; primary?: boolean }>> = {
  draft: [
    { decision: "approved", label: "Approve and send", primary: true },
    { decision: "rejected", label: "Reject" }
  ],
  adverse_event: [
    { decision: "filed", label: "Filed in the safety database", primary: true },
    { decision: "dismissed", label: "Not an adverse event" }
  ]
};
const STATUS: Record<ReviewItem["status"], string> = {
  waiting: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  filed: "Filed",
  dismissed: "Dismissed"
};
const plain = (text: string) => text.replace(/\*\*|__/g, "");

function Item({ item, reviewer, onDecided }: { item: ReviewItem; reviewer: boolean; onDecided: (item: ReviewItem) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const late = item.status === "waiting" && new Date(item.dueAt).getTime() < Date.now();
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
    <article className={item.kind === "adverse_event" ? "card inbox-item inbox-safety" : "card inbox-item"}>
      <div className="card-head">
        <span>{KIND[item.kind]}</span>
        {item.status === "waiting" ? (
          <span className={`status ${late ? "status-fail" : "status-wait"}`}>
            Due {formatDue(item.dueAt)}, {timeLeft(item.dueAt)}
          </span>
        ) : (
          <span className={`status ${item.status === "rejected" || item.status === "dismissed" ? "status-fail" : "status-pass"}`}>{STATUS[item.status]}</span>
        )}
      </div>
      <div className="card-body">
        <div className="label">The doctor asked</div>
        <p className="inbox-question">{item.question}</p>
        <div className="label">{item.kind === "draft" ? "The draft" : "What the desk replied"}</div>
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
            <textarea id={`note-${item.id}`} className="inbox-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
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
    </article>
  );
}

export function Inbox() {
  const [state, setState] = useState<{ reviewer: boolean; items: ReviewItem[] } | { failed: string } | null>(null);
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
    setState({ ...state, items: state.items.filter((other) => other.id !== item.id) });
  return (
    <main className="inbox">
      <h1>{state.reviewer ? "Waiting for your review" : "What your questions sent for review"}</h1>
      <p className="inbox-lead">
        {state.reviewer
          ? "Soonest deadline first. Each decision is recorded with your name and the time. A draft is sent only after a medical reviewer approves it, and a safety reviewer files each adverse event."
          : "A draft waits for a medical reviewer before it is sent. A report of something that happened to a patient goes to the drug safety team."}
      </p>
      {state.items.length === 0 ? (
        <p className="inbox-empty">{state.reviewer ? "Nothing is waiting for you." : "None of your questions needed a reviewer."}</p>
      ) : (
        state.items.map((item) => <Item key={item.id} item={item} reviewer={state.reviewer} onDecided={decided} />)
      )}
    </main>
  );
}
