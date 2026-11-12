# Write employee.trace/v1: one span per line in TRACE_DIR/<run_id>.jsonl. See reference/CONTRACT.md.
import contextlib
import json
import os
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Tracer:
    def __init__(self, run_id):
        self.run_id = run_id
        self.dir = os.environ.get("TRACE_DIR", "traces")
        os.makedirs(self.dir, exist_ok=True)
        self.n = 0

    @contextlib.contextmanager
    def span(self, name, parent, attributes):
        self.n += 1
        span_id = f"{self.run_id}-{self.n}"
        attrs = {"gen_ai.operation.name": name, **attributes}
        start, status = _now(), "ok"
        try:
            yield span_id, attrs
        except Exception as e:
            status, attrs["error.type"] = "error", str(e)
            raise
        finally:
            line = {"format": "employee.trace/v1", "trace_id": self.run_id, "span_id": span_id, "parent_span_id": parent,
                    "name": name, "start_time": start, "end_time": _now(), "status": status, "attributes": attrs}
            with open(os.path.join(self.dir, f"{self.run_id}.jsonl"), "a") as f:
                f.write(json.dumps(line) + "\n")
