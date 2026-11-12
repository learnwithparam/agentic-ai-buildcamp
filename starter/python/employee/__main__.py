# Start the contract server: uv run python -m employee
import os

import uvicorn

from employee.server import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7701"))
    print(f"freight-audit-clerk answers contract 1 on http://localhost:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
