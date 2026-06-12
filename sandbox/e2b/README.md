# DataSwarm E2B Template

This directory defines the dedicated E2B template for DataSwarm branch agents.
It packages the canonical `sandbox/agent/dataswarm_sandbox_agent.py` runtime into
an E2B Code Interpreter image so real sandbox branches can import the same agent
protocol used by the local mock provider.

## Build

Run from the repository root after installing and authenticating the E2B CLI:

```bash
npx --yes @e2b/cli template create dataswarm-agent-runtime -p sandbox -d e2b/e2b.Dockerfile -c 'sudo /root/.jupyter/start-up.sh' --ready-cmd 'python -c "import urllib.request; urllib.request.urlopen(\"http://localhost:49999/health\", timeout=5).read()" && python /home/user/dataswarm/entrypoint.py --ready'
```

The explicit start command keeps the inherited Code Interpreter service online
for `@e2b/code-interpreter.runCode()`. The ready command checks both the
Jupyter-compatible service health endpoint on port `49999` and the DataSwarm
agent protocol readiness payload, so a template cannot be marked ready only
because `entrypoint.py --ready` imports successfully.

The runtime provider uses `dataswarm-agent-runtime` by default. Override it with
`DATASWARM_E2B_TEMPLATE`, `E2B_TEMPLATE_ID`, or `E2B_TEMPLATE`.

## Verification Receipt

Real Orchestrator branch execution requires both `E2B_API_KEY` and a template
verification receipt. After template build/readiness succeeds, prefer generating
the local receipt with:

```bash
node scripts/e2b-template-receipt.mjs --template-build-id <template-build-or-revision-id>
```

This script runs `node scripts/e2b-template-smoke.mjs` before writing the
receipt, records file hashes for the Dockerfile, entrypoint, and sandbox agent,
and defaults to `data/e2b/template-verification.json`. Use `--receipt <path>`
for a custom receipt path. If you only want to record local contract verification
without a remote template build id, pass `--allow-local-contract-only`
explicitly so the receipt metadata stays honest about its evidence level.

Operator-controlled environments can also record verification directly with:

- `DATASWARM_E2B_TEMPLATE_VERIFIED=1`
- `DATASWARM_E2B_TEMPLATE_BUILD_ID=<template-build-or-revision-id>`
- a local JSON receipt at `data/e2b/template-verification.json`, or a custom
  path via `DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT`

The local receipt must match the selected template exactly and include durable
evidence. A receipt for another template is ignored and keeps
`readyForOrchestrator=false`. Example:

```json
{
  "status": "ready",
  "template": "dataswarm-agent-runtime",
  "templateBuildId": "tmpl_build_20260611",
  "verifiedAt": "2026-06-11T00:00:00.000Z",
  "protocolVersion": "dataswarm.sandbox-agent.v1"
}
```

`/api/system/snapshot` exposes whether the template receipt and live smoke
receipt are present without leaking secrets. If the template receipt is missing
or mismatched, E2B branch execution fails at preflight and persists structured
`sandbox_preflight_failed` evidence instead of falling back to mock execution.
Conversation diagnostics and `trace.query` also summarize live smoke receipt
coverage from sandbox sessions, failed branch observations, and branch failure
events so operators can diagnose a specific conversation without inspecting raw
event JSON.

## Smoke

```bash
node scripts/e2b-template-smoke.mjs
node scripts/e2b-template-receipt-smoke.mjs
node scripts/e2b-readiness-smoke.mjs
node scripts/e2b-live-receipt-smoke.mjs
node scripts/e2b-sandbox-smoke.mjs
```

`e2b-template-smoke.mjs` validates the local template contract without creating
an external sandbox. `e2b-template-receipt-smoke.mjs` validates the controlled
receipt generation path and its negative gate. `e2b-readiness-smoke.mjs`
validates secret-safe readiness without creating a sandbox.
`e2b-live-receipt-smoke.mjs` validates the live smoke receipt contract without
creating a sandbox. `e2b-sandbox-smoke.mjs` creates a real E2B sandbox when
`E2B_API_KEY` is configured and writes a successful live receipt to
`data/e2b/live-smoke-receipt.json` by default. Use `--receipt <path>` or
`DATASWARM_E2B_LIVE_SMOKE_RECEIPT` to redirect that evidence file in CI.
