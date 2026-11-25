import { useCallback, useEffect, useState } from "react";
import { loadSweep, pauseSweep, runSweepNow, type SweepRunView, type SweepView } from "../chat/api";
import { formatDue } from "../inbox/format";
import { STAFF_ROLES } from "../../server/users";

// Lesson 17. The nightly sweep's page. The sweep works alone at 02:00 UTC, within three limits the
// page shows: what it may do (draft and plan, never send), what it may spend today, and a switch
// that stops it before its next step. Everything it makes waits in the inbox for a person.

const STATUS: Record<SweepRunView["status"], { label: string; tone: string }> = {
  running: { label: "Working", tone: "status-wait" },
  done: { label: "Done", tone: "status-pass" },
  budget_stop: { label: "Stopped at the budget", tone: "status-wait" },
  paused: { label: "Stopped by the switch", tone: "status-fail" },
  failed: { label: "Failed", tone: "status-fail" }
};

const usd = (amount: number) => `${Number(amount.toFixed(4))} USD`;

function Meter({ spent, budget }: { spent: number | null; budget: number }) {
  if (spent === null) return <p className="inbox-error">Today's spend cannot be read right now, so the sweep will not start a step until it can.</p>;
  const share = Math.min(1, budget > 0 ? spent / budget : 1);
  return (
    <div className="sweep-meter">
      <div className="sweep-meter-bar" role="meter" aria-label="Spent today" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent}>
        <span className={share >= 1 ? "sweep-meter-full" : ""} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="check-meta">
        Spent today: {usd(spent)} of {usd(budget)}. The sweep reads this before every step and stops at the limit.
      </p>
    </div>
  );
}

function RunCard({ run }: { run: SweepRunView }) {
  const status = STATUS[run.status];
  const who = run.trigger === "schedule" ? "The nightly schedule" : (run.requestedBy ?? "A person");
  return (
    <article className="card inbox-item" aria-label={`Sweep run ${run.runId}`}>
      <div className="card-head">
        <span>
          {who} started a sweep {formatDue(run.startedAt)}
        </span>
        <span className={`status ${status.tone}`}>{status.label}</span>
      </div>
      <div className="card-body">
        <p className="check-meta">
          {run.steps} {run.steps === 1 ? "step" : "steps"}
          {run.spentUsd !== null ? `, ${usd(run.spentUsd)} spent today when it ended` : ""}.{run.finishedAt ? ` Ended ${formatDue(run.finishedAt)}.` : ""}
        </p>
        {run.instruction && <p className="inbox-question">Instruction: {run.instruction}</p>}
        {run.report && <div className="approval-draft">{run.report}</div>}
        {run.failed && <p className="inbox-error">This run failed. Nothing it had not finished was kept, and the next night runs again.</p>}
        {run.itemIds.length > 0 || run.report?.includes("REVIEW_REQUIRED") ? (
          <p className="approval-note">
            What this run made waits in the <a href="/inbox">inbox</a> for a person to decide. The sweep sends nothing.
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function Sweep({ roles }: { roles: readonly string[] }) {
  const staff = roles.some((role) => (STAFF_ROLES as readonly string[]).includes(role));
  const [view, setView] = useState<SweepView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [today, setToday] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    loadSweep()
      .then((next) => {
        setView(next);
        setError("");
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);
  useEffect(refresh, [refresh]);
  // A run can start at any time (the schedule, or a colleague), so the page keeps looking: every
  // few seconds while a run works or was just asked for, and every ten seconds otherwise.
  const working = view?.runs.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    const timer = setInterval(refresh, working || notice ? 3000 : 10_000);
    return () => clearInterval(timer);
  }, [working, notice, refresh]);

  const act = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setNotice(done);
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const controls = view?.controls;
  return (
    <main className="inbox">
      <h1>Nightly sweep</h1>
      <p className="inbox-lead">
        Every night at 02:00 UTC the sweep redrafts each open answer that cites a label no longer in force, and plans any outreach a person asked for. It drafts and plans only: every draft and every step waits in the inbox for a person.
      </p>
      {error && <p className="inbox-error">{error}</p>}
      {!view || !controls ? (
        <p className="inbox-empty" aria-busy="true">
          Reading the sweep...
        </p>
      ) : (
        <>
          <section className="card">
            <div className="card-head">
              <span>Limits</span>
              <span className={`status ${controls.paused ? "status-fail" : "status-pass"}`}>{controls.paused ? "Paused" : "On"}</span>
            </div>
            <div className="card-body editor-form">
              <Meter spent={view.spentUsd} budget={controls.budgetUsd} />
              <p className="check-meta">
                {controls.paused
                  ? `${controls.changedBy ?? "Someone"} paused the sweep${controls.changedAt ? ` ${formatDue(controls.changedAt)}` : ""}. It stops before its next step and starts none until it is turned back on.`
                  : "The switch stops the sweep before its next step, even in the middle of a run."}
              </p>
              <div className="approval-actions">
                {controls.paused ? (
                  staff && (
                    <button type="button" className="button" disabled={busy} onClick={() => void act(() => pauseSweep(false), "The sweep is on again.")}>
                      Turn the sweep back on
                    </button>
                  )
                ) : (
                  <button type="button" className="button button-danger" disabled={busy} onClick={() => void act(() => pauseSweep(true), "The sweep is paused.")}>
                    Pause the sweep
                  </button>
                )}
              </div>
            </div>
          </section>

          {staff && (
            <section className="card">
              <div className="card-head">Run the sweep now</div>
              <div className="card-body editor-form">
                <label className="label" htmlFor="sweep-instruction">
                  Instruction for this run (optional)
                </label>
                <textarea
                  id="sweep-instruction"
                  className="inbox-note"
                  maxLength={500}
                  placeholder="For example: clear the pending sample requests."
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
                <label className="label" htmlFor="sweep-today">
                  Run as of (optional, to see a label that comes into force later)
                </label>
                <input id="sweep-today" className="inbox-note sweep-date" type="date" value={today} onChange={(event) => setToday(event.target.value)} />
                <div className="approval-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy || controls.paused}
                    onClick={() => void act(() => runSweepNow({ instruction: instruction.trim() || undefined, today: today || undefined }), "The sweep is queued. It starts within a few seconds.")}
                  >
                    Run it now
                  </button>
                </div>
              </div>
            </section>
          )}

          {notice && <p className="approval-note">{notice}</p>}
          <h2>Runs</h2>
          {view.runs.length === 0 ? <p className="inbox-empty">No runs yet. The first runs tonight at 02:00 UTC.</p> : view.runs.map((run) => <RunCard key={run.runId} run={run} />)}
        </>
      )}
    </main>
  );
}
