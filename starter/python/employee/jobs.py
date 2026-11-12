# The job table, saved in SQLite under STATE_DIR.
import json
import os
import sqlite3
import threading

_dir = os.environ.get("STATE_DIR", ".state")
os.makedirs(_dir, exist_ok=True)
_db = sqlite3.connect(os.path.join(_dir, "jobs.sqlite"), check_same_thread=False)
_db.row_factory = sqlite3.Row
_lock = threading.Lock()
_db.execute("CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, run_id TEXT, tenant TEXT, trigger TEXT, input TEXT, status TEXT, reason TEXT, cost_usd REAL)")


def _row(r):
    if r is None:
        return None
    d = dict(r)
    d["trigger"], d["input"] = json.loads(d["trigger"]), json.loads(d["input"])
    return d


class Jobs:
    def get(self, job_id):
        with _lock:
            return _row(_db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone())

    def all(self):
        with _lock:
            return [_row(r) for r in _db.execute("SELECT * FROM jobs").fetchall()]

    def add(self, job_id, run_id, tenant, trigger, input):
        with _lock:
            _db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)", (job_id, run_id, tenant, json.dumps(trigger), json.dumps(input), "working", None, 0))
            _db.commit()
        return self.get(job_id)

    def set(self, job_id, **patch):
        j = {**self.get(job_id), **patch}
        with _lock:
            _db.execute("UPDATE jobs SET status = ?, reason = ?, cost_usd = ? WHERE job_id = ?", (j["status"], j["reason"], j["cost_usd"], job_id))
            _db.commit()


jobs = Jobs()
