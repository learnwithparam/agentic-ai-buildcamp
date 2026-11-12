# One model call, by role. The provider comes from LLM_PROVIDER (replay, anthropic, openrouter or openai) and the
# model id from config/models.ts in the course repo, so a swap is one setting. Replay, the default, makes no call:
# the agent carries on without a draft.
import json
import os
import pathlib
import re
import urllib.request

KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openrouter": "OPENROUTER_API_KEY", "openai": "OPENAI_API_KEY"}
CHAT_URL = {"openrouter": "https://openrouter.ai/api/v1/chat/completions", "openai": "https://api.openai.com/v1/chat/completions"}


def provider():
    if os.environ.get("MODEL_MODE") == "replay":
        return "replay"
    p = os.environ.get("LLM_PROVIDER", "replay").strip().lower()
    if p != "replay" and p not in KEY_ENV:
        raise RuntimeError(f'LLM_PROVIDER is "{p}". Set it to one of: replay, anthropic, openrouter, openai.')
    return p


def can_ask():
    return provider() != "replay"


def model_id(role="fast", p=None):
    p = p or provider()
    for d in pathlib.Path(__file__).resolve().parents:
        cfg = d / "config" / "models.ts"
        if cfg.exists():
            block = re.search(rf"^\s*{p}:\s*\{{([^}}]*)\}}", cfg.read_text(), re.M)
            m = block and re.search(rf'{role}:\s*"([^"]+)"', block.group(1))
            if m:
                return m.group(1)
    raise RuntimeError("keep this employee inside the course repo so config/models.ts is found")


def ask(system, user, role="fast"):
    p = provider()
    if p == "replay":
        return None
    key = os.environ.get(KEY_ENV[p])
    if not key:
        raise RuntimeError(f"LLM_PROVIDER is {p} but {KEY_ENV[p]} is not set. Put it in .env (see .env.example).")
    model = model_id(role, p)
    if p == "anthropic":
        import anthropic

        r = anthropic.Anthropic(api_key=key).messages.create(model=model, max_tokens=400, system=system, messages=[{"role": "user", "content": user}])
        text = "".join(getattr(c, "text", "") for c in r.content)
        return {"model": model, "text": text, "input_tokens": r.usage.input_tokens, "output_tokens": r.usage.output_tokens}
    body = json.dumps({"model": model, "max_tokens": 400, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(CHAT_URL[p], data=body, headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        b = json.load(res)
    return {"model": model, "text": b["choices"][0]["message"]["content"] or "", "input_tokens": b["usage"]["prompt_tokens"], "output_tokens": b["usage"]["completion_tokens"]}
