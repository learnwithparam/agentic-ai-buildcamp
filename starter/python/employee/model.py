# One model call, by role. The provider comes from LLM_PROVIDER (replay, anthropic, openrouter or
# openai) and the model id from config/models.ts in the course repo, so a swap is one setting.
# Replay, the default, makes no call: the agent carries on without a draft.
import json
import os
import pathlib
import re
import urllib.request

KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "openai": "OPENAI_API_KEY",
}
CHAT_URL = {
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
    "openai": "https://api.openai.com/v1/chat/completions",
}


def provider():
    if os.environ.get("MODEL_MODE") == "replay":
        return "replay"
    provider_name = os.environ.get("LLM_PROVIDER", "replay").strip().lower()
    if provider_name != "replay" and provider_name not in KEY_ENV:
        raise RuntimeError(
            f'LLM_PROVIDER is "{provider_name}". '
            "Set it to one of: replay, anthropic, openrouter, openai."
        )
    return provider_name


def can_ask():
    return provider() != "replay"


# Walk up from this file until a folder holds config/models.ts, then read the model id from it.
def model_id(role="fast", provider_name=None):
    provider_name = provider_name or provider()
    for folder in pathlib.Path(__file__).resolve().parents:
        models_file = folder / "config" / "models.ts"
        if models_file.exists():
            provider_pattern = rf"^\s*{provider_name}:\s*\{{([^}}]*)\}}"
            provider_block = re.search(provider_pattern, models_file.read_text(), re.M)
            role_match = provider_block and re.search(
                rf'{role}:\s*"([^"]+)"', provider_block.group(1)
            )
            if role_match:
                return role_match.group(1)
    raise RuntimeError("keep this employee inside the course repo so config/models.ts is found")


def ask(system, user, role="fast"):
    provider_name = provider()
    if provider_name == "replay":
        return None
    key = os.environ.get(KEY_ENV[provider_name])
    if not key:
        raise RuntimeError(
            f"LLM_PROVIDER is {provider_name} but {KEY_ENV[provider_name]} is not set. "
            "Put it in .env (see .env.example)."
        )
    model = model_id(role, provider_name)
    if provider_name == "anthropic":
        return _ask_anthropic(key, model, system, user)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    return _ask_chat_completions(CHAT_URL[provider_name], key, model, messages)


def _ask_anthropic(key, model, system, user):
    import anthropic

    reply = anthropic.Anthropic(api_key=key).messages.create(
        model=model,
        max_tokens=400,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(getattr(block, "text", "") for block in reply.content)
    return {
        "model": model,
        "text": text,
        "input_tokens": reply.usage.input_tokens,
        "output_tokens": reply.usage.output_tokens,
    }


# OpenRouter and OpenAI both answer the same chat completions request.
def _ask_chat_completions(url, key, model, messages):
    body = json.dumps({"model": model, "max_tokens": 400, "messages": messages}).encode()
    headers = {"content-type": "application/json", "authorization": f"Bearer {key}"}
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        reply = json.load(response)
    return {
        "model": model,
        "text": reply["choices"][0]["message"]["content"] or "",
        "input_tokens": reply["usage"]["prompt_tokens"],
        "output_tokens": reply["usage"]["completion_tokens"],
    }
