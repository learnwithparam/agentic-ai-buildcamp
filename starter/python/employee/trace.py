# Write employee.trace/v1: one span per line in TRACE_DIR/<run_id>.jsonl.
# See reference/CONTRACT.md.
import contextlib
import json
import os
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Tracer:
    def __init__(self, run_id):
        self.run_id = run_id
        self.trace_dir = os.environ.get("TRACE_DIR", "traces")
        os.makedirs(self.trace_dir, exist_ok=True)
        self.span_count = 0

    # Run the block inside one span, and write the span down even when the block raises.
    @contextlib.contextmanager
    def span(self, name, parent_id, attributes):
        self.span_count += 1
        span_id = f"{self.run_id}-{self.span_count}"
        all_attributes = {"gen_ai.operation.name": name, **attributes}
        start_time = _now()
        status = "ok"
        try:
            yield span_id, all_attributes
        except Exception as error:
            status = "error"
            all_attributes["error.type"] = str(error)
            raise
        finally:
            line = {
                "format": "employee.trace/v1",
                "trace_id": self.run_id,
                "span_id": span_id,
                "parent_span_id": parent_id,
                "name": name,
                "start_time": start_time,
                "end_time": _now(),
                "status": status,
                "attributes": all_attributes,
            }
            trace_file_path = os.path.join(self.trace_dir, f"{self.run_id}.jsonl")
            with open(trace_file_path, "a") as trace_file:
                trace_file.write(json.dumps(line) + "\n")
