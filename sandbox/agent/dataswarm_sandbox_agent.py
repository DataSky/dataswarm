#!/usr/bin/env python3
"""DataSwarm sandbox branch agent.

This file is intentionally dependency-light so it can run both locally and in
an E2B code-interpreter sandbox. It defines the branch-agent wire protocol used
by the parent Orchestrator: JSON job in, NDJSON progress events out, final JSON
result on the last line.
"""

from __future__ import annotations

import hashlib
import base64
import math
import json
import os
import sys
import urllib.error
import urllib.request
from io import BytesIO
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List


PROTOCOL_VERSION = "dataswarm.sandbox-agent.v1"
SANDBOX_RUNTIME_VERSION = "dataswarm.sandbox-runtime.v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(event_type: str, message: str, payload: Dict[str, Any] | None = None) -> None:
    record = {
        "protocolVersion": PROTOCOL_VERSION,
        "type": event_type,
        "level": "info",
        "message": message,
        "timestamp": utc_now(),
        "payload": payload or {},
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)


def emit_heartbeat(branch_id: str, stage: str, sequence: int, payload: Dict[str, Any] | None = None) -> None:
    emit(
        "sandbox.agent.heartbeat",
        f"Sandbox branch heartbeat: {stage}.",
        {
            "branchId": branch_id,
            "stage": stage,
            "sequence": sequence,
            **(payload or {}),
        },
    )


def emit_action(action_id: str, action_type: str, status: str, message: str, payload: Dict[str, Any] | None = None) -> None:
    emit(
        f"sandbox.agent.action_{status}",
        message,
        {
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "actionId": action_id,
            "actionType": action_type,
            "status": status,
            **(payload or {}),
        },
    )


