"""End-to-end smoke check: one real Claude call through a running Assistant Gateway.

WARNING: THIS SPENDS REAL MONEY. One tiny `claude-haiku-4-5` call, well under $0.01, charged to
the `connections-trial` monthly cap. Run it only with the owner's approval, against a gateway
that has the owner's ANTHROPIC_API_KEY configured.

Run (the gateway must already be up, e.g. `docker compose up assistant-gateway`):

    AG_SMOKE_KEY=<the connections-trial app key> \\
        uv run --project apps/assistant-gateway python apps/assistant-gateway/scripts/smoke.py \\
        [gateway-url]

The gateway URL defaults to http://127.0.0.1:8100. The app key is read only from the
AG_SMOKE_KEY environment variable and is never printed.

It sends one `POST /v1/llm/messages` on the `eval` use case (the key selects the
`connections-trial` app) and asks for `{"ok": true}` as structured output. It prints the HTTP
status, the output, `cost_usd`, the token usage (including the cache counters) and the month's
`GET /v1/usage` totals. Exit code 0 only when the output is `{"ok": true}` and `cost_usd > 0`.
"""

import json
import os
import sys
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

DEFAULT_URL = "http://127.0.0.1:8100"
TIMEOUT_SECONDS = 60.0

REQUEST_BODY: dict[str, Any] = {
    "use_case": "eval",
    "end_user_id": "smoke",
    "model": "claude-haiku-4-5",
    "system": "You are a test fixture. Answer with the requested JSON only.",
    "messages": [{"role": "user", "content": "Answer with ok set to true."}],
    "output_schema": {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
        "required": ["ok"],
        "additionalProperties": False,
    },
}


def main() -> int:
    key = os.environ.get("AG_SMOKE_KEY")
    if not key:
        print(
            "AG_SMOKE_KEY is not set: export the connections-trial app key first.", file=sys.stderr
        )
        return 2
    base_url = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL).rstrip("/")
    headers = {"Authorization": f"Bearer {key}"}

    try:
        with httpx.Client(base_url=base_url, headers=headers, timeout=TIMEOUT_SECONDS) as client:
            reply = client.post("/v1/llm/messages", json=REQUEST_BODY)
            print(f"POST /v1/llm/messages -> HTTP {reply.status_code}")
            ok = report_call(reply)
            period = datetime.now(ZoneInfo("Africa/Cairo")).strftime("%Y-%m")
            report_usage(client, period)
    except httpx.HTTPError as error:
        print(f"Could not reach the gateway at {base_url}: {type(error).__name__}", file=sys.stderr)
        return 2

    print("RESULT: PASS" if ok else "RESULT: FAIL")
    return 0 if ok else 1


def report_call(reply: httpx.Response) -> bool:
    """Print what the call returned; True only for output {"ok": true} with cost_usd > 0."""
    body = parse_json(reply)
    if reply.status_code != 200 or not isinstance(body, dict):
        print(f"error: {json.dumps(body)}")
        if isinstance(body, dict) and body.get("code") == "provider_unavailable":
            print(
                "The gateway could not reach Claude (provider_unavailable). Check that "
                "ANTHROPIC_API_KEY is set for the gateway and valid; see GET /v1/usage below."
            )
        return False

    usage = body.get("usage", {})
    cost = body.get("cost_usd")
    print(f"model: {body.get('model')}")
    print(f"output: {json.dumps(body.get('output'))}")
    print(f"cost_usd: {cost}")
    print(
        "usage: "
        f"input_tokens={usage.get('input_tokens')} "
        f"output_tokens={usage.get('output_tokens')} "
        f"cache_creation_input_tokens={usage.get('cache_creation_input_tokens')} "
        f"cache_read_input_tokens={usage.get('cache_read_input_tokens')}"
    )
    print(f"budget: {json.dumps(body.get('budget'))}")
    return body.get("output") == {"ok": True} and isinstance(cost, int | float) and cost > 0


def report_usage(client: httpx.Client, period: str) -> None:
    reply = client.get("/v1/usage", params={"period": period})
    print(f"GET /v1/usage?period={period} -> HTTP {reply.status_code}")
    body = parse_json(reply)
    if reply.status_code != 200 or not isinstance(body, dict):
        print(f"error: {json.dumps(body)}")
        return
    print(f"totals: settled_usd={body['settled_usd']} reserved_usd={body['reserved_usd']}")
    for row in body.get("by_use_case", []):
        print(
            f"  {row['use_case']} ({row['kind']}): calls={row['calls']} "
            f"settled_usd={row['settled_usd']} reserved_usd={row['reserved_usd']}"
        )


def parse_json(reply: httpx.Response) -> object:
    try:
        return reply.json()
    except ValueError:
        return {"unparsable_body": reply.text[:200]}


if __name__ == "__main__":
    sys.exit(main())
