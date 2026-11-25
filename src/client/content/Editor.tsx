import { useEffect, useState } from "react";
import { factCheck, loadDrafts, type Draft, type FactCheck, type SentenceCheck } from "../chat/api";

// Lesson 14. The email editor. A writer picks a saved draft, or pastes a sentence, and sees each
// sentence against the approved claims for the country it goes to. The server decides every
// verdict; this page only shows it. A flagged email goes to a medical reviewer's inbox.

const COUNTRIES = { US: "the US", DE: "Germany", JP: "Japan" } as const;
type Country = keyof typeof COUNTRIES;

const VERDICT: Record<SentenceCheck["verdict"], { label: string; tone: string }> = {
  APPROVED: { label: "Approved claim", tone: "status-pass" },
  NOT_APPROVED_IN_COUNTRY: { label: "Not approved here", tone: "status-fail" },
  UNAPPROVED_CLAIM: { label: "No approved claim", tone: "status-fail" }
};

function Sentence({ check, country, index }: { check: SentenceCheck; country: string; index: number }) {
  const { label, tone } = VERDICT[check.verdict];
  return (
    <li className={check.verdict === "APPROVED" ? "check" : "check check-flagged"}>
      <div className="check-head">
        <span className="check-number">{index + 1}</span>
        <span className={`status ${tone}`}>{label}</span>
      </div>
      <p className="check-sentence">{check.sentence}</p>
      {check.verdict === "APPROVED" && check.claim && <p className="check-meta">Matches claim {check.claim.claimId}, from {check.claim.docId} section {check.claim.section}.</p>}
      {check.verdict === "NOT_APPROVED_IN_COUNTRY" && check.claim && (
        <p className="check-meta">
          Claim {check.claim.claimId} is approved in {COUNTRIES[check.claim.country as Country] ?? check.claim.country}, not in {COUNTRIES[country as Country] ?? country}.
        </p>
      )}
      {check.verdict === "UNAPPROVED_CLAIM" && <p className="check-meta">No approved claim says this. Use an approved one, word for word, or send it to medical review.</p>}
      {check.suggestion && (
        <div className="check-suggestion">
          <div className="label">Use instead, claim {check.suggestion.claimId}</div>
          <p>{check.suggestion.text}</p>
        </div>
      )}
    </li>
  );
}

export function Editor() {
  const [drafts, setDrafts] = useState<Draft[] | { failed: string } | null>(null);
  const [draftId, setDraftId] = useState("");
  const [text, setText] = useState("");
  const [country, setCountry] = useState<Country>("US");
  const [result, setResult] = useState<FactCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadDrafts()
      .then(({ drafts }) => {
        setDrafts(drafts);
        if (drafts[0]) setDraftId(drafts[0].draftId);
      })
      .catch((failure: Error) => setDrafts({ failed: failure.message }));
  }, []);

  if (!drafts) return <main className="inbox" aria-busy="true" />;
  if ("failed" in drafts) {
    return (
      <main className="inbox">
        <h1>The editor is not available</h1>
        <p>{drafts.failed}</p>
      </main>
    );
  }

  const chosen = drafts.find((draft) => draft.draftId === draftId);
  const run = async (request: { draftId: string } | { text: string; country: string }) => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await factCheck(request));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const flagged = result?.checks.filter((check) => check.verdict !== "APPROVED").length ?? 0;

  return (
    <main className="inbox">
      <h1>Check an email before it goes out</h1>
      <p className="inbox-lead">Every sentence must be an approved claim for the country the email goes to, word for word. A flagged email waits for a medical reviewer.</p>

      <section className="card">
        <div className="card-head">A saved draft</div>
        <div className="card-body editor-form">
          <label className="label" htmlFor="draft">
            Draft
          </label>
          <select id="draft" className="editor-input" value={draftId} onChange={(event) => setDraftId(event.target.value)}>
            {drafts.map((draft) => (
              <option key={draft.draftId} value={draft.draftId}>
                {draft.title} ({COUNTRIES[draft.country as Country] ?? draft.country})
              </option>
            ))}
          </select>
          {chosen && (
            <ol className="editor-draft">
              {chosen.sentences.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ol>
          )}
          <div className="approval-actions">
            <button type="button" className="button button-primary" disabled={busy || !chosen} onClick={() => void run({ draftId })}>
              Check this draft
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">Or one sentence</div>
        <div className="card-body editor-form">
          <label className="label" htmlFor="text">
            Sentence
          </label>
          <textarea id="text" className="inbox-note" maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
          <label className="label" htmlFor="country">
            Goes to
          </label>
          <select id="country" className="editor-input" value={country} onChange={(event) => setCountry(event.target.value as Country)}>
            {Object.entries(COUNTRIES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <div className="approval-actions">
            <button type="button" className="button" disabled={busy || !text.trim()} onClick={() => void run({ text, country })}>
              Check this sentence
            </button>
          </div>
        </div>
      </section>

      {busy && <p className="inbox-empty">Checking each sentence...</p>}
      {error && <p className="inbox-error">{error}</p>}
      {result && (
        <section className="card" aria-label="Fact-check result">
          <div className="card-head">
            <span>
              {result.checks.length} sentence{result.checks.length === 1 ? "" : "s"} for {COUNTRIES[result.country as Country] ?? result.country}
            </span>
            <span className={`status ${flagged ? "status-fail" : "status-pass"}`}>{flagged ? `${flagged} flagged` : "All approved"}</span>
          </div>
          <div className="card-body">
            <ol className="checks">
              {result.checks.map((check, index) => (
                <Sentence key={`${index}-${check.sentence}`} check={check} country={result.country} index={index} />
              ))}
            </ol>
            {result.itemId && (
              <p className="approval-note">
                {result.itemStatus === "waiting" ? "Sent to a medical reviewer. It is in their inbox now." : `A medical reviewer already decided this exact email: ${result.itemStatus}.`}
              </p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