def emit_observation(
    observation_id: str,
    action_id: str,
    source_type: str,
    summary: str,
    payload: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    observation = {
        "observationId": observation_id,
        "actionId": action_id,
        "sourceType": source_type,
        "summary": summary,
        "payload": payload or {},
    }
    emit(
        "sandbox.agent.observation_created",
        summary,
        {
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            **observation,
        },
    )
    return observation


def read_job() -> Dict[str, Any]:
    raw = os.environ.get("DATASWARM_AGENT_JOB_JSON")
    if raw is None:
        raw = sys.stdin.read()
    raw = raw.strip()
    if not raw:
        raise ValueError("Missing sandbox agent job JSON")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Sandbox agent job must be a JSON object")
    return parsed


def as_text(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return fallback
    return str(value)


def tokenize(text: str) -> List[str]:
    normalized = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    return [item for item in normalized.split() if len(item) >= 3]


def top_terms(texts: Iterable[str], limit: int = 8) -> List[str]:
    counts: Dict[str, int] = {}
    for text in texts:
        for token in tokenize(text):
            counts[token] = counts.get(token, 0) + 1
    return [term for term, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def build_markdown(
    job: Dict[str, Any],
    terms: List[str],
    model_result: Dict[str, Any],
    action_log: List[Dict[str, Any]],
    observations: List[Dict[str, Any]],
) -> str:
    branch_id = as_text(job.get("branchId"), "branch_unknown")
    agent_name = as_text(job.get("agentName"), "Sandbox Branch Agent")
    model_profile = as_text(job.get("modelProfile"), "model:unknown")
    objective = as_text(job.get("objective"), "No objective provided")
    instruction = as_text(job.get("instruction"), "No instruction provided")
    context_bundle_uri = as_text(job.get("contextBundleUri"), "local://context/unknown")
    execution_mode = as_text(job.get("executionMode"), "sandbox")

    checks = [
        "Input job parsed and validated.",
        "Branch objective and instruction converted into an isolated result artifact.",
        "No secret values were emitted in the branch result.",
    ]
    model_used = model_result.get("status") == "completed"
    analysis = as_text(
        model_result.get("content"),
        (
            "This branch prepared an isolated execution result from the provided context bundle. "
            "The current sandbox agent is deterministic; future E2B templates can replace the "
            "analysis core with a DeepSeek-powered DataSwarm agent while keeping this protocol stable."
        ),
    )

    return "\n".join(
        [
            f"# {agent_name}",
            "",
            f"- Branch ID: `{branch_id}`",
            f"- Model profile: `{model_profile}`",
            f"- Execution mode: `{execution_mode}`",
            f"- Context bundle: `{context_bundle_uri}`",
            f"- Protocol: `{PROTOCOL_VERSION}`",
            "",
            "## Objective",
            "",
            objective,
            "",
            "## Branch Instruction",
            "",
            instruction,
            "",
            "## Branch Analysis",
            "",
            analysis,
            "",
            "## Model Execution",
            "",
            f"- Mode: `{as_text(model_result.get('mode'), 'deterministic')}`",
            f"- Status: `{as_text(model_result.get('status'), 'fallback')}`",
            f"- Model: `{as_text(model_result.get('model'), model_profile)}`",
            f"- Used real model: `{str(model_used).lower()}`",
            "",
            "## Extracted Focus Terms",
            "",
            ", ".join(terms) if terms else "No salient terms extracted.",
            "",
            "## Sandbox Runtime Loop",
            "",
            f"- Runtime: `{SANDBOX_RUNTIME_VERSION}`",
            f"- Actions: `{len(action_log)}`",
            f"- Observations: `{len(observations)}`",
            "",
            *[f"- `{item['actionId']}` {item['actionType']} -> {item['status']}" for item in action_log],
            "",
            "## Validation Notes",
            "",
            *[f"- {check}" for check in checks],
        ]
    )


def run_model_if_configured(job: Dict[str, Any]) -> Dict[str, Any]:
    config = job.get("sandboxModel")
    if not isinstance(config, dict) or config.get("mode") != "real":
        emit("sandbox.agent.model_skipped", "Sandbox model call skipped; deterministic mode active.", {"mode": "deterministic"})
        return {"mode": "deterministic", "status": "skipped", "model": as_text(job.get("modelProfile"))}

    api_key_env = as_text(config.get("apiKeyEnv"), "DEEPSEEK_API_KEY")
    base_url_env = as_text(config.get("baseUrlEnv"), "DEEPSEEK_BASE_URL")
    api_key = os.environ.get(api_key_env, "")
    base_url = os.environ.get(base_url_env, as_text(config.get("baseUrl"), "")).rstrip("/")
    model = as_text(config.get("model"), as_text(job.get("modelProfile")).split(":")[-1])
    auth_scheme = as_text(config.get("authScheme"), "raw").lower()
    if not api_key or not base_url:
        emit(
            "sandbox.agent.model_skipped",
            "Sandbox model credentials are unavailable; deterministic fallback active.",
            {"apiKeyEnv": api_key_env, "baseUrlEnv": base_url_env, "model": model},
        )
        return {"mode": "real", "status": "skipped_missing_credentials", "model": model}

    messages = [
        {
            "role": "system",
            "content": (
                "You are a DataSwarm sandbox branch agent. Produce concise, evidence-aware branch analysis. "
                "Do not invent external facts or unobserved context bundle contents. "
                "Reason only from the supplied objective, instruction, context bundle URI, and runtime facts in this prompt."
            ),
        },
        {
            "role": "user",
            "content": "\n\n".join(
                [
                    f"Objective: {as_text(job.get('objective'))}",
                    f"Branch instruction: {as_text(job.get('instruction'))}",
                    f"Context bundle URI: {as_text(job.get('contextBundleUri'))}",
                    "Runtime fact: if you are producing this response, the configured sandbox model call returned text successfully.",
                    "Do not claim the context bundle contains evidence unless its contents are explicitly provided above.",
                ]
            ),
        },
    ]
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": int(config.get("maxTokens") or 900),
    }
    emit("sandbox.agent.model_call_started", "Sandbox model call started.", {"model": model})
    authorization = f"Bearer {api_key}" if auth_scheme == "bearer" else api_key
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": authorization, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=int(config.get("timeoutSeconds") or 60)) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
        content = extract_model_content(parsed)
        if not isinstance(content, str) or not content.strip():
            emit(
                "sandbox.agent.model_response_unusable",
                "Sandbox model response did not contain usable text content.",
                {
                    "topLevelKeys": list(parsed.keys())[:12] if isinstance(parsed, dict) else [],
                    "choiceKeys": list(parsed.get("choices", [{}])[0].keys())[:12]
                    if isinstance(parsed, dict) and isinstance(parsed.get("choices"), list) and parsed.get("choices")
                    else [],
                },
            )
            raise ValueError("Sandbox model response did not contain usable text content")
        emit("sandbox.agent.model_call_completed", "Sandbox model call completed.", {"model": model, "bytes": len(content.encode("utf-8"))})
        return {"mode": "real", "status": "completed", "model": model, "content": content.strip()}
    except urllib.error.HTTPError as exc:
        body_preview = ""
        try:
            body_preview = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body_preview = ""
        emit(
            "sandbox.agent.model_call_failed",
            "Sandbox model call failed; deterministic fallback active.",
            {"model": model, "errorType": "HTTPError", "httpStatus": exc.code, "bodyPreview": body_preview},
        )
        return {
            "mode": "real",
            "status": "failed_fallback",
            "model": model,
            "errorType": "HTTPError",
            "httpStatus": exc.code,
        }
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        emit("sandbox.agent.model_call_failed", "Sandbox model call failed; deterministic fallback active.", {"model": model, "errorType": exc.__class__.__name__})
        return {"mode": "real", "status": "failed_fallback", "model": model, "errorType": exc.__class__.__name__}


def extract_model_content(parsed: Dict[str, Any]) -> str:
    choices = parsed.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content") or message.get("reasoning_content")
                if isinstance(content, str) and content.strip():
                    return content
            text = first.get("text")
            if isinstance(text, str) and text.strip():
                return text
    for key in ("answer", "output", "content", "text"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def wants_plot_artifact(job: Dict[str, Any], terms: List[str]) -> bool:
    text = " ".join([as_text(job.get("objective")), as_text(job.get("instruction")), " ".join(terms)]).lower()
    return any(
        token in text
        for token in ["sin", "cos", "tan", "plot", "matplotlib", "png", "image", "图片", "图像", "绘制", "画图"]
    )


def detect_plot_function(job: Dict[str, Any], terms: List[str]) -> str | None:
    text = " ".join([as_text(job.get("objective")), as_text(job.get("instruction")), " ".join(terms)]).lower()
    function_markers = [
        ("sin", ["sin", "sine", "正弦"]),
        ("cos", ["cos", "cosine", "余弦"]),
        ("tan", ["tan", "tangent", "正切"]),
    ]
    for function_name, markers in function_markers:
        if any(marker in text for marker in markers):
            return function_name
    return None


def build_plot_image_artifact(job: Dict[str, Any], branch_id: str, agent_name: str) -> Dict[str, Any] | None:
    function_name = detect_plot_function(job, [])
    if not function_name:
        return None
    function_label = f"f(x)={function_name}(x)"
    title = f"{agent_name} {function_label} Plot"
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np

        x = np.linspace(-2 * np.pi, 2 * np.pi, 500)
        if function_name == "cos":
            y = np.cos(x)
        elif function_name == "tan":
            y = np.clip(np.tan(x), -4, 4)
        else:
            y = np.sin(x)
        fig, ax = plt.subplots(figsize=(8, 4.5), dpi=140)
        ax.plot(x, y, color="#0f766e", linewidth=2.4, label=function_label)
        ax.axhline(0, color="#94a3b8", linewidth=0.8)
        ax.axvline(0, color="#94a3b8", linewidth=0.8)
        ax.grid(True, color="#e2e8f0", linewidth=0.8)
        ax.set_title(function_label)
        ax.set_xlabel("x")
        ax.set_ylabel("f(x)")
        if function_name == "tan":
            ax.set_ylim(-4.25, 4.25)
        ax.legend(loc="upper right")
        fig.tight_layout()
        buffer = BytesIO()
        fig.savefig(buffer, format="png", bbox_inches="tight")
        plt.close(fig)
        content = buffer.getvalue()
        mime_type = "image/png"
        filename = f"{function_name}-plot.png"
    except Exception as exc:
        emit(
            "sandbox.agent.image_fallback",
            "Matplotlib image generation failed; generated SVG fallback.",
            {"errorType": exc.__class__.__name__},
        )
        content = build_trig_svg(function_name).encode("utf-8")
        mime_type = "image/svg+xml"
        filename = f"{function_name}-plot.svg"

    digest = hashlib.sha256(content).hexdigest()
    return {
        "kind": "image",
        "title": title,
        "mimeType": mime_type,
        "filename": filename,
        "sha256": digest,
        "bytes": len(content),
        "contentBase64": base64.b64encode(content).decode("ascii"),
        "metadata": {
            "branchId": branch_id,
            "plotFunction": function_label,
            "xRange": "[-2π, 2π]",
        },
    }


def build_trig_svg(function_name: str) -> str:
    width = 960
    height = 540
    margin = 64
    points = []
    for i in range(400):
        x = -2 * math.pi + (4 * math.pi * i / 399)
        if function_name == "cos":
            y = math.cos(x)
        elif function_name == "tan":
            y = max(min(math.tan(x), 4), -4) / 4
        else:
            y = math.sin(x)
        px = margin + ((x + 2 * math.pi) / (4 * math.pi)) * (width - 2 * margin)
        py = height / 2 - y * ((height - 2 * margin) / 2)
        points.append(f"{px:.2f},{py:.2f}")
    function_label = f"f(x)={function_name}(x)"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{margin}" y="42" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#17202a">{function_label}</text>
  <line x1="{margin}" y1="{height/2}" x2="{width-margin}" y2="{height/2}" stroke="#94a3b8" stroke-width="1"/>
  <line x1="{width/2}" y1="{margin}" x2="{width/2}" y2="{height-margin}" stroke="#94a3b8" stroke-width="1"/>
  <polyline fill="none" stroke="#0f766e" stroke-width="4" points="{' '.join(points)}"/>
  <text x="{width-margin-130}" y="{height-margin+36}" font-family="Arial, sans-serif" font-size="16" fill="#64748b">x in [-2π, 2π]</text>
</svg>"""


def run() -> Dict[str, Any]:
    job = read_job()
    branch_id = as_text(job.get("branchId"), "branch_unknown")
    agent_name = as_text(job.get("agentName"), "Sandbox Branch Agent")
    action_log: List[Dict[str, Any]] = []
    observations: List[Dict[str, Any]] = []

    def record_action(action_id: str, action_type: str, status: str, message: str, payload: Dict[str, Any] | None = None) -> None:
        action_log.append({"actionId": action_id, "actionType": action_type, "status": status})
        emit_action(action_id, action_type, status, message, {"branchId": branch_id, **(payload or {})})

    def record_observation(
        observation_id: str,
        action_id: str,
        source_type: str,
        summary: str,
        payload: Dict[str, Any] | None = None,
    ) -> None:
        observations.append(
            emit_observation(observation_id, action_id, source_type, summary, {"branchId": branch_id, **(payload or {})})
        )

    emit("sandbox.agent.started", f"{agent_name} started.", {"branchId": branch_id})
    emit_heartbeat(branch_id, "started", 1)
    record_action(
        "sba_validate_job",
        "validate_job",
        "proposed",
        "Sandbox agent proposed job validation.",
    )
    required = ["branchId", "agentName", "modelProfile", "objective", "instruction", "contextBundleUri"]
    missing = [field for field in required if not as_text(job.get(field))]
    if missing:
        emit("sandbox.agent.validation_failed", "Sandbox job is missing required fields.", {"missing": missing})
        raise ValueError(f"Sandbox job missing required fields: {', '.join(missing)}")
    record_action(
        "sba_validate_job",
        "validate_job",
        "completed",
        "Sandbox job validation completed.",
        {"requiredFields": required},
    )
    record_observation(
        "sbo_job_valid",
        "sba_validate_job",
        "runtime",
        "Sandbox job contains all required fields.",
        {"requiredFieldsPresent": True},
    )

    emit(
        "sandbox.agent.context_loaded",
        "Sandbox branch context loaded.",
        {"contextBundleUri": as_text(job.get("contextBundleUri"))},
    )
    emit_heartbeat(branch_id, "context_loaded", 2, {"contextBundleUri": as_text(job.get("contextBundleUri"))})
    record_action(
        "sba_extract_focus",
        "extract_focus_terms",
        "proposed",
        "Sandbox agent proposed focus-term extraction.",
    )
    terms = top_terms([as_text(job.get("objective")), as_text(job.get("instruction"))])
    record_action(
        "sba_extract_focus",
        "extract_focus_terms",
        "completed",
        "Sandbox focus-term extraction completed.",
        {"focusTerms": terms},
    )
    record_observation(
        "sbo_focus_terms",
        "sba_extract_focus",
        "analysis",
        "Sandbox extracted branch focus terms.",
        {"focusTerms": terms},
    )
    record_action(
        "sba_model_analysis",
        "model_analysis",
        "proposed",
        "Sandbox agent proposed model or deterministic analysis.",
    )
    model_result = run_model_if_configured(job)
    record_action(
        "sba_model_analysis",
        "model_analysis",
        "completed",
        "Sandbox model analysis step completed.",
        {
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
        },
    )
    record_observation(
        "sbo_model_analysis",
        "sba_model_analysis",
        "model" if model_result.get("status") == "completed" else "deterministic",
        "Sandbox model or deterministic analysis result is available.",
        {
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
            "modelUsed": model_result.get("status") == "completed",
        },
    )
    emit_heartbeat(
        branch_id,
        "model_completed",
        3,
        {
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
        },
    )
    record_action(
        "sba_prepare_artifact",
        "prepare_artifact",
        "proposed",
        "Sandbox agent proposed branch artifact preparation.",
    )
    output_markdown = build_markdown(
        job,
        terms,
        model_result,
        [
            *action_log,
            {"actionId": "sba_prepare_artifact", "actionType": "prepare_artifact", "status": "completed"},
        ],
        [
            *observations,
            {
                "observationId": "sbo_artifact_ready",
                "actionId": "sba_prepare_artifact",
                "sourceType": "artifact",
                "summary": "Sandbox branch artifact is ready for parent recovery.",
                "payload": {},
            },
        ],
    )
    image_artifacts: List[Dict[str, Any]] = []
    if wants_plot_artifact(job, terms):
        image_artifact = build_plot_image_artifact(job, branch_id, agent_name)
        if image_artifact:
            image_artifacts.append(image_artifact)
            output_markdown += (
                "\n\n## Generated Image Artifact\n\n"
                f"- Title: {image_artifact['title']}\n"
                f"- MIME: {image_artifact['mimeType']}\n"
                f"- SHA256: `{image_artifact['sha256']}`\n"
                f"- Bytes: {image_artifact['bytes']}\n"
            )
    output_hash = hashlib.sha256(output_markdown.encode("utf-8")).hexdigest()
    manifest_artifacts = [
        {
            "kind": "markdown",
            "title": f"{agent_name} Result",
            "sha256": output_hash,
            "bytes": len(output_markdown.encode("utf-8")),
        },
        *image_artifacts,
    ]
    record_action(
        "sba_prepare_artifact",
        "prepare_artifact",
        "completed",
        "Sandbox branch artifact preparation completed.",
        {
            "sha256": output_hash,
            "bytes": len(output_markdown.encode("utf-8")),
            "artifactCount": len(manifest_artifacts),
            "imageArtifactCount": len(image_artifacts),
        },
    )
    record_observation(
        "sbo_artifact_ready",
        "sba_prepare_artifact",
        "artifact",
        "Sandbox branch artifact is ready for parent recovery.",
        {
            "sha256": output_hash,
            "bytes": len(output_markdown.encode("utf-8")),
            "artifactCount": len(manifest_artifacts),
            "imageArtifactCount": len(image_artifacts),
        },
    )

    emit(
        "sandbox.agent.artifact_prepared",
        "Sandbox branch artifact prepared.",
        {"sha256": output_hash, "bytes": len(output_markdown.encode("utf-8")), "artifactCount": len(manifest_artifacts)},
    )
    emit(
        "sandbox.agent.artifact_recovery_manifest",
        "Sandbox branch artifact recovery manifest prepared.",
        {
            "branchId": branch_id,
            "artifacts": manifest_artifacts,
        },
    )
    emit_heartbeat(branch_id, "artifact_prepared", 4, {"sha256": output_hash, "artifactCount": len(manifest_artifacts)})

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "status": "completed",
        "branchId": branch_id,
        "outputMarkdown": output_markdown,
        "outputSummary": f"{agent_name} completed branch {branch_id} with protocol {PROTOCOL_VERSION}.",
        "qualitySignals": {
            "requiredFieldsPresent": True,
            "focusTerms": terms,
            "contentSha256": output_hash,
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "actionCount": len(action_log),
            "observationCount": len(observations),
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
            "modelUsed": model_result.get("status") == "completed",
            "heartbeatCount": 4,
            "artifactRecoveryReady": True,
            "imageArtifactCount": len(image_artifacts),
        },
        "artifacts": manifest_artifacts,
        "runtime": {
            "version": SANDBOX_RUNTIME_VERSION,
            "actions": action_log,
            "observations": observations,
        },
    }


def main() -> int:
    try:
        result = run()
        emit("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"]})
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:  # pragma: no cover - exercised by smoke failures.
        emit("sandbox.agent.failed", str(exc), {"errorType": exc.__class__.__name__})
        print(
            json.dumps(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "status": "failed",
                    "error": str(exc),
                    "errorType": exc.__class__.__name__,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
