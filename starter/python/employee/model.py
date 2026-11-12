# One model call. The model id comes from config/models.ts in the course repo, or from MODEL.
# No key, no call: the agent carries on without a draft.
import os
import pathlib
import re


def can_ask():
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("MODEL_MODE") != "replay"


def model_id():
    if os.environ.get("MODEL"):
        return os.environ["MODEL"]
    for d in pathlib.Path(__file__).resolve().parents:
        cfg = d / "config" / "models.ts"
        if cfg.exists():
            m = re.search(r'default:\s*process\.env\.MODEL\s*\?\?\s*"([^"]+)"', cfg.read_text())
            if m:
                return m.group(1)
    raise RuntimeError("set MODEL, or keep this employee inside the course repo so config/models.ts is found")


def ask(system, user):
    if not can_ask():
        return None
    import anthropic

    model = model_id()
    r = anthropic.Anthropic().messages.create(model=model, max_tokens=400, system=system, messages=[{"role": "user", "content": user}])
    text = "".join(getattr(c, "text", "") for c in r.content)
    return {"model": model, "text": text, "input_tokens": r.usage.input_tokens, "output_tokens": r.usage.output_tokens}
