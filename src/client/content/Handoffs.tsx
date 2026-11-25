import { useEffect, useState } from "react";
import { A2A_AGENTS, cardPath } from "../../server/a2a/cards";
import { handOff, loadCard, type AgentCardView, type Handoff } from "../chat/api";

// Lesson 15. The hand-off desk. A rep asks for work in plain words; an agent reads the other
// agents' public cards, picks the one whose skill does it, and sends it as an A2A task. The page
// shows the cards it chose from, each state the task passed through, and what still waits for a human.

const STATE: Record<string, { label: string; tone: string }> = {
  COMPLETED: { label: "Completed", tone: "status-pass" },
  INPUT_REQUIRED: { label: "Waits for input", tone: "status-wait" },
  REJECTED: { label: "Rejected", tone: "status-fail" },
  FAILED: { label: "Failed", tone: "status-fail" }
};
const stateOf = (state: string) => STATE[state] ?? { label: state.toLowerCase().replace(/_/g, " "), tone: "status-wait" };

// The report's own parts, read from the server's text: the agent's report, then how it was handed over.
const agentReport = (report: string) => {
  const end = report.search(/\n\nTask state:|\n\nHow it was handed over:/);
  return (end === -1 ? report : report.slice(0, end)).trim();
};
const handedOver = (report: string) =>
  report.includes("How it was handed over:\n")
    ? report
        .slice(report.indexOf("How it was handed over:\n"))
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/^- /, ""))
    : [];

function Card({ card, onExample }: { card: AgentCardView; onExample: (text: string) => void }) {
  const signIn = Object.values(card.securitySchemes)[0]?.openIdConnectSecurityScheme;
  return (
    <article className="card inbox-item" aria-label={`Agent card: ${card.name}`}>
      <div className="card-head">
        <span className="source-id">{card.name}</span>
        <span className="status status-pass">Public card</span>
      </div>
      <div className="card-body">
        <p className="inbox-question">{card.description}</p>
        {card.skills.map((skill) => (
          <div key={skill.id}>
            <div className="label">Skill: {skill.name}</div>
            <p className="check-meta">{skill.description}</p>
            <div className="approval-actions">
              {skill.examples.map((example) => (
                <button key={example} type="button" className="button" onClick={() => onExample(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        ))}
        {signIn?.description && <p className="approval-note">Sending work needs a sign-in: {signIn.description} Reading this card does not.</p>}
      </div>
    </article>
  );
}

// Who decides the item, and whether the task waits for them. An email the desk drafted can pass
// every check, so its task is done, and still wait in the inbox for a medical reviewer.
function InboxNote({ agent, state }: { agent: string | null; state: string | undefined }) {
  const who = agent === "outreach-planner" ? "a sales rep" : "a medical reviewer";
  return (
    <p className="approval-note">
      In the <a href="/inbox">inbox</a> now for {who}.{" "}
      {state === "INPUT_REQUIRED"
        ? "The task stays open until they decide, and their decision completes or rejects it."
        : "The other agent's task is done; nothing is sent until they approve it."}
    </p>
  );
}

function Result({ result }: { result: Handoff }) {
  const last = result.tasks.at(-1);
  return (
    <section className="card approval" aria-label="The hand-off">
      <div className="card-head">
        <span>{result.agent ? `Handed to the ${result.agent}` : "Not handed to anyone"}</span>
        {last && <span className={`status ${stateOf(last.state).tone}`}>{stateOf(last.state).label}</span>}
      </div>
      <div className="card-body editor-form">
        {result.tasks.length > 0 && (
          <>
            <div className="label">The task, turn by turn</div>
            <ol className="rules">
              {result.tasks.map((task, index) => (
                <li key={`${task.id}-${index}`}>
                  <span className={`status ${stateOf(task.state).tone}`}>{stateOf(task.state).label}</span> <span className="source-meta">task {task.id.slice(0, 8)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        <div className="label">{result.agent ? "The agent's report" : "Why"}</div>
        <div className="approval-draft">{agentReport(result.report) || result.report}</div>
        {handedOver(result.report).length > 0 && (
          <>
            <div className="label">How it was handed over</div>
            <ul className="rules">
              {handedOver(result.report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {result.itemId && <InboxNote agent={result.agent} state={last?.state} />}
      </div>
    </section>
  );
}

export function Handoffs() {
  const [cards, setCards] = useState<AgentCardView[] | { failed: string } | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all(A2A_AGENTS.map((name) => loadCard(cardPath(name))))
      .then(setCards)
      .catch((failure: Error) => setCards({ failed: failure.message }));
  }, []);

  const send = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await handOff(query));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="inbox">
      <h1>Hand work to another agent</h1>
      <p className="inbox-lead">Ask for an email to be drafted and fact-checked, or for the next step with a doctor. The work goes to the agent whose card says it does that, signed as you, and anything flagged waits for a human.</p>

      <section className="card">
        <div className="card-head">What should be done</div>
        <div className="card-body editor-form">
          <label className="label" htmlFor="handoff-query">
            Request
          </label>
          <textarea id="handoff-query" className="inbox-note" maxLength={1000} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="approval-actions">
            <button type="button" className="button button-primary" disabled={busy || !query.trim()} onClick={() => void send()}>
              Hand it over
            </button>
          </div>
        </div>
      </section>

      {busy && <p className="inbox-empty">Reading the agent cards and sending the task...</p>}
      {error && <p className="inbox-error">{error}</p>}
      {result && <Result result={result} />}

      <h2>The agents it can hand work to</h2>
      {!cards ? (
        <p className="inbox-empty" aria-busy="true">
          Reading the agent cards...
        </p>
      ) : "failed" in cards ? (
        <p className="inbox-error">{cards.failed}</p>
      ) : (
        cards.map((card) => <Card key={card.name} card={card} onExample={setQuery} />)
      )}
    </main>
  );
}
