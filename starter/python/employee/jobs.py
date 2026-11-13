# The job table, saved in SQLite under STATE_DIR.
import json
import os
import sqlite3
import threading

_state_dir = os.environ.get("STATE_DIR", ".state")
os.makedirs(_state_dir, exist_ok=True)
_db = sqlite3.connect(os.path.join(_state_dir, "jobs.sqlite"), check_same_thread=False)
_db.row_factory = sqlite3.Row
# The server answers on one thread while jobs run on others, so one lock guards the table.
_lock = threading.Lock()
_db.execute(
    "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT, "
    "trigger TEXT, input TEXT, status TEXT, reason TEXT, cost_usd REAL)"
)


# SQLite keeps the trigger and the input as JSON text.
def _to_job(row):
    if row is None:
        return None
    job = dict(row)
    job["trigger"] = json.loads(job["trigger"])
    job["input"] = json.loads(job["input"])
    return job


class Jobs:
    def get(self, job_id):
        with _lock:
            row = _db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        return _to_job(row)

    def all(self):
        with _lock:
            rows = _db.execute("SELECT * FROM jobs").fetchall()
        return [_to_job(row) for row in rows]

    def add(self, new_job):
        values = (
            new_job["job_id"],
            new_job["run_id"],
            new_job["tenant"],
            json.dumps(new_job["trigger"]),
            json.dumps(new_job["input"]),
            "working",
            None,
            0,
        )
        with _lock:
            _db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)", values)
            _db.commit()
        return self.get(new_job["job_id"])

    def set(self, job_id, **changes):
        job = {**self.get(job_id), **changes}
        with _lock:
            _db.execute(
                "UPDATE jobs SET status = ?, reason = ?, cost_usd = ? WHERE job_id = ?",
                (job["status"], job["reason"], job["cost_usd"], job_id),
            )
            _db.commit()


jobs = Jobs()
