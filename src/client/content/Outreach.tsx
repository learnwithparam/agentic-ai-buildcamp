import { useEffect, useState } from "react";
import { loadHcps, planOutreach, type HcpRecord, type OutreachPlan } from "../chat/api";

// Lesson 14. The rep board. A sales rep sees the doctors their company calls on, each as one
// shared record across teams, and asks for the next step. The server holds a duplicate send and
// respects an opt-out in code; every step waits for a rep to approve it in the inbox.

const OUTCOME: Record<OutreachPlan["outcome"], { label: string; tone: string }> = {
  NEEDS_APPROVAL: { label: "Waits for a rep", tone: "status-wait" },
  HOLD_OUTREACH: { label: "Hold", tone: "status-fail" },
  INSUFFICIENT_CONTEXT: { label: "Not enough to plan", tone: "status-fail" }
};

function History({ record }: { record: HcpRecord }) {
  const lines = [
    ...record.sends.map((send) => ({ id: send.sendId, at: send.sentAt, text: `Email "${send.campaign}" sent by ${send.team}` })),
    ...record.calls.map((call) => ({ id: call.callId, at: call.loggedAt, text: `Call centre: ${call.note}` })),
    ...record.notes.map((note) => ({ id: note.noteId, at: note.loggedAt, text: `Rep note: ${note.note}` })),
    ...record.samples.map((sample) => ({ id: sample.requestId, at: sample.requestedAt, text: `Sample request, ${sample.status}` }))
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!lines.length) return <p className="check-meta">No contact yet.</p>;
  return (
    <ul className="sources">
      {lines.map((line) => (
        <li key={line.id} className="source">
          <span className="source-id">{line.id}</span>
          <span>{line.text}</span>
          <span className="source-meta">{line.at.slice(0, 10)}</span>
        </li>
      ))}
    </ul>
  );
}

// The report's "Based on" list, read straight from the server's text.
const basedOn = (report: string) => report.slice(report.indexOf("Based on")).split("\n").slice(1).map((line) => line.replace(/^- /, ""));
// The line that carries the outcome code, shown without the code: the label above says it.
const verdict = (report: string) => {
  const line = (report.split("\n").find((text) => /^[A-Z_]+: /.test(text)) ?? "").replace(/^[A-Z_]+: /, "");
  return line.charAt(0).toUpperCase() + line.slice(1);
};
const why = (report: string) => report.match(/^Why: (.*)$/m)?.[1] ?? "";

function Plan({ plan }: { plan: OutreachPlan }) {
  const { label, tone } = OUTCOME[plan.outcome];
  return (
    <section className="card approval" aria-label="The plan">
      <div className="card-head">
        <span>{plan.hcpId ?? "The plan"}</span>
        <span className={`status ${tone}`}>{label}</span>
      </div>
      <div className="card-body editor-form">
        <p className="inbox-question">{verdict(plan.report)}</p>
        {plan.step && (
          <>
            <div className="label">The step</div>
            <p className="inbox-question">{plan.step}</p>
          </>
        )}
        {plan.email && (
          <>
            <div className="label">The email, only approved claims</div>
            <div className="approval-draft">{plan.email.join(" ")}</div>
          </>
        )}
        {why(plan.report) && (
          <>
            <div className="label">Why</div>
            <p className="inbox-question">{why(plan.report)}</p>
          </>
        )}
        {plan.report.includes("Based on:\n") && (
          <>
            <div className="label">Based on</div>
            <ul className="rules">
              {basedOn(plan.report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {plan.itemId && (
          <p className="approval-note">
            {plan.itemStatus === "waiting" ? "In the inbox now. Nothing reaches the doctor until a rep approves it." : `A rep already decided this exact step: ${plan.itemStatus}.`}
          </p>
        )}
      </div>
    </section>
  );
}

export function Outreach() {
  const [hcps, setHcps] = useState<HcpRecord[] | { failed: string } | null>(null);
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState<OutreachPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadHcps()
      .then(({ hcps }) => setHcps(hcps))
      .catch((failure: Error) => setHcps({ failed: failure.message }));
  }, []);

  if (!hcps) return <main className="inbox" aria-busy="true" />;
  if ("failed" in hcps) {
    return (
      <main className="inbox">
        <h1>The rep board is not available</h1>
        <p>{hcps.failed}</p>
      </main>
    );
  }

  const ask = async (text: string) => {
    setQuery(text);
    setBusy(true);
    setError("");
    setPlan(null);
    try {
      setPlan(await planOutreach(text));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="inbox">
      <h1>Plan the next contact</h1>
      <p className="inbox-lead">One record per doctor, shared by every team. A doctor who opted out of email gets none, a campaign is never sent twice, and every step waits for a rep.</p>

      <section className="card">
        <div className="card-head">Ask about one doctor</div>
        <div className="card-body editor-form">
          <label className="label" htmlFor="query">
            Request
          </label>
          <textarea id="query" className="inbox-note" maxLength={1000} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="approval-actions">
            <button type="button" className="button button-primary" disabled={busy || !query.trim()} onClick={() => void ask(query)}>
              Plan it
            </button>
          </div>
        </div>
      </section>

      {busy && <p className="inbox-empty">Reading the record...</p>}
      {error && <p className="inbox-error">{error}</p>}
      {plan && <Plan plan={plan} />}

      {hcps.length === 0 ? (
        <p className="inbox-empty">Your company has no doctors in the CRM.</p>
      ) : (
        hcps.map((record) => (
          <article key={record.profile.hcpId} className="card inbox-item">
            <div className="card-head">
              <span className="source-id">{record.profile.hcpId}</span>
              <span>
                {record.profile.specialty}, {record.profile.country}
              </span>
              <span className={`status ${record.profile.emailConsent ? "status-pass" : "status-fail"}`}>{record.profile.emailConsent ? "Email allowed" : "No email"}</span>
            </div>
            <div className="card-body">
              <p className="check-meta">Prefers {record.profile.preferredChannel.replace(/_/g, " ")}.</p>
              <History record={record} />
              <div className="approval-actions">
                <button type="button" className="button" disabled={busy} onClick={() => void ask(`What is the next step for ${record.profile.hcpId}?`)}>
                  Plan the next step
                </button>
              </div>
            </div>
          </article>
        ))
      )}
    </main>
  );
}
