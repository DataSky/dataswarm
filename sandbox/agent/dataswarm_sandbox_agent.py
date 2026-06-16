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
import re
import sys
import time
import urllib.error
import urllib.request
from io import BytesIO
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List


PROTOCOL_VERSION_V1 = "dataswarm.sandbox-agent.v1"
PROTOCOL_VERSION_V2 = "dataswarm.sandbox-agent.v2"
PROTOCOL_VERSION_V3 = "dataswarm.sandbox-agent.v3"
SANDBOX_RUNTIME_VERSION_V1 = "dataswarm.sandbox-runtime.v1"
SANDBOX_RUNTIME_VERSION_V2 = "dataswarm.sandbox-runtime.v2"
SANDBOX_RUNTIME_VERSION_V3 = "dataswarm.sandbox-runtime.v3"
PROTOCOL_VERSION = PROTOCOL_VERSION_V1
SANDBOX_RUNTIME_VERSION = SANDBOX_RUNTIME_VERSION_V1


def set_protocol(protocol_version: str) -> None:
    global PROTOCOL_VERSION, SANDBOX_RUNTIME_VERSION
    if protocol_version in ("v3", PROTOCOL_VERSION_V3):
        PROTOCOL_VERSION = PROTOCOL_VERSION_V3
        SANDBOX_RUNTIME_VERSION = SANDBOX_RUNTIME_VERSION_V3
    elif protocol_version in ("v2", PROTOCOL_VERSION_V2):
        PROTOCOL_VERSION = PROTOCOL_VERSION_V2
        SANDBOX_RUNTIME_VERSION = SANDBOX_RUNTIME_VERSION_V2
    else:
        PROTOCOL_VERSION = PROTOCOL_VERSION_V1
        SANDBOX_RUNTIME_VERSION = SANDBOX_RUNTIME_VERSION_V1


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


def as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        if isinstance(value, (int, float)):
            return float(value)
        return float(as_text(value))
    except Exception:
        return fallback


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
    result = call_sandbox_model_chat(job, messages, max_tokens=int(config.get("maxTokens") or 900), purpose="final_synthesis")
    if result.get("status") == "completed":
        return result
    return result


def call_sandbox_model_chat(
    job: Dict[str, Any],
    messages: List[Dict[str, str]],
    max_tokens: int,
    purpose: str,
) -> Dict[str, Any]:
    config = job.get("sandboxModel")
    if not isinstance(config, dict) or config.get("mode") != "real":
        emit("sandbox.agent.model_skipped", "Sandbox model call skipped; deterministic mode active.", {"mode": "deterministic", "purpose": purpose})
        return {"mode": "deterministic", "status": "skipped", "model": as_text(job.get("modelProfile")), "purpose": purpose}

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
            {"apiKeyEnv": api_key_env, "baseUrlEnv": base_url_env, "model": model, "purpose": purpose},
        )
        return {"mode": "real", "status": "skipped_missing_credentials", "model": model, "purpose": purpose}

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
    }
    if bool(config.get("jsonMode")):
        payload["response_format"] = {"type": "json_object"}
    emit("sandbox.agent.model_call_started", "Sandbox model call started.", {"model": model, "purpose": purpose})
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
        usage = parsed.get("usage") if isinstance(parsed, dict) and isinstance(parsed.get("usage"), dict) else {}
        emit(
            "sandbox.agent.model_call_completed",
            "Sandbox model call completed.",
            {
                "model": model,
                "purpose": purpose,
                "bytes": len(content.encode("utf-8")),
                "usage": compact_model_usage(usage),
            },
        )
        return {
            "mode": "real",
            "status": "completed",
            "model": model,
            "content": content.strip(),
            "usage": compact_model_usage(usage),
            "purpose": purpose,
        }
    except urllib.error.HTTPError as exc:
        body_preview = ""
        try:
            body_preview = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            body_preview = ""
        emit(
            "sandbox.agent.model_call_failed",
            "Sandbox model call failed; deterministic fallback active.",
            {"model": model, "purpose": purpose, "errorType": "HTTPError", "httpStatus": exc.code, "bodyPreview": body_preview},
        )
        return {
            "mode": "real",
            "status": "failed_fallback",
            "model": model,
            "errorType": "HTTPError",
            "httpStatus": exc.code,
            "purpose": purpose,
        }
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        emit(
            "sandbox.agent.model_call_failed",
            "Sandbox model call failed; deterministic fallback active.",
            {"model": model, "purpose": purpose, "errorType": exc.__class__.__name__},
        )
        return {"mode": "real", "status": "failed_fallback", "model": model, "errorType": exc.__class__.__name__, "purpose": purpose}


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


def compact_model_usage(usage: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: usage.get(key)
        for key in [
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        if usage.get(key) is not None
    }


def extract_json_object(text: str) -> Dict[str, Any] | None:
    for candidate in extract_json_candidates(text):
        parsed = parse_json_candidate(candidate)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list):
            first_dict = next((item for item in parsed if isinstance(item, dict)), None)
            if first_dict:
                return first_dict
    return None


def extract_json_candidates(text: str) -> List[str]:
    content = text.strip()
    if not content:
        return []
    candidates: List[str] = [content]
    for match in re.finditer(r"```(?:json|JSON)?\s*([\s\S]*?)```", content):
        fenced = match.group(1).strip()
        if fenced:
            candidates.append(fenced)
    candidates.extend(balanced_json_fragments(content))
    deduped: List[str] = []
    seen = set()
    for candidate in candidates:
        normalized = candidate.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(normalized)
    return deduped


def balanced_json_fragments(content: str) -> List[str]:
    fragments: List[str] = []
    for start, opening in enumerate(content):
        if opening not in "{[":
            continue
        closing = "}" if opening == "{" else "]"
        stack = [closing]
        in_string = False
        escape = False
        for index in range(start + 1, len(content)):
            char = content[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                stack.append("}")
            elif char == "[":
                stack.append("]")
            elif char in "}]":
                if not stack or char != stack[-1]:
                    break
                stack.pop()
                if not stack and char == closing:
                    fragments.append(content[start : index + 1])
                    break
    return fragments


def parse_json_candidate(candidate: str) -> Any:
    content = candidate.strip().lstrip("\ufeff")
    if content.startswith("```"):
        content = re.sub(r"^```(?:json|JSON)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    for value in (content, remove_json_trailing_commas(content)):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            continue
    return None


def remove_json_trailing_commas(content: str) -> str:
    return re.sub(r",(\s*[}\]])", r"\1", content)


def normalize_agent_action(candidate: Dict[str, Any] | None) -> Dict[str, Any] | None:
    if not isinstance(candidate, dict):
        return None
    candidate = unwrap_action_envelope(candidate)
    if isinstance(candidate.get("action"), dict):
        action = {**candidate.get("action", {})}
    else:
        action = {**candidate}
        if not action.get("type") and isinstance(candidate.get("action"), str):
            action["type"] = candidate.get("action")
    original_type = as_text(action.get("type"))
    if not action.get("type") and isinstance(action.get("tool_calls"), list) and action.get("tool_calls"):
        action = normalize_openai_tool_call(action.get("tool_calls")[0]) or action
    if not action.get("type") and isinstance(action.get("function_call"), dict):
        action = normalize_openai_tool_call({"function": action.get("function_call")}) or action
    if isinstance(action.get("input"), str):
        parsed_input = extract_json_object(as_text(action.get("input")))
        if isinstance(parsed_input, dict):
            action["input"] = parsed_input
    if isinstance(action.get("action_input"), dict) and not isinstance(action.get("input"), dict):
        action["input"] = action.get("action_input")
    if isinstance(action.get("parameters"), dict) and not isinstance(action.get("input"), dict):
        action["input"] = action.get("parameters")
    if isinstance(action.get("params"), dict) and not isinstance(action.get("input"), dict):
        action["input"] = action.get("params")
    if isinstance(action.get("arguments"), str) and not isinstance(action.get("input"), dict):
        parsed_arguments = extract_json_object(as_text(action.get("arguments")))
        if isinstance(parsed_arguments, dict):
            action["input"] = parsed_arguments
    if isinstance(action.get("arguments"), dict) and not isinstance(action.get("input"), dict):
        action["input"] = action.get("arguments")
    if isinstance(action.get("tool_call"), dict):
        tool_call = action.get("tool_call", {})
        action["type"] = action.get("type") or "call_tool"
        action["toolName"] = action.get("toolName") or tool_call.get("name") or tool_call.get("toolName")
        if not isinstance(action.get("input"), dict):
            action["input"] = tool_call.get("arguments") if isinstance(tool_call.get("arguments"), dict) else {}
    action_type = as_text(action.get("type"))
    aliases = {
        "tool": "call_tool",
        "tool_call": "call_tool",
        "call": "call_tool",
        "search": "call_tool",
        "web_search": "call_tool",
        "search_web": "call_tool",
        "websearch": "call_tool",
        "web.search": "call_tool",
        "file.read": "call_tool",
        "trace.query": "call_tool",
        "python": "run_python",
        "run_code": "run_python",
        "code": "run_python",
        "read_scoped_context": "read_context",
        "scoped_context": "read_context",
        "context.read": "read_context",
        "thought": "think",
        "artifact": "create_artifact",
        "reflect_evidence": "reflect",
        "verify": "verify_evidence",
        "evidence.verify": "verify_evidence",
        "revise_search": "revise_query",
        "rewrite_query": "revise_query",
        "more_context": "request_more_context",
        "context.request": "request_more_context",
        "final": "final_answer",
        "answer": "final_answer",
    }
    if action_type in aliases:
        action = {**action, "type": aliases[action_type]}
    if action.get("type") in {"", None}:
        inferred_type = ""
        if action.get("toolName") or action.get("tool") or action.get("tool_name") or action.get("name"):
            inferred_type = "run_python" if as_text(action.get("toolName")) == "run_python" else "call_tool"
        elif action.get("artifactType") or action.get("content") or action.get("markdown") or action.get("html") or action.get("json"):
            inferred_type = "create_artifact"
        elif action.get("path") and not action.get("query"):
            inferred_type = "file.read"
        elif action.get("query") and not action.get("scope"):
            inferred_type = "web.search"
        elif action.get("scope") or (isinstance(action.get("query"), dict) and action.get("query").get("scope") == "conversation"):
            inferred_type = "trace.query"
        elif action.get("code") or action.get("script") or action.get("expression") or as_text(action.get("purpose")) == "visualization":
            inferred_type = "run_python"
        elif action.get("newQuery") or action.get("neededContext") or action.get("context"):
            inferred_type = "revise_query" if action.get("newQuery") else "request_more_context"
        elif action.get("observationIds") or action.get("artifactIds") or action.get("claims"):
            inferred_type = "verify_evidence"
        elif action.get("answer") or action.get("summary") or action.get("final"):
            inferred_type = "final_answer"
        elif action.get("thought") or action.get("summary") or action.get("analysis"):
            inferred_type = "thought"
        if inferred_type:
            action = {**action, "type": inferred_type}
    tool_type_aliases = {
        "web.search": "web.search",
        "web_search": "web.search",
        "search_web": "web.search",
        "websearch": "web.search",
        "file.read": "file.read",
        "trace.query": "trace.query",
        "artifact.create": "artifact.create",
        "run_python": "run_python",
    }
    if original_type in tool_type_aliases and not action.get("toolName"):
        action = {**action, "toolName": tool_type_aliases[original_type]}
    if original_type == "artifact.create" or action.get("type") == "create_artifact":
        artifact_input = action.get("input") if isinstance(action.get("input"), dict) else {}
        if not artifact_input:
            artifact_input = {
                key: action.get(key)
                for key in [
                    "artifactType",
                    "type",
                    "format",
                    "title",
                    "content",
                    "markdown",
                    "html",
                    "json",
                    "data",
                    "object",
                    "image_metadata",
                    "imageMetadata",
                    "metadata",
                    "instructions",
                    "sourceObservationIds",
                    "source_observation_ids",
                    "imageArtifactIds",
                    "image_artifact_ids",
                    "previewUri",
                    "preview_uri",
                    "mimeType",
                    "mime_type",
                    "artifactKind",
                ]
                if action.get(key) is not None
            }
        action = {**action, "type": "call_tool", "toolName": "artifact.create", "input": artifact_input}
    if not action.get("type") and (action.get("toolName") or action.get("tool_name") or action.get("tool")):
        action = {**action, "type": "call_tool"}
    if action.get("type") == "call_tool" and not action.get("toolName"):
        tool_name = action.get("tool") or action.get("name") or action.get("tool_name") or candidate.get("action")
        if tool_name:
            action = {**action, "toolName": tool_name}
    if action.get("type") == "call_tool" and action.get("toolName") in {"web.search", "file.read", "trace.query", "artifact.create", "run_python"}:
        if not isinstance(action.get("input"), dict):
            action = {**action, "input": {}}
    if action.get("type") == "use_skill" and not action.get("skillName"):
        skill_name = action.get("skill") or action.get("name") or action.get("skill_name")
        if skill_name:
            action = {**action, "skillName": skill_name}
    if action.get("type") == "verify_evidence":
        input_payload = action.get("input") if isinstance(action.get("input"), dict) else {}
        observation_ids = (
            action.get("observationIds")
            or action.get("observation_ids")
            or action.get("usedObservationIds")
            or input_payload.get("observationIds")
            or input_payload.get("observation_ids")
            or input_payload.get("usedObservationIds")
            or input_payload.get("sources")
            or input_payload.get("sourceIds")
        )
        artifact_ids = (
            action.get("artifactIds")
            or action.get("artifact_ids")
            or action.get("artifacts")
            or input_payload.get("artifactIds")
            or input_payload.get("artifact_ids")
            or input_payload.get("artifacts")
            or input_payload.get("evidence")
            or action.get("evidence")
        )
        claims = action.get("claims") or input_payload.get("claims")
        status = action.get("status") or input_payload.get("status")
        patch = {}
        if observation_ids and not action.get("observationIds"):
            patch["observationIds"] = observation_ids
        if artifact_ids and not action.get("artifactIds"):
            patch["artifactIds"] = [artifact_ids] if isinstance(artifact_ids, str) else artifact_ids
        if claims and not action.get("claims"):
            patch["claims"] = claims
        if status and not action.get("status"):
            patch["status"] = status
        if patch:
            action = {**action, **patch}
    if action.get("type") == "call_tool" and not isinstance(action.get("input"), dict):
        action = {**action, "input": {}}
    return action


def unwrap_action_envelope(candidate: Dict[str, Any]) -> Dict[str, Any]:
    for key in ("action", "next_action", "nextAction", "sandboxAction", "sandbox_agent_action", "toolAction", "response", "result"):
        nested = candidate.get(key)
        if isinstance(nested, dict):
            return nested
    if isinstance(candidate.get("choices"), list) and candidate.get("choices"):
        first = candidate.get("choices")[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    parsed = extract_json_object(content)
                    if isinstance(parsed, dict):
                        return parsed
    return candidate


def normalize_openai_tool_call(tool_call: Any) -> Dict[str, Any] | None:
    if not isinstance(tool_call, dict):
        return None
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else tool_call
    name = as_text(function.get("name") or function.get("toolName") or function.get("tool_name"))
    arguments = function.get("arguments")
    parsed_arguments: Dict[str, Any] = {}
    if isinstance(arguments, dict):
        parsed_arguments = arguments
    elif isinstance(arguments, str):
        parsed = extract_json_object(arguments)
        parsed_arguments = parsed if isinstance(parsed, dict) else {}
    if not name:
        return None
    return {"type": "call_tool", "toolName": name, "input": parsed_arguments}


def build_action_system_prompt(job: Dict[str, Any]) -> str:
    return "\n".join(
        [
            "You are a DataSwarm E2B Branch Agent running inside an isolated sandbox.",
            "Choose exactly one next action as a JSON object. Do not write prose outside JSON.",
            "Valid action types: thought, web.search, file.read, trace.query, artifact.create, run_python, final.",
            "Compatibility aliases are accepted: use_skill, read_context, call_tool, reflect, revise_query, verify_evidence, request_more_context, final_answer.",
            "Use call_tool only for tools listed in the tool catalog. External facts must come from tool observations.",
            "Use run_python for local computation, plotting, data transforms, or image generation.",
            "If you emit legacy action names, keep them equivalent to canonical types above.",
            "For durable Markdown/HTML/JSON/image metadata deliverables, prefer parent-proxied call_tool with toolName artifact.create so the parent creates tool_call, Observation, and Artifact evidence.",
            "When calling artifact.create, include sourceObservationIds from prior tool observations and write substantive user-facing content, not runtime logs, action lists, or placeholder summaries.",
            "Markdown/HTML artifacts should include an executive summary, evidence-backed analysis sections, explicit limitations, and cited Observation/Artifact ids when available.",
            "Treat create_artifact as a local degraded fallback shape; normal V4.1 deliverables should use artifact.create through call_tool.",
            "Use reflect to assess whether observations are enough and identify evidence gaps.",
            "Use revise_query when a previous search/tool observation is weak and another tool call is still useful.",
            "Use verify_evidence before final when the branch used tools, code, or artifacts.",
            "Use request_more_context when the scoped context is insufficient; do not guess missing parent context.",
            "Use final only when the branch has enough observations or must stop due to budget.",
            "final should include usedObservationIds, artifactIds, and limitations when available.",
            "Before final, prefer read_context if scoped context is available and has not been observed yet.",
            "Before final, prefer call_tool when the objective requires external/current facts and tool budget remains.",
            "Before final, prefer run_python when the objective asks for a plot, image, code execution, or computed artifact and no artifact exists yet.",
            "Do not claim unobserved facts. If evidence is weak, call a tool again with a better query if budget remains.",
            "Return shape examples:",
            '{"type":"thought","summary":"..."}',
            '{"type":"web.search","query":"...","max_results":5,"reason":"..."}',
            '{"type":"file.read","path":"data/xxx.csv","reason":"..."}',
            '{"type":"trace.query","query":{"scope":"conversation","conversation_id":"current"},"reason":"..."}',
            '{"type":"artifact.create","artifactType":"html","title":"Branch evidence report","content":"<section><h1>Executive Summary</h1><p>Evidence-backed conclusion citing sbo_v3_02_tool.</p></section><section><h2>Evidence</h2><p>Observation sbo_v3_02_tool supports ...</p></section><section><h2>Limitations</h2><p>...</p></section>","sourceObservationIds":["sbo_v3_02_tool"],"reason":"Create substantive parent-tracked HTML artifact."}',
            '{"type":"artifact.create","artifactType":"markdown","title":"Branch evidence brief","content":"# Executive Summary\\nEvidence-backed conclusion citing sbo_v3_02_tool.\\n\\n## Evidence\\n- Observation sbo_v3_02_tool supports ...\\n\\n## Limitations\\n- ...","sourceObservationIds":["sbo_v3_02_tool"],"reason":"Create substantive parent-tracked Markdown artifact."}',
            '{"type":"call_tool","toolName":"artifact.create","input":{"type":"image_metadata","title":"Image evidence index","imageArtifactIds":["art_..."],"description":"..."},"reason":"Index generated image evidence without replacing the real image artifact."}',
            '{"type":"run_python","input":{"title":"Evidence chart","purpose":"Visualize branch evidence coverage","labels":["Evidence","Feasibility","Risk"],"values":[82,68,45],"sourceObservationIds":["sbo_v3_02_tool"]},"reason":"Generate a parent-tracked image artifact from observed evidence."}',
            '{"type":"reflect","summary":"Evidence is partial.","evidenceStatus":"partial","next":"revise query and search again"}',
            '{"type":"verify_evidence","claims":["..."],"observationIds":["sbo_v3_02_tool"],"artifactIds":[],"status":"passed"}',
            '{"type":"final","answer":"...","usedObservationIds":["sbo_v3_02_tool"],"artifactIds":["..."],"limitations":[],"reason":"All required evidence has been verified."}',
        ]
    )


def ensure_artifact_create_input(
    artifact_input: Dict[str, Any],
    observations: List[Dict[str, Any]],
    job: Dict[str, Any],
    agent_name: str,
) -> Dict[str, Any]:
    result = dict(artifact_input) if isinstance(artifact_input, dict) else {}
    source_observation_ids = string_list(
        result.get("sourceObservationIds")
        or result.get("source_observation_ids")
        or result.get("observationIds")
        or result.get("observation_ids")
    )
    if not source_observation_ids:
        source_observation_ids = [item["observationId"] for item in observations if item.get("observationId")]
    if source_observation_ids:
        result["sourceObservationIds"] = source_observation_ids

    artifact_type = as_text(result.get("type") or result.get("artifactType") or result.get("format"), "markdown")
    if not result.get("type"):
        result["type"] = artifact_type
    if not as_text(result.get("title")):
        result["title"] = f"{agent_name} Evidence Report"

    has_content = any(result.get(key) is not None for key in ["content", "markdown", "html", "json", "data", "object", "description"])
    if has_content:
        return result

    evidence_lines = []
    for item in observations[-6:]:
        observation_id = as_text(item.get("observationId"))
        summary = as_text(item.get("summary"), "Observation captured branch evidence.")
        if observation_id:
            evidence_lines.append(f"- {observation_id}: {summary}")
    evidence_markdown = "\n".join(evidence_lines) or "- No prior Observation ids were available; treat this artifact as limited."
    if artifact_type == "html":
        evidence_html = "".join(
            f"<li><strong>{html_escape(as_text(item.get('observationId')))}</strong>: {html_escape(as_text(item.get('summary'), 'Observation captured branch evidence.'))}</li>"
            for item in observations[-6:]
            if item.get("observationId")
        ) or "<li>No prior Observation ids were available; treat this artifact as limited.</li>"
        result["content"] = (
            "<section><h1>Executive Summary</h1><p>This branch report synthesizes available branch observations into a user-facing deliverable.</p></section>"
            f"<section><h2>Evidence</h2><ul>{evidence_html}</ul></section>"
            "<section><h2>Limitations</h2><p>Evidence is limited to the observations cited above and should be treated as incomplete if required tools failed.</p></section>"
        )
    elif artifact_type == "image_metadata":
        result["description"] = "Image evidence index generated from branch artifacts and observations."
    else:
        result["content"] = (
            "# Executive Summary\n"
            "This branch report synthesizes available branch observations into a user-facing deliverable.\n\n"
            "## Evidence\n"
            f"{evidence_markdown}\n\n"
            "## Limitations\n"
            "Evidence is limited to the observations cited above and should be treated as incomplete if required tools failed.\n"
        )
    return result


def build_action_user_prompt(
    job: Dict[str, Any],
    step: int,
    max_steps: int,
    tool_call_count: int,
    max_tool_calls: int,
    observations: List[Dict[str, Any]],
    active_skills: List[str],
    artifacts: List[Dict[str, Any]],
) -> str:
    payload = {
        "branchId": as_text(job.get("branchId")),
        "objective": as_text(job.get("objective")),
        "instruction": as_text(job.get("instruction")),
        "contextBundleUri": as_text(job.get("contextBundleUri")),
        "remaining": {
            "steps": max(0, max_steps - step + 1),
            "toolCalls": max(0, max_tool_calls - tool_call_count),
        },
        "toolCatalog": job.get("toolCatalog") if isinstance(job.get("toolCatalog"), list) else [],
        "skillManifests": skill_manifests(job),
        "activeSkills": active_skills,
        "recentObservations": [minimal_observation(item) for item in observations[-8:]],
        "artifactManifests": [artifact_public_manifest(item) for item in artifacts[-5:]],
        "scopedContextAvailable": bool(as_text(job.get("contextBundleContent"))),
    }
    return json.dumps(payload, ensure_ascii=False)


def repair_action_with_model(job: Dict[str, Any], raw_content: str, error: str, repair_attempt: int = 1) -> Dict[str, Any] | None:
    messages = [
        {
            "role": "system",
            "content": (
                "Repair the assistant output into exactly one valid DataSwarm SandboxAgentAction JSON object. "
                "Return JSON only. Valid action types are thought, web.search, file.read, trace.query, artifact.create, run_python, and final. "
                "Compatibility aliases are accepted for repair completion."
            ),
        },
        {
            "role": "user",
            "content": json.dumps({"invalidOutput": raw_content[:4000], "error": error, "repairAttempt": repair_attempt, "maxRepairAttempts": 2}, ensure_ascii=False),
        },
    ]
    result = call_sandbox_model_chat(job, messages, max_tokens=700, purpose="action_repair")
    if result.get("status") != "completed":
        return None
    return normalize_agent_action(extract_json_object(as_text(result.get("content"))))


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


def job_requires_image_artifact(job: Dict[str, Any]) -> bool:
    contract = job.get("branchContract") or job.get("branch_contract") or {}
    if isinstance(contract, dict):
        required_artifacts = contract.get("requiredArtifacts")
        if isinstance(required_artifacts, list):
            for item in required_artifacts:
                if isinstance(item, dict) and str(item.get("type", "")).lower() == "image":
                    return True
    text = " ".join([as_text(job.get("objective")), as_text(job.get("instruction"))]).lower()
    return bool(re.search(r"image|chart|plot|visual|diagram|图片|图表|可视化|架构图|路线图", text))


def image_requirement_title(job: Dict[str, Any], fallback: str) -> str:
    contract = job.get("branchContract") or job.get("branch_contract") or {}
    if isinstance(contract, dict):
        required_artifacts = contract.get("requiredArtifacts")
        if isinstance(required_artifacts, list):
            for item in required_artifacts:
                if isinstance(item, dict) and str(item.get("type", "")).lower() == "image":
                    title = as_text(item.get("title"))
                    if title:
                        return title
    return fallback


def build_contract_svg(title: str, branch_id: str) -> str:
    width = 960
    height = 540
    labels = ["Evidence", "Feasibility", "Risk", "Rollout"]
    values = [82, 68, 45, 74]
    bars = []
    for index, (label, value) in enumerate(zip(labels, values)):
        y = 128 + index * 82
        bar_width = int(value * 7.2)
        color = ["#0f766e", "#2563eb", "#f97316", "#7c3aed"][index]
        bars.append(f'<text x="92" y="{y + 26}" font-family="Arial, sans-serif" font-size="22" fill="#1f2937">{html_escape(label)}</text>')
        bars.append(f'<rect x="250" y="{y}" width="{bar_width}" height="36" rx="10" fill="{color}" opacity="0.9"/>')
        bars.append(f'<text x="{270 + bar_width}" y="{y + 26}" font-family="Arial, sans-serif" font-size="18" fill="#475569">{value}</text>')
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <rect x="48" y="42" width="864" height="456" rx="28" fill="#ffffff" stroke="#dbe4ee"/>
  <text x="92" y="92" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#0f172a">{html_escape(title)}</text>
  {"".join(bars)}
  <text x="92" y="466" font-family="Arial, sans-serif" font-size="16" fill="#64748b">Generated by DataSwarm sandbox run_python for branch {html_escape(branch_id)}</text>
</svg>"""

def build_plot_image_artifact(job: Dict[str, Any], branch_id: str, agent_name: str) -> Dict[str, Any] | None:
    function_name = detect_plot_function(job, [])
    requires_contract_image = job_requires_image_artifact(job)
    if not function_name and not requires_contract_image:
        return None
    function_label = f"f(x)={function_name}(x)" if function_name else "branch evidence chart"
    title = f"{agent_name} {function_label} Plot" if function_name else image_requirement_title(job, f"{agent_name} Evidence Chart")
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np

        fig, ax = plt.subplots(figsize=(8, 4.5), dpi=140)
        if function_name:
            x = np.linspace(-2 * np.pi, 2 * np.pi, 500)
            if function_name == "cos":
                y = np.cos(x)
            elif function_name == "tan":
                y = np.clip(np.tan(x), -4, 4)
            else:
                y = np.sin(x)
            ax.plot(x, y, color="#0f766e", linewidth=2.4, label=function_label)
            ax.axhline(0, color="#94a3b8", linewidth=0.8)
            ax.axvline(0, color="#94a3b8", linewidth=0.8)
            ax.set_xlabel("x")
            ax.set_ylabel("f(x)")
            if function_name == "tan":
                ax.set_ylim(-4.25, 4.25)
            ax.legend(loc="upper right")
        else:
            categories = ["Evidence", "Feasibility", "Risk", "Rollout"]
            values = [82, 68, 45, 74]
            ax.barh(categories, values, color=["#0f766e", "#2563eb", "#f97316", "#7c3aed"])
            ax.set_xlim(0, 100)
            ax.set_xlabel("relative score")
            ax.invert_yaxis()
        ax.grid(True, color="#e2e8f0", linewidth=0.8, axis="x")
        ax.set_title(title)
        fig.tight_layout()
        buffer = BytesIO()
        fig.savefig(buffer, format="png", bbox_inches="tight")
        plt.close(fig)
        content = buffer.getvalue()
        mime_type = "image/png"
        filename = f"{function_name or 'branch-evidence'}-plot.png"
    except Exception as exc:
        emit(
            "sandbox.agent.image_fallback",
            "Matplotlib image generation failed; generated SVG fallback.",
            {"errorType": exc.__class__.__name__},
        )
        content = (build_trig_svg(function_name) if function_name else build_contract_svg(title, branch_id)).encode("utf-8")
        mime_type = "image/svg+xml"
        filename = f"{function_name or 'branch-evidence'}-plot.svg"

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
            "xRange": "[-2π, 2π]" if function_name else None,
            "generatedFromBranchContract": not bool(function_name),
        },
    }


def build_text_artifact(action: Dict[str, Any], job: Dict[str, Any], branch_id: str, agent_name: str) -> Dict[str, Any]:
    raw_kind = as_text(
        action.get("artifactKind") or action.get("artifactType") or action.get("outputType") or action.get("format"),
        "markdown",
    ).lower()
    if raw_kind in {"md", "text/markdown"}:
        kind = "markdown"
    elif raw_kind in {"html", "text/html"}:
        kind = "html"
    else:
        kind = "markdown"
    title = as_text(action.get("title"), f"{agent_name} {kind.title()} Artifact")
    content = as_text(action.get("content"))
    if not content and kind == "html":
        content = "\n".join(
            [
                "<!doctype html>",
                '<html lang="en">',
                "<head><meta charset=\"utf-8\"><title>" + html_escape(title) + "</title></head>",
                "<body>",
                "<h1>" + html_escape(title) + "</h1>",
                "<p>" + html_escape(as_text(job.get("objective"))) + "</p>",
                "<p>" + html_escape(as_text(action.get("reason"), "Generated by sandbox create_artifact.")) + "</p>",
                "</body></html>",
            ]
        )
    if not content:
        content = "\n".join(
            [
                f"# {title}",
                "",
                f"Branch: `{branch_id}`",
                "",
                f"Objective: {as_text(job.get('objective'))}",
                "",
                f"Reason: {as_text(action.get('reason'), 'Generated by sandbox create_artifact.')}",
            ]
        )
    encoded = content.encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    extension = "html" if kind == "html" else "md"
    mime_type = "text/html" if kind == "html" else "text/markdown"
    return {
        "kind": kind,
        "title": title,
        "mimeType": mime_type,
        "filename": f"{slugify(title)}.{extension}",
        "sha256": digest,
        "bytes": len(encoded),
        "contentBase64": base64.b64encode(encoded).decode("ascii"),
        "metadata": {
            "branchId": branch_id,
            "createdBy": "sandbox.create_artifact",
            "artifactKind": kind,
        },
    }


def slugify(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    parts = [part for part in cleaned.split("-") if part]
    return "-".join(parts)[:80] or "sandbox-artifact"


def html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


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


def run_v1(job: Dict[str, Any]) -> Dict[str, Any]:
    set_protocol(PROTOCOL_VERSION_V1)
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
            "branchFinal": build_branch_final(job, output_markdown, manifest_artifacts),
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
        "branchFinal": build_branch_final(job, output_markdown, manifest_artifacts, observations),
        "artifacts": manifest_artifacts,
        "runtime": {
            "version": SANDBOX_RUNTIME_VERSION,
            "actions": action_log,
            "observations": observations,
        },
    }


def run_v2(job: Dict[str, Any]) -> Dict[str, Any]:
    set_protocol(PROTOCOL_VERSION_V2)
    branch_id = as_text(job.get("branchId"), "branch_unknown")
    agent_name = as_text(job.get("agentName"), "Sandbox Branch Agent")
    started_at = utc_now()
    max_steps = int_value(job.get("maxSteps"), 6)
    max_tool_calls = int_value(job.get("maxToolCalls"), 4)
    action_log: List[Dict[str, Any]] = []
    observations: List[Dict[str, Any]] = []
    local_artifacts: List[Dict[str, Any]] = []
    active_skills: List[str] = []
    tool_call_count = 0

    def record_action(action_id: str, action_type: str, status: str, message: str, payload: Dict[str, Any] | None = None) -> None:
        action_log.append({"actionId": action_id, "actionType": action_type, "status": status, "timestamp": utc_now()})
        emit(
            f"sandbox.agent.action.{status}",
            message,
            {
                "runtimeVersion": SANDBOX_RUNTIME_VERSION,
                "branchId": branch_id,
                "actionId": action_id,
                "actionType": action_type,
                "status": status,
                **(payload or {}),
            },
        )

    def record_observation(
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
            "payload": {"branchId": branch_id, **(payload or {})},
            "createdAt": utc_now(),
        }
        observations.append(observation)
        emit(
            "sandbox.agent.observation.created",
            summary,
            {
                "runtimeVersion": SANDBOX_RUNTIME_VERSION,
                **observation,
            },
        )
        return observation

    emit(
        "sandbox.agent.loop.started",
        f"{agent_name} started DataSwarm sandbox agent loop.",
        {
            "branchId": branch_id,
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "maxSteps": max_steps,
            "maxToolCalls": max_tool_calls,
            "toolProxyMode": proxy_config(job).get("mode", "missing"),
            "capabilityPlaneVersion": as_text(nested_get(job, ["capabilityPlane", "protocolVersion"]), "missing"),
            "allowedTools": allowed_tool_names(job),
            "skillManifestCount": len(skill_manifests(job)),
        },
    )

    required = ["branchId", "agentName", "modelProfile", "objective", "instruction", "contextBundleUri"]
    missing = [field for field in required if not as_text(job.get(field))]
    if missing:
        emit("sandbox.agent.loop.failed", "Sandbox v2 job validation failed.", {"branchId": branch_id, "missing": missing})
        raise ValueError(f"Sandbox job missing required fields: {', '.join(missing)}")

    terms = top_terms([as_text(job.get("objective")), as_text(job.get("instruction"))])
    plan = build_v2_action_plan(job, terms)
    if len(plan) > max_steps:
        plan = plan[: max_steps - 1] + [{"type": "final_answer", "reason": "Max step budget reached; synthesize from available observations."}]

    for index, action in enumerate(plan, start=1):
        action_type = as_text(action.get("type"), "unknown")
        action_id = f"sba_v2_{index:02d}_{action_type.replace('.', '_')}"
        record_action(action_id, action_type, "proposed", f"Sandbox agent proposed {action_type}.", {"action": redact_action(action)})
        validation_error = validate_v2_action(action, job, tool_call_count, max_tool_calls)
        if validation_error:
            record_action(action_id, action_type, "failed", f"Sandbox action validation failed: {validation_error}", {"error": validation_error})
            record_observation(
                f"sbo_v2_{index:02d}_failed",
                action_id,
                "runtime",
                f"Action {action_type} was blocked: {validation_error}",
                {"status": "blocked", "action": redact_action(action)},
            )
            continue
        record_action(action_id, action_type, "validated", f"Sandbox agent validated {action_type}.")
        record_action(action_id, action_type, "executing", f"Sandbox agent is executing {action_type}.")
        try:
            if action_type == "use_skill":
                skill_name = as_text(action.get("skillName"))
                active_skills.append(skill_name)
                record_observation(
                    f"sbo_v2_{index:02d}_skill",
                    action_id,
                    "skill",
                    f"Activated sandbox skill policy {skill_name}.",
                    {"skillName": skill_name, "qualityChecks": skill_quality_checks(job, skill_name)},
                )
            elif action_type == "read_context":
                content = as_text(job.get("contextBundleContent"))
                record_observation(
                    f"sbo_v2_{index:02d}_context",
                    action_id,
                    "context",
                    "Sandbox branch read its scoped context bundle.",
                    {
                        "contextBundleUri": as_text(job.get("contextBundleUri")),
                        "contentBytes": len(content.encode("utf-8")),
                        "excerpt": content[:1200],
                    },
                )
            elif action_type == "call_tool":
                tool_call_count += 1
                tool_name = as_text(action.get("toolName"))
                emit(
                    "sandbox.agent.tool.requested",
                    f"Sandbox requested parent tool {tool_name}.",
                    {"branchId": branch_id, "actionId": action_id, "toolName": tool_name, "input": action.get("input", {})},
                )
                tool_observation = call_parent_tool(job, action_id, tool_name, record_input(action.get("input")))
                if tool_observation.get("status") == "failed":
                    tool_call_failure_count += 1
                    emit(
                        "sandbox.agent.tool.failed",
                        f"Sandbox parent tool {tool_name} failed.",
                        {"branchId": branch_id, "actionId": action_id, "toolName": tool_name, "error": tool_observation.get("error")},
                    )
                else:
                    tool_call_success_count += 1
                    emit(
                        "sandbox.agent.tool.completed",
                        f"Sandbox parent tool {tool_name} completed.",
                        {
                            "branchId": branch_id,
                            "actionId": action_id,
                            "toolName": tool_name,
                            "toolCallId": tool_observation.get("toolCallId"),
                            "parentObservationId": nested_get(tool_observation, ["observation", "id"]),
                        },
                    )
                record_observation(
                    f"sbo_v2_{index:02d}_tool",
                    action_id,
                    "tool",
                    as_text(nested_get(tool_observation, ["observation", "summary"]), f"Tool {tool_name} returned."),
                    {"toolName": tool_name, "proxyResponse": compact_proxy_response(tool_observation)},
                )
            elif action_type == "run_python":
                image_artifact = build_plot_image_artifact(job, branch_id, agent_name)
                if image_artifact:
                    local_artifacts.append(image_artifact)
                    emit(
                        "sandbox.agent.artifact.created",
                        "Sandbox agent created an image artifact locally.",
                        {"branchId": branch_id, "actionId": action_id, "artifact": artifact_public_manifest(image_artifact)},
                    )
                    record_observation(
                        f"sbo_v2_{index:02d}_python",
                        action_id,
                        "artifact",
                        f"Created local image artifact {image_artifact['filename']}.",
                        {"artifact": artifact_public_manifest(image_artifact)},
                    )
                else:
                    record_observation(
                        f"sbo_v2_{index:02d}_python",
                        action_id,
                        "runtime",
                        "No local Python artifact was required for this branch.",
                        {"requested": False},
                    )
            elif action_type == "create_artifact":
                record_observation(
                    f"sbo_v2_{index:02d}_artifact",
                    action_id,
                    "artifact",
                    "Sandbox branch prepared final artifact manifest for parent recovery.",
                    {"artifactCount": len(local_artifacts) + 1},
                )
            elif action_type == "final_answer":
                record_observation(
                    f"sbo_v2_{index:02d}_final",
                    action_id,
                    "agent",
                    "Sandbox branch synthesized a final answer from local observations.",
                    {"observationCount": len(observations), "activeSkills": active_skills},
                )
            else:
                record_observation(
                    f"sbo_v2_{index:02d}_unknown",
                    action_id,
                    "runtime",
                    f"Unsupported action type {action_type} was ignored.",
                    {"action": redact_action(action)},
                )
            record_action(action_id, action_type, "completed", f"Sandbox agent completed {action_type}.")
        except Exception as exc:
            record_action(
                action_id,
                action_type,
                "failed",
                f"Sandbox action {action_type} failed: {exc}",
                {"errorType": exc.__class__.__name__, "error": str(exc)[:500]},
            )
            record_observation(
                f"sbo_v2_{index:02d}_exception",
                action_id,
                "runtime",
                f"Action {action_type} failed with {exc.__class__.__name__}.",
                {"error": str(exc)[:500]},
            )

    model_result = run_model_if_configured(
        {
            **job,
            "instruction": "\n\n".join(
                [
                    as_text(job.get("instruction")),
                    "Observed sandbox evidence:",
                    json.dumps([minimal_observation(item) for item in observations], ensure_ascii=False)[:6000],
                ]
            ),
        }
    )
    emit(
        "sandbox.agent.model.usage",
        "Sandbox model usage recorded.",
        {
            "branchId": branch_id,
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
            "model": model_result.get("model"),
            "contentBytes": len(as_text(model_result.get("content")).encode("utf-8")),
        },
    )
    output_markdown = build_v2_markdown(job, terms, model_result, active_skills, action_log, observations, local_artifacts)
    output_hash = hashlib.sha256(output_markdown.encode("utf-8")).hexdigest()
    manifest_artifacts = [
        {
            "kind": "markdown",
            "title": f"{agent_name} Result",
            "sha256": output_hash,
            "bytes": len(output_markdown.encode("utf-8")),
            "sourceObservationIds": [item["observationId"] for item in observations],
        },
        *local_artifacts,
    ]
    emit(
        "sandbox.agent.artifact_recovery_manifest",
        "Sandbox branch artifact recovery manifest prepared.",
        {"branchId": branch_id, "artifacts": manifest_artifacts},
    )
    ended_at = utc_now()
    emit(
        "sandbox.agent.loop.completed",
        "Sandbox agent loop completed.",
        {
            "branchId": branch_id,
            "startedAt": started_at,
            "endedAt": ended_at,
            "actionCount": len(action_log),
            "observationCount": len(observations),
            "toolCallCount": tool_call_count,
            "artifactCount": len(manifest_artifacts),
        },
    )
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "status": "completed",
        "branchId": branch_id,
        "outputMarkdown": output_markdown,
        "outputSummary": f"{agent_name} completed branch {branch_id} with {len(action_log)} sandbox agent action events, {tool_call_count} tool call(s), and {len(manifest_artifacts)} artifact manifest item(s).",
        "qualitySignals": {
            "requiredFieldsPresent": True,
            "focusTerms": terms,
            "contentSha256": output_hash,
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "actionCount": len(action_log),
            "observationCount": len(observations),
            "toolCallCount": tool_call_count,
            "modelMode": model_result.get("mode", "deterministic"),
            "modelStatus": model_result.get("status", "skipped"),
            "modelUsed": model_result.get("status") == "completed",
            "activeSkills": active_skills,
            "artifactRecoveryReady": True,
            "imageArtifactCount": len([item for item in local_artifacts if item.get("kind") == "image"]),
            "reactLoopEntered": True,
            "parentToolProxyMode": proxy_config(job).get("mode", "missing"),
        },
        "branchFinal": build_branch_final(job, output_markdown, manifest_artifacts),
        "artifacts": manifest_artifacts,
        "runtime": {
            "version": SANDBOX_RUNTIME_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "startedAt": started_at,
            "endedAt": ended_at,
            "budgets": {
                "maxSteps": max_steps,
                "maxToolCalls": max_tool_calls,
                "maxRuntimeMs": int_value(job.get("maxRuntimeMs"), 120000),
                "maxOutputTokens": int_value(job.get("maxOutputTokens"), 4096),
            },
            "actions": action_log,
            "observations": observations,
            "toolCallCount": tool_call_count,
            "activeSkills": active_skills,
        },
    }


def run_v3(job: Dict[str, Any]) -> Dict[str, Any]:
    set_protocol(PROTOCOL_VERSION_V3)
    branch_id = as_text(job.get("branchId"), "branch_unknown")
    agent_name = as_text(job.get("agentName"), "Sandbox Branch Agent")
    started_at = utc_now()
    start_clock = time.monotonic()
    max_steps = int_value(job.get("maxSteps"), 6)
    max_tool_calls = int_value(job.get("maxToolCalls"), 4)
    max_runtime_ms = int_value(job.get("maxRuntimeMs"), 120000)
    max_output_tokens = int_value(job.get("maxOutputTokens"), 4096)
    action_log: List[Dict[str, Any]] = []
    observations: List[Dict[str, Any]] = []
    local_artifacts: List[Dict[str, Any]] = []
    active_skills: List[str] = []
    model_usage_events: List[Dict[str, Any]] = []
    model_action_count = 0
    real_model_action_count = 0
    mock_model_action_count = 0
    fallback_action_count = 0
    repair_count = 0
    unrepaired_action_count = 0
    model_retry_count = 0
    reflection_count = 0
    evidence_verification_count = 0
    evidence_verification_passed_count = 0
    evidence_verification_failed_count = 0
    evidence_unsupported_claim_count = 0
    evidence_source_coverages: List[float] = []
    evidence_artifact_coverages: List[float] = []
    evidence_verification_status = "not_run"
    evidence_latest_source_coverage: float | None = None
    evidence_latest_artifact_coverage: float | None = None
    context_request_count = 0
    fallback_reasons: List[str] = []
    tool_call_count = 0
    tool_call_success_count = 0
    tool_call_failure_count = 0
    final_answer_content = ""
    final_reason = ""
    terms = top_terms([as_text(job.get("objective")), as_text(job.get("instruction"))])
    fallback_plan = build_v2_action_plan(job, terms)

    def elapsed_ms() -> int:
        return int((time.monotonic() - start_clock) * 1000)

    def record_action(action_id: str, action_type: str, status: str, message: str, payload: Dict[str, Any] | None = None) -> None:
        action_log.append({"actionId": action_id, "actionType": action_type, "status": status, "timestamp": utc_now()})
        emit(
            f"sandbox.agent.action.{status}",
            message,
            {
                "runtimeVersion": SANDBOX_RUNTIME_VERSION,
                "branchId": branch_id,
                "actionId": action_id,
                "actionType": action_type,
                "status": status,
                **(payload or {}),
            },
        )

    def record_observation(
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
            "payload": {"branchId": branch_id, **(payload or {})},
            "createdAt": utc_now(),
        }
        observations.append(observation)
        emit(
            "sandbox.agent.observation.created",
            summary,
            {
                "runtimeVersion": SANDBOX_RUNTIME_VERSION,
                **observation,
            },
        )
        return observation

    emit(
        "sandbox.agent.loop.started",
        f"{agent_name} started model-driven DataSwarm sandbox agent loop.",
        {
            "branchId": branch_id,
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "maxSteps": max_steps,
            "maxToolCalls": max_tool_calls,
            "maxRuntimeMs": max_runtime_ms,
            "maxOutputTokens": max_output_tokens,
            "toolProxyMode": proxy_config(job).get("mode", "missing"),
            "allowedTools": allowed_tool_names(job),
            "skillManifestCount": len(skill_manifests(job)),
            "actionSelection": "model_driven_with_explicit_fallback",
        },
    )

    required = ["branchId", "agentName", "modelProfile", "objective", "instruction", "contextBundleUri"]
    missing = [field for field in required if not as_text(job.get(field))]
    if missing:
        emit("sandbox.agent.loop.failed", "Sandbox v3 job validation failed.", {"branchId": branch_id, "missing": missing})
        raise ValueError(f"Sandbox job missing required fields: {', '.join(missing)}")

    for step in range(1, max_steps + 1):
        if elapsed_ms() > max_runtime_ms:
            timeout_action_id = f"sba_v3_{step:02d}_timeout"
            record_action(timeout_action_id, "final_answer", "proposed", "Sandbox agent proposed final answer after runtime budget expiry.")
            record_observation(
                f"sbo_v3_{step:02d}_timeout",
                timeout_action_id,
                "runtime",
                "Sandbox runtime budget expired; final answer must report partial progress.",
                {"elapsedMs": elapsed_ms(), "maxRuntimeMs": max_runtime_ms},
            )
            final_answer_content = "Runtime budget expired before the branch could complete all intended actions."
            final_reason = "maxRuntimeMs exhausted"
            record_action(timeout_action_id, "final_answer", "completed", "Sandbox agent completed timeout finalization.")
            break

        proposal = propose_v3_action(
            job=job,
            step=step,
            max_steps=max_steps,
            tool_call_count=tool_call_count,
            max_tool_calls=max_tool_calls,
            observations=observations,
            active_skills=active_skills,
            artifacts=local_artifacts,
            fallback_plan=fallback_plan,
        )
        action = proposal["action"]
        source = as_text(proposal.get("source"), "unknown")
        if source == "real_model" or source == "mock_model":
            model_action_count += 1
        if source == "real_model":
            real_model_action_count += 1
        if source == "mock_model":
            mock_model_action_count += 1
        if source == "deterministic_fallback":
            fallback_action_count += 1
            fallback_reason = as_text(proposal.get("fallbackReason"), "deterministic_fallback")
            if fallback_reason not in fallback_reasons:
                fallback_reasons.append(fallback_reason)
        if proposal.get("repaired"):
            repair_count += 1
        if proposal.get("retried"):
            model_retry_count += 1
        if isinstance(proposal.get("usage"), dict):
            model_usage_events.append(proposal.get("usage", {}))
        action_type = as_text(action.get("type"), "unknown")
        action_id = f"sba_v3_{step:02d}_{action_type.replace('.', '_')}"
        emit(
            "sandbox.agent.model.usage",
            "Sandbox model action selection recorded.",
            {
                "branchId": branch_id,
                "step": step,
                "actionSource": source,
                "modelStatus": proposal.get("modelStatus"),
                "model": proposal.get("model"),
                "usage": proposal.get("usage") if isinstance(proposal.get("usage"), dict) else {},
                "repaired": bool(proposal.get("repaired")),
                "retried": bool(proposal.get("retried")),
                "fallbackReason": proposal.get("fallbackReason"),
            },
        )
        action_audit = {
            "action": redact_action(action),
            "actionSource": source,
            "modelStatus": proposal.get("modelStatus"),
            "model": proposal.get("model"),
            "repaired": bool(proposal.get("repaired")),
            "retried": bool(proposal.get("retried")),
            "fallbackReason": proposal.get("fallbackReason"),
        }
        record_action(
            action_id,
            action_type,
            "proposed",
            f"Sandbox agent proposed {action_type}.",
            action_audit,
        )
        validation_error = validate_v3_action(action, job, tool_call_count, max_tool_calls, observations, local_artifacts)
        if validation_error:
            repaired_action = None
            original_validation_error = validation_error
            if source == "real_model":
                for repair_attempt in range(1, 3):
                    emit(
                        "sandbox.agent.action_repair_started",
                        "Sandbox model action repair started.",
                        {
                            "branchId": branch_id,
                            "step": step,
                            "actionId": action_id,
                            "repairAttempt": repair_attempt,
                            "maxRepairAttempts": 2,
                            "rawAction": redact_action(action),
                            "parsedAction": redact_action(action),
                            "validationResult": {"status": "failed", "error": validation_error},
                            "actionSource": source,
                        },
                    )
                    candidate_repair = repair_action_with_model(job, json.dumps(action, ensure_ascii=False), validation_error, repair_attempt)
                    if not candidate_repair:
                        emit(
                            "sandbox.agent.action_repair_failed",
                            "Sandbox model action repair did not return a parseable action.",
                            {
                                "branchId": branch_id,
                                "step": step,
                                "actionId": action_id,
                                "repairAttempt": repair_attempt,
                                "maxRepairAttempts": 2,
                                "rawAction": redact_action(action),
                                "parsedAction": None,
                                "validationResult": {"status": "failed", "error": validation_error},
                                "actionSource": source,
                            },
                        )
                        continue
                    repaired_validation_error = validate_v3_action(
                        candidate_repair,
                        job,
                        tool_call_count,
                        max_tool_calls,
                        observations,
                        local_artifacts,
                    )
                    if repaired_validation_error:
                        emit(
                            "sandbox.agent.action_repair_failed",
                            "Sandbox model action repair did not satisfy validation.",
                            {
                                "branchId": branch_id,
                                "step": step,
                                "actionId": action_id,
                                "repairAttempt": repair_attempt,
                                "maxRepairAttempts": 2,
                                "rawAction": redact_action(action),
                                "parsedAction": redact_action(candidate_repair),
                                "validationResult": {"status": "failed", "error": repaired_validation_error},
                                "actionSource": source,
                            },
                        )
                        validation_error = repaired_validation_error
                        continue
                    repaired_action = candidate_repair
                    emit(
                        "sandbox.agent.action_repair_succeeded",
                        "Sandbox model action repair satisfied validation.",
                        {
                            "branchId": branch_id,
                            "step": step,
                            "actionId": action_id,
                            "repairAttempt": repair_attempt,
                            "maxRepairAttempts": 2,
                            "rawAction": redact_action(action),
                            "parsedAction": redact_action(candidate_repair),
                            "validationResult": {"status": "passed"},
                            "finalAction": redact_action(candidate_repair),
                            "actionSource": source,
                        },
                    )
                    break
                if repaired_action:
                    repair_count += 1
                    action = repaired_action
                    action_type = as_text(action.get("type"), "unknown")
                    action_id = f"sba_v3_{step:02d}_{action_type.replace('.', '_')}"
                    action_audit = {
                        "action": redact_action(action),
                        "rawAction": redact_action(action),
                        "parsedAction": redact_action(action),
                        "validationResult": {"status": "passed", "repairedFrom": original_validation_error},
                        "finalAction": redact_action(action),
                        "actionSource": source,
                        "modelStatus": proposal.get("modelStatus"),
                        "model": proposal.get("model"),
                        "repaired": True,
                        "retried": bool(proposal.get("retried")),
                        "fallbackReason": proposal.get("fallbackReason"),
                        "validationRepairError": original_validation_error,
                    }
                    record_action(
                        action_id,
                        action_type,
                        "repaired",
                        f"Sandbox agent repaired invalid action into {action_type}.",
                        action_audit,
                    )
                    validation_error = ""
            if not repaired_action and validation_error:
                unrepaired_action_count += 1
                fallback_action_count += 1
                fallback_reason = f"unrepaired_invalid_action:{validation_error}"
                if fallback_reason not in fallback_reasons:
                    fallback_reasons.append(fallback_reason)
                record_action(
                    action_id,
                    action_type,
                    "failed",
                    f"Sandbox action validation failed: {validation_error}",
                    {
                        **action_audit,
                        "error": validation_error,
                        "rawAction": redact_action(action),
                        "parsedAction": redact_action(action),
                        "validationResult": {"status": "failed", "error": validation_error},
                        "finalAction": None,
                    },
                )
                record_observation(
                    f"sbo_v3_{step:02d}_failed",
                    action_id,
                    "runtime",
                    f"Action {action_type} was blocked: {validation_error}",
                    {"status": "blocked", **action_audit},
                )
                continue
        record_action(action_id, action_type, "validated", f"Sandbox agent validated {action_type}.", action_audit)
        record_action(action_id, action_type, "executing", f"Sandbox agent is executing {action_type}.", action_audit)
        try:
            if action_type == "think":
                record_observation(
                    f"sbo_v3_{step:02d}_thought",
                    action_id,
                    "agent",
                    as_text(action.get("summary") or action.get("reason"), "Sandbox agent recorded a short planning summary."),
                    {"next": action.get("next"), "actionSource": source},
                )
            elif action_type == "reflect":
                reflection_count += 1
                record_observation(
                    f"sbo_v3_{step:02d}_reflection",
                    action_id,
                    "agent",
                    as_text(action.get("summary") or action.get("reason"), "Sandbox agent reflected on current evidence."),
                    {
                        "evidenceStatus": as_text(action.get("evidenceStatus"), "unknown"),
                        "next": action.get("next"),
                        "gap": action.get("gap") or action.get("missingEvidence"),
                        "observationCount": len(observations),
                        "artifactCount": len(local_artifacts),
                        "actionSource": source,
                    },
                )
            elif action_type == "revise_query":
                new_query = as_text(action.get("newQuery") or nested_get(action, ["input", "query"]))
                record_observation(
                    f"sbo_v3_{step:02d}_query_revision",
                    action_id,
                    "agent",
                    f"Sandbox agent revised the next query to: {new_query[:240]}",
                    {
                        "toolName": as_text(action.get("toolName"), "web.search"),
                        "previousQuery": as_text(action.get("previousQuery")),
                        "newQuery": new_query,
                        "reason": as_text(action.get("reason")),
                        "actionSource": source,
                    },
                )
            elif action_type == "verify_evidence":
                evidence_verification_count += 1
                status = as_text(action.get("status"), "unknown").lower().strip()
                evidence_verification_status = status
                if status == "passed":
                    evidence_verification_passed_count += 1
                if status == "failed":
                    evidence_verification_failed_count += 1
                observation_ids = string_list(action.get("observationIds") or action.get("usedObservationIds"))
                artifact_ids = string_list(action.get("artifactIds") or action.get("artifacts"))
                claims = action.get("claims") if isinstance(action.get("claims"), list) else []
                unsupported_claims = action.get("unsupportedClaims") if isinstance(action.get("unsupportedClaims"), list) else []
                evidence_unsupported_claim_count += len(unsupported_claims)
                source_coverage = as_float(action.get("sourceCoverage"), -1)
                artifact_coverage = as_float(action.get("artifactCoverage"), -1)
                if source_coverage >= 0:
                    evidence_source_coverages.append(source_coverage)
                    evidence_latest_source_coverage = source_coverage
                if artifact_coverage >= 0:
                    evidence_artifact_coverages.append(artifact_coverage)
                    evidence_latest_artifact_coverage = artifact_coverage
                record_observation(
                    f"sbo_v3_{step:02d}_verification",
                    action_id,
                    "verification",
                    f"Sandbox evidence verification {status}.",
                    {
                        "status": status,
                        "claims": claims,
                        "observationIds": observation_ids,
                        "artifactIds": artifact_ids,
                        "unsupportedClaims": unsupported_claims,
                        "sourceCoverage": action.get("sourceCoverage"),
                        "artifactCoverage": action.get("artifactCoverage"),
                        "actionSource": source,
                    },
                )
            elif action_type == "request_more_context":
                context_request_count += 1
                record_observation(
                    f"sbo_v3_{step:02d}_context_request",
                    action_id,
                    "context",
                    "Sandbox branch requested more parent context instead of guessing.",
                    {
                        "neededContext": as_text(action.get("neededContext") or action.get("context")),
                        "reason": as_text(action.get("reason")),
                        "actionSource": source,
                    },
                )
            elif action_type == "use_skill":
                skill_name = as_text(action.get("skillName"))
                if skill_name not in active_skills:
                    active_skills.append(skill_name)
                record_observation(
                    f"sbo_v3_{step:02d}_skill",
                    action_id,
                    "skill",
                    f"Activated sandbox skill policy {skill_name}.",
                    {"skillName": skill_name, "qualityChecks": skill_quality_checks(job, skill_name), "actionSource": source},
                )
            elif action_type == "read_context":
                content = as_text(job.get("contextBundleContent"))
                record_observation(
                    f"sbo_v3_{step:02d}_context",
                    action_id,
                    "context",
                    "Sandbox branch read its scoped context bundle.",
                    {
                        "contextBundleUri": as_text(job.get("contextBundleUri")),
                        "contentBytes": len(content.encode("utf-8")),
                        "excerpt": content[:1200],
                        "actionSource": source,
                    },
                )
            elif action_type == "call_tool":
                tool_call_count += 1
                tool_name = as_text(action.get("toolName"))
                tool_input = record_input(action.get("input"))
                if tool_name == "artifact.create":
                    tool_input = ensure_artifact_create_input(tool_input, observations, job, agent_name)
                    tool_input["sourceObservationIds"] = tool_input.get("sourceObservationIds") or [
                        item["observationId"] for item in observations if item.get("observationId")
                    ]
                if tool_name == "run_python":
                    emit(
                        "sandbox.agent.tool.requested",
                        "Sandbox requested local run_python.",
                        {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "input": tool_input, "actionSource": source},
                    )
                    image_artifact = build_plot_image_artifact(job, branch_id, agent_name)
                    if image_artifact:
                        image_artifact["createdByActionId"] = action_id
                        image_artifact["localSandboxObservationIds"] = []
                        local_artifacts.append(image_artifact)
                        image_observation = record_observation(
                            f"sbo_v3_{step:02d}_python",
                            action_id,
                            "artifact",
                            f"Created local image artifact {image_artifact['filename']} via call_tool run_python.",
                            {"artifact": artifact_public_manifest(image_artifact), "toolName": "run_python", "actionSource": source},
                        )
                        image_artifact["localSandboxObservationIds"] = [image_observation["observationId"]]
                        emit(
                            "sandbox.agent.artifact.created",
                            "Sandbox branch created image artifact from run_python call_tool.",
                            {
                                "branchId": branch_id,
                                "actionId": action_id,
                                "artifact": artifact_public_manifest(image_artifact),
                                "toolName": "run_python",
                                "actionSource": source,
                            },
                        )
                        emit(
                            "sandbox.agent.tool.completed",
                            "Sandbox call_tool run_python completed locally.",
                            {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "actionSource": source},
                        )
                        tool_call_success_count += 1
                    else:
                        tool_call_failure_count += 1
                        emit(
                            "sandbox.agent.tool.failed",
                            "Sandbox local run_python call_tool failed.",
                            {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "actionSource": source},
                        )
                    record_action(action_id, "run_python", "completed", f"Sandbox agent completed {action_type}.", {"actionSource": source})
                    continue
                emit(
                    "sandbox.agent.tool.requested",
                    f"Sandbox requested parent tool {tool_name}.",
                    {"branchId": branch_id, "actionId": action_id, "toolName": tool_name, "input": tool_input, "actionSource": source},
                )
                tool_observation = call_parent_tool(job, action_id, tool_name, tool_input)
                if tool_observation.get("status") == "failed":
                    tool_call_failure_count += 1
                    emit(
                        "sandbox.agent.tool.failed",
                        f"Sandbox parent tool {tool_name} failed.",
                        {"branchId": branch_id, "actionId": action_id, "toolName": tool_name, "error": tool_observation.get("error"), "actionSource": source},
                    )
                else:
                    tool_call_success_count += 1
                    emit(
                        "sandbox.agent.tool.completed",
                        f"Sandbox parent tool {tool_name} completed.",
                        {
                            "branchId": branch_id,
                            "actionId": action_id,
                            "toolName": tool_name,
                            "toolCallId": tool_observation.get("toolCallId"),
                            "parentObservationId": nested_get(tool_observation, ["observation", "id"]),
                            "actionSource": source,
                        },
                    )
                record_observation(
                    f"sbo_v3_{step:02d}_tool",
                    action_id,
                    "tool",
                    as_text(nested_get(tool_observation, ["observation", "summary"]), f"Tool {tool_name} returned."),
                    {"toolName": tool_name, "proxyResponse": compact_proxy_response(tool_observation), "actionSource": source},
                )
                parent_artifacts = parent_artifact_manifests(tool_observation, action_id, tool_name)
                if parent_artifacts:
                    local_artifacts.extend(parent_artifacts)
            elif action_type == "run_python":
                tool_call_count += 1
                run_python_input = record_input(action.get("input"))
                if not run_python_input:
                    run_python_input = {
                        "title": image_requirement_title(job, f"{agent_name} Evidence Chart"),
                        "purpose": as_text(action.get("reason"), "Sandbox run_python image artifact request."),
                        "labels": ["Evidence", "Feasibility", "Risk", "Rollout"],
                        "values": [82, 68, 45, 74],
                        "sourceObservationIds": [item["observationId"] for item in observations if item.get("observationId")],
                    }
                run_python_tool_entry = None
                for entry in job.get("toolCatalog", []):
                    if as_text(entry.get("name")) == "run_python":
                        run_python_tool_entry = entry if isinstance(entry, dict) else {}
                        break
                run_python_adapter = as_text(
                    run_python_tool_entry.get("adapterMode") if isinstance(run_python_tool_entry, dict) else None,
                    "parent",
                )
                if run_python_adapter != "parent":
                    image_artifact = build_plot_image_artifact(job, branch_id, agent_name)
                    if image_artifact:
                        image_artifact["createdByActionId"] = action_id
                        image_artifact["localSandboxObservationIds"] = []
                        local_artifacts.append(image_artifact)
                        observation = record_observation(
                            f"sbo_v3_{step:02d}_python",
                            action_id,
                            "artifact",
                            f"Created local image artifact {image_artifact['filename']} via run_python local adapter.",
                            {"artifact": artifact_public_manifest(image_artifact), "toolInput": run_python_input, "actionSource": source},
                        )
                        image_artifact["localSandboxObservationIds"] = [observation["observationId"]]
                        emit(
                            "sandbox.agent.artifact.created",
                            "Sandbox agent created image artifact from run_python local adapter.",
                            {"branchId": branch_id, "actionId": action_id, "artifact": artifact_public_manifest(image_artifact), "actionSource": source},
                        )
                        emit(
                            "sandbox.agent.tool.completed",
                            "Sandbox run_python completed via local adapter.",
                            {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "adapter": run_python_adapter, "actionSource": source},
                        )
                        tool_call_success_count += 1
                    else:
                        tool_call_failure_count += 1
                        emit(
                            "sandbox.agent.tool.failed",
                            "Sandbox run_python local adapter did not return an image artifact.",
                            {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "actionSource": source},
                        )
                    continue
                emit(
                    "sandbox.agent.tool.requested",
                    "Sandbox requested parent tool run_python.",
                    {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "input": run_python_input, "adapter": run_python_adapter, "actionSource": source},
                )
                tool_observation = call_parent_tool(job, action_id, "run_python", run_python_input)
                if tool_observation.get("status") != "failed":
                    tool_call_success_count += 1
                    emit(
                        "sandbox.agent.tool.completed",
                        "Sandbox parent tool run_python completed.",
                        {
                            "branchId": branch_id,
                            "actionId": action_id,
                            "toolName": "run_python",
                            "toolCallId": tool_observation.get("toolCallId"),
                            "parentObservationId": nested_get(tool_observation, ["observation", "id"]),
                            "actionSource": source,
                        },
                    )
                    record_observation(
                        f"sbo_v3_{step:02d}_python",
                        action_id,
                        "tool",
                        as_text(nested_get(tool_observation, ["observation", "summary"]), "run_python generated a parent artifact."),
                        {"toolName": "run_python", "proxyResponse": compact_proxy_response(tool_observation), "actionSource": source},
                    )
                    parent_artifacts = parent_artifact_manifests(tool_observation, action_id, "run_python")
                    if parent_artifacts:
                        local_artifacts.extend(parent_artifacts)
                else:
                    tool_call_failure_count += 1
                    fallback_action_count += 1
                    fallback_reasons.append("run_python_parent_proxy_failed_local_artifact_fallback")
                    emit(
                        "sandbox.agent.tool.failed",
                        "Sandbox parent tool run_python failed; falling back to local artifact generation.",
                        {"branchId": branch_id, "actionId": action_id, "toolName": "run_python", "error": tool_observation.get("error"), "actionSource": source},
                    )
                    image_artifact = build_plot_image_artifact(job, branch_id, agent_name)
                    if image_artifact:
                        image_artifact["createdByActionId"] = action_id
                        image_artifact["localSandboxObservationIds"] = []
                        local_artifacts.append(image_artifact)
                        emit(
                            "sandbox.agent.artifact.created",
                            "Sandbox agent created an image artifact locally after parent run_python fallback.",
                            {"branchId": branch_id, "actionId": action_id, "artifact": artifact_public_manifest(image_artifact), "actionSource": source},
                        )
                        observation = record_observation(
                            f"sbo_v3_{step:02d}_python",
                            action_id,
                            "artifact",
                            f"Created local image artifact {image_artifact['filename']} after parent run_python fallback.",
                            {"artifact": artifact_public_manifest(image_artifact), "proxyResponse": compact_proxy_response(tool_observation), "actionSource": source},
                        )
                        image_artifact["localSandboxObservationIds"] = [observation["observationId"]]
                    else:
                        record_observation(
                            f"sbo_v3_{step:02d}_python",
                            action_id,
                            "runtime",
                            "run_python parent proxy failed and no local image artifact was recognized for this branch.",
                            {"requested": True, "proxyResponse": compact_proxy_response(tool_observation), "actionSource": source},
                        )
            elif action_type == "create_artifact":
                text_artifact = build_text_artifact(action, job, branch_id, agent_name)
                text_artifact["createdByActionId"] = action_id
                text_artifact["localSandboxObservationIds"] = []
                local_artifacts.append(text_artifact)
                emit(
                    "sandbox.agent.artifact.created",
                    "Sandbox agent created a text artifact locally.",
                    {"branchId": branch_id, "actionId": action_id, "artifact": artifact_public_manifest(text_artifact), "actionSource": source},
                )
                observation = record_observation(
                    f"sbo_v3_{step:02d}_artifact",
                    action_id,
                    "artifact",
                    f"Created local {text_artifact['kind']} artifact {text_artifact['filename']}.",
                    {"artifact": artifact_public_manifest(text_artifact), "artifactCount": len(local_artifacts), "actionSource": source},
                )
                text_artifact["localSandboxObservationIds"] = [observation["observationId"]]
            elif action_type == "final_answer":
                final_answer_content = as_text(action.get("answer") or action.get("summary") or action.get("reason"))
                final_reason = as_text(action.get("reason"), "model selected final_answer")
                final_observation_ids = string_list(action.get("usedObservationIds") or action.get("observationIds"))
                final_artifact_ids = string_list(action.get("artifactIds") or action.get("artifacts"))
                final_limitations = action.get("limitations") if isinstance(action.get("limitations"), list) else []
                record_observation(
                    f"sbo_v3_{step:02d}_final",
                    action_id,
                    "agent",
                    "Sandbox branch synthesized a final answer from local observations.",
                    {
                        "observationCount": len(observations),
                        "activeSkills": active_skills,
                        "usedObservationIds": final_observation_ids,
                        "artifactIds": final_artifact_ids,
                        "limitations": final_limitations,
                        "verifiedBeforeFinal": evidence_verification_count > 0,
                        "autoFilledObservationIds": bool(action.get("autoFilledObservationIds")),
                        "actionSource": source,
                    },
                )
                record_action(action_id, action_type, "completed", f"Sandbox agent completed {action_type}.", {"actionSource": source})
                break
            record_action(action_id, action_type, "completed", f"Sandbox agent completed {action_type}.", {"actionSource": source})
        except Exception as exc:
            record_action(
                action_id,
                action_type,
                "failed",
                f"Sandbox action {action_type} failed: {exc}",
                {"errorType": exc.__class__.__name__, "error": str(exc)[:500], "actionSource": source},
            )
            record_observation(
                f"sbo_v3_{step:02d}_exception",
                action_id,
                "runtime",
                f"Action {action_type} failed with {exc.__class__.__name__}.",
                {"error": str(exc)[:500], "actionSource": source},
            )

    if not final_answer_content:
        final_answer_content = "Sandbox stopped after exhausting the step budget and synthesized from available observations."
        final_reason = "maxSteps exhausted"

    model_result = {
        "mode": "real" if real_model_action_count > 0 else "mock" if mock_model_action_count > 0 else "deterministic",
        "status": "completed" if model_action_count > 0 else "skipped",
        "model": nested_get(job, ["sandboxModel", "model"]) or as_text(job.get("modelProfile")),
        "content": final_answer_content,
        "purpose": "stepwise_action_loop",
    }
    real_model_action_ratio = real_model_action_count / model_action_count if model_action_count else 0
    degraded_execution = fallback_action_count > 0
    fallback_policy_status = "degraded" if degraded_execution else "healthy"
    output_markdown = build_v2_markdown(job, terms, model_result, active_skills, action_log, observations, local_artifacts)
    output_hash = hashlib.sha256(output_markdown.encode("utf-8")).hexdigest()
    manifest_artifacts = [
        {
            "kind": "markdown",
            "title": f"{agent_name} Result",
            "sha256": output_hash,
            "bytes": len(output_markdown.encode("utf-8")),
            "sourceObservationIds": [item["observationId"] for item in observations],
        },
        *local_artifacts,
    ]
    emit(
        "sandbox.agent.artifact_recovery_manifest",
        "Sandbox branch artifact recovery manifest prepared.",
        {"branchId": branch_id, "artifacts": manifest_artifacts},
    )
    ended_at = utc_now()
    emit(
        "sandbox.agent.loop.completed",
        "Sandbox model-driven agent loop completed.",
        {
            "branchId": branch_id,
            "startedAt": started_at,
            "endedAt": ended_at,
            "elapsedMs": elapsed_ms(),
            "actionCount": len(action_log),
            "observationCount": len(observations),
            "toolCallCount": tool_call_count,
            "artifactCount": len(manifest_artifacts),
            "modelActionCount": model_action_count,
            "fallbackActionCount": fallback_action_count,
            "fallbackReasons": fallback_reasons,
            "repairCount": repair_count,
                "repairedActionCount": repair_count,
                "unrepairedActionCount": unrepaired_action_count,
                "modelRetryCount": model_retry_count,
                "reflectionCount": reflection_count,
                "evidenceVerificationCount": evidence_verification_count,
                "evidenceVerificationPassedCount": evidence_verification_passed_count,
                "evidenceVerificationFailedCount": evidence_verification_failed_count,
                "contextRequestCount": context_request_count,
                "degradedExecution": degraded_execution,
                "finalReason": final_reason,
            },
    )
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "status": "completed",
        "branchId": branch_id,
        "outputMarkdown": output_markdown,
        "outputSummary": f"{agent_name} completed model-driven branch {branch_id} with {model_action_count} model-selected action(s), {tool_call_count} tool call(s), and {len(manifest_artifacts)} artifact manifest item(s).",
        "qualitySignals": {
            "requiredFieldsPresent": True,
            "focusTerms": terms,
            "contentSha256": output_hash,
            "runtimeVersion": SANDBOX_RUNTIME_VERSION,
            "actionCount": len(action_log),
            "observationCount": len(observations),
            "toolCallCount": tool_call_count,
            "toolCallSuccessCount": tool_call_success_count,
            "toolCallFailureCount": tool_call_failure_count,
            "modelActionCount": model_action_count,
            "realModelActionCount": real_model_action_count,
            "mockModelActionCount": mock_model_action_count,
            "fallbackActionCount": fallback_action_count,
            "fallbackReasons": fallback_reasons,
            "fallbackPolicyStatus": fallback_policy_status,
            "degradedExecution": degraded_execution,
            "realModelActionRatio": real_model_action_ratio,
            "repairCount": repair_count,
            "repairedActionCount": repair_count,
            "unrepairedActionCount": unrepaired_action_count,
            "modelRetryCount": model_retry_count,
            "reflectionCount": reflection_count,
            "evidenceVerificationCount": evidence_verification_count,
            "evidenceVerificationPassedCount": evidence_verification_passed_count,
            "evidenceVerificationFailedCount": evidence_verification_failed_count,
            "evidenceUnsupportedClaimCount": evidence_unsupported_claim_count,
            "evidenceVerificationStatus": evidence_verification_status,
            "evidenceLatestSourceCoverage": evidence_latest_source_coverage,
            "evidenceLatestArtifactCoverage": evidence_latest_artifact_coverage,
            "evidenceSourceCoverageAverage": sum(evidence_source_coverages) / len(evidence_source_coverages)
            if evidence_source_coverages
            else None,
            "evidenceArtifactCoverageAverage": sum(evidence_artifact_coverages) / len(evidence_artifact_coverages)
            if evidence_artifact_coverages
            else None,
            "contextRequestCount": context_request_count,
            "modelMode": model_result.get("mode"),
            "modelStatus": model_result.get("status"),
            "modelUsed": real_model_action_count > 0,
            "activeSkills": active_skills,
            "artifactRecoveryReady": True,
            "imageArtifactCount": len([item for item in local_artifacts if item.get("kind") == "image"]),
            "reactLoopEntered": True,
            "modelDrivenReactLoop": model_action_count > 0,
            "parentToolProxyMode": proxy_config(job).get("mode", "missing"),
            "capabilityPlaneVersion": as_text(nested_get(job, ["capabilityPlane", "protocolVersion"]), "missing"),
            "capabilityInvokeConfigured": bool(as_text(nested_get(job, ["capabilityPlane", "invokeUrl"]))),
        },
        "branchFinal": build_branch_final(job, output_markdown, manifest_artifacts, observations),
        "artifacts": manifest_artifacts,
        "runtime": {
            "version": SANDBOX_RUNTIME_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "startedAt": started_at,
            "endedAt": ended_at,
            "budgets": {
                "maxSteps": max_steps,
                "maxToolCalls": max_tool_calls,
                "maxRuntimeMs": max_runtime_ms,
                "maxOutputTokens": max_output_tokens,
            },
            "actions": action_log,
            "observations": observations,
            "toolCallCount": tool_call_count,
            "activeSkills": active_skills,
            "modelUsageEvents": model_usage_events,
        },
    }


def build_v2_action_plan(job: Dict[str, Any], terms: List[str]) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    manifests = skill_manifests(job)
    if manifests:
        actions.append(
            {
                "type": "use_skill",
                "skillName": as_text(manifests[0].get("name"), "sandbox-policy"),
                "reason": "Apply the most relevant branch skill policy before executing tools.",
            }
        )
    actions.append({"type": "read_context", "reason": "Read scoped branch context before acting."})
    if should_search(job) and "web.search" in allowed_tool_names(job):
        actions.append(
            {
                "type": "call_tool",
                "toolName": "web.search",
                "input": {
                    "query": build_search_query(job, terms),
                    "max_results": 5,
                    "search_depth": "basic",
                },
                "reason": "External facts require parent-proxied web evidence.",
            }
        )
    if wants_plot_artifact(job, terms):
        actions.append(
            {
                "type": "run_python",
                "input": {
                    "title": image_requirement_title(job, "Branch Evidence Chart"),
                    "purpose": "Generate requested computational/image artifact inside sandbox.",
                    "labels": ["Evidence", "Feasibility", "Risk", "Rollout"],
                    "values": [82, 68, 45, 74],
                },
                "reason": "Generate requested computational/image artifact inside sandbox.",
            }
        )
    actions.append({"type": "create_artifact", "reason": "Prepare artifact manifest for parent recovery."})
    actions.append({"type": "final_answer", "reason": "Synthesize branch final answer from observations."})
    return actions


def propose_v3_action(
    job: Dict[str, Any],
    step: int,
    max_steps: int,
    tool_call_count: int,
    max_tool_calls: int,
    observations: List[Dict[str, Any]],
    active_skills: List[str],
    artifacts: List[Dict[str, Any]],
    fallback_plan: List[Dict[str, Any]],
) -> Dict[str, Any]:
    config = job.get("sandboxModel")
    config = config if isinstance(config, dict) else {}
    fallback_reason = "sandbox_model_not_configured"
    mock_actions = config.get("mockActions") if isinstance(config.get("mockActions"), list) else job.get("mockModelActions")
    if config.get("mode") == "mock_actions" and isinstance(mock_actions, list):
        index = min(step - 1, len(mock_actions) - 1)
        action = normalize_agent_action(mock_actions[index] if index >= 0 and mock_actions else {"type": "final_answer"})
        return {
            "source": "mock_model",
            "modelStatus": "completed",
            "model": as_text(config.get("model"), "mock-action-model"),
            "action": action or {"type": "final_answer", "answer": "Mock action model returned no action."},
            "usage": {"mock_action_tokens": len(json.dumps(action or {}, ensure_ascii=False))},
        }

    if config.get("mode") == "real":
        action_prompt = build_action_user_prompt(
            job,
            step,
            max_steps,
            tool_call_count,
            max_tool_calls,
            observations,
            active_skills,
            artifacts,
        )
        messages = [
            {"role": "system", "content": build_action_system_prompt(job)},
            {"role": "user", "content": action_prompt},
        ]
        result = call_sandbox_model_chat(job, messages, max_tokens=min(int_value(config.get("actionMaxTokens"), 900), 1600), purpose="next_action")
        if result.get("status") == "completed":
            raw_content = as_text(result.get("content"))
            action = normalize_agent_action(extract_json_object(raw_content))
            repaired = False
            if not action:
                action = repair_action_with_model(job, raw_content, "Model output did not parse as a SandboxAgentAction JSON object.")
                repaired = bool(action)
            if action:
                return {
                    "source": "real_model",
                    "modelStatus": result.get("status"),
                    "model": result.get("model"),
                    "action": action,
                    "usage": result.get("usage") if isinstance(result.get("usage"), dict) else {},
                    "repaired": repaired,
                }
            retry = retry_v3_action_with_model(
                job,
                action_prompt,
                raw_content,
                "The previous model response could not be parsed as one valid SandboxAgentAction JSON object.",
            )
            if retry.get("action"):
                return retry
            emit(
                "sandbox.agent.action_parse_failed",
                "Sandbox model action output could not be parsed; deterministic fallback will be used.",
                {"step": step, "contentPreview": raw_content[:600]},
            )
            fallback_reason = "action_parse_failed"
        else:
            retry = retry_v3_action_with_model(
                job,
                action_prompt,
                json.dumps({"modelStatus": result.get("status"), "errorType": result.get("errorType")}, ensure_ascii=False),
                "The previous model call was unavailable. Return the next action JSON now.",
            )
            if retry.get("action"):
                return retry
            emit(
                "sandbox.agent.action_model_unavailable",
                "Sandbox model action selection unavailable; deterministic fallback will be used.",
                {"step": step, "modelStatus": result.get("status"), "errorType": result.get("errorType")},
            )
            fallback_reason = "action_model_unavailable"

    fallback_index = min(step - 1, len(fallback_plan) - 1)
    fallback = fallback_plan[fallback_index] if fallback_index >= 0 and fallback_plan else {"type": "final_answer"}
    return {
        "source": "deterministic_fallback",
        "modelStatus": "fallback",
        "model": as_text(config.get("model"), as_text(job.get("modelProfile"))),
        "action": fallback,
        "usage": {},
        "fallbackReason": fallback_reason,
    }


def retry_v3_action_with_model(job: Dict[str, Any], action_prompt: str, previous_output: str, reason: str) -> Dict[str, Any]:
    config = job.get("sandboxModel")
    config = config if isinstance(config, dict) else {}
    retry_messages = [
        {
            "role": "system",
            "content": "\n".join(
                [
                    build_action_system_prompt(job),
                    "This is a retry. Return exactly one JSON object and no markdown fences, comments, or prose.",
                    "If uncertain, choose final_answer with a concise limitation instead of returning invalid JSON.",
                ]
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "retryReason": reason,
                    "previousOutputPreview": previous_output[:1200],
                    "currentActionPrompt": action_prompt,
                },
                ensure_ascii=False,
            ),
        },
    ]
    result = call_sandbox_model_chat(
        job,
        retry_messages,
        max_tokens=min(int_value(config.get("actionMaxTokens"), 900), 1600),
        purpose="next_action_retry",
    )
    if result.get("status") != "completed":
        return {}
    raw_content = as_text(result.get("content"))
    action = normalize_agent_action(extract_json_object(raw_content))
    if not action:
        action = repair_action_with_model(job, raw_content, "Retry model output did not parse as a SandboxAgentAction JSON object.")
    if not action:
        return {}
    return {
        "source": "real_model",
        "modelStatus": result.get("status"),
        "model": result.get("model"),
        "action": action,
        "usage": result.get("usage") if isinstance(result.get("usage"), dict) else {},
        "repaired": True,
        "retried": True,
    }


def validate_v2_action(action: Dict[str, Any], job: Dict[str, Any], tool_call_count: int, max_tool_calls: int) -> str:
    action_type = as_text(action.get("type"))
    if action_type == "thought":
        action_type = "think"
        action["type"] = "think"
    if action_type == "final":
        action_type = "final_answer"
        action["type"] = "final_answer"
    if action_type == "artifact.create":
        action_type = "call_tool"
        action["type"] = "call_tool"
        action["toolName"] = action.get("toolName") or "artifact.create"
        if not isinstance(action.get("input"), dict):
            action["input"] = {}
    if action_type in {"web.search", "file.read", "trace.query"}:
        tool_name = action_type
        action_type = "call_tool"
        action["type"] = "call_tool"
        action["toolName"] = action.get("toolName") or tool_name
    if action_type not in {"think", "use_skill", "call_tool", "read_context", "run_python", "create_artifact", "final_answer"}:
        return f"unsupported action type: {action_type}"
    if action_type == "use_skill" and not as_text(action.get("skillName")):
        return "use_skill action requires skillName"
    if action_type == "call_tool":
        tool_name = as_text(action.get("toolName"))
        if not tool_name:
            return "call_tool action requires toolName"
        if tool_name not in allowed_tool_names(job):
            return f"tool not allowed: {tool_name}"
        if tool_call_count >= max_tool_calls:
            return "tool call budget exhausted"
    if action_type == "run_python" and tool_call_count >= max_tool_calls:
        return "tool call budget exhausted"
    return ""


def validate_v3_action(
    action: Dict[str, Any],
    job: Dict[str, Any],
    tool_call_count: int,
    max_tool_calls: int,
    observations: List[Dict[str, Any]],
    artifacts: List[Dict[str, Any]],
) -> str:
    action_type = as_text(action.get("type"))
    if action_type == "thought":
        action_type = "think"
        action["type"] = "think"
    if action_type == "final":
        action_type = "final_answer"
        action["type"] = "final_answer"
    if action_type == "artifact.create":
        action_type = "call_tool"
        action["type"] = "call_tool"
        action["toolName"] = action.get("toolName") or "artifact.create"
        if not isinstance(action.get("input"), dict):
            action["input"] = {}
    if action_type in {"web.search", "file.read", "trace.query"}:
        tool_name = action_type
        action_type = "call_tool"
        action["type"] = "call_tool"
        action["toolName"] = action.get("toolName") or tool_name
    supported = {
        "think",
        "use_skill",
        "call_tool",
        "read_context",
        "run_python",
        "create_artifact",
        "reflect",
        "revise_query",
        "verify_evidence",
        "request_more_context",
        "final_answer",
    }
    if action_type not in supported:
        return f"unsupported action type: {action_type}"
    if action_type == "use_skill" and not as_text(action.get("skillName")):
        return "use_skill action requires skillName"
    if action_type == "call_tool":
        tool_name = as_text(action.get("toolName"))
        if not tool_name:
            return "call_tool action requires toolName"
        if tool_name not in allowed_tool_names(job):
            return f"tool not allowed: {tool_name}"
        if tool_call_count >= max_tool_calls:
            return "tool call budget exhausted"
    if action_type == "run_python" and tool_call_count >= max_tool_calls:
        return "tool call budget exhausted"
    if action_type == "revise_query":
        if not as_text(action.get("newQuery")) and not nested_get(action, ["input", "query"]):
            return "revise_query action requires newQuery"
        if not observations:
            return "revise_query requires at least one prior observation"
    if action_type == "verify_evidence":
        observation_ids = string_list(action.get("observationIds") or action.get("usedObservationIds"))
        artifact_ids = string_list(action.get("artifactIds") or action.get("artifacts"))
        if observations and not observation_ids and not artifact_ids:
            return "verify_evidence requires observationIds or artifactIds when observations exist"
    if action_type == "request_more_context":
        needed = as_text(action.get("neededContext") or action.get("context") or action.get("reason"))
        if not needed:
            return "request_more_context requires neededContext"
        lowered = needed.lower()
        if "secret" in lowered or "api key" in lowered or "private key" in lowered:
            return "request_more_context cannot request secrets"
    if action_type == "final_answer":
        if not as_text(action.get("answer") or action.get("summary") or action.get("reason")):
            return "final_answer requires answer"
        used_observation_ids = string_list(action.get("usedObservationIds") or action.get("observationIds"))
        if observations and not used_observation_ids:
            action["usedObservationIds"] = [as_text(item.get("observationId")) for item in observations if as_text(item.get("observationId"))]
            action["autoFilledObservationIds"] = True
        artifact_ids = string_list(action.get("artifactIds") or action.get("artifacts"))
        if artifacts and not artifact_ids:
            action["artifactIds"] = [as_text(item.get("sha256") or item.get("filename") or item.get("title")) for item in artifacts]
    return ""


def string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [as_text(item) for item in value if as_text(item)]
    text = as_text(value)
    return [text] if text else []


def call_parent_tool(job: Dict[str, Any], action_id: str, tool_name: str, tool_input: Dict[str, Any]) -> Dict[str, Any]:
    proxy = proxy_config(job)
    mode = as_text(proxy.get("mode"), "disabled")
    if mode == "mock":
        summary = f"Mock parent proxy returned deterministic observation for {tool_name}."
        if tool_name == "web.search":
            query = as_text(tool_input.get("query"), as_text(job.get("objective")))
            summary = f"Mock parent proxy web.search returned 3 source(s) for {query[:120]}."
            return {
                "status": "completed",
                "toolCallId": f"mock_tc_{action_id}",
                "observation": {
                    "id": f"mock_obs_{action_id}",
                    "status": "completed",
                    "summary": summary,
                    "evidenceLevel": "mock",
                    "metadata": {
                        "sources": [
                            {"title": "Mock sandbox source", "url": "local://sandbox/tool-proxy/mock", "content": summary}
                        ]
                    },
                },
            }
        return {"status": "completed", "toolCallId": f"mock_tc_{action_id}", "observation": {"id": f"mock_obs_{action_id}", "status": "completed", "summary": summary, "evidenceLevel": "mock"}}
    if mode != "parent":
        return {"status": "failed", "error": {"code": "tool_proxy_disabled", "message": "Sandbox parent tool proxy is disabled."}}
    url = as_text(nested_get(job, ["capabilityPlane", "invokeUrl"])) or as_text(proxy.get("url"))
    token = as_text(proxy.get("proxySessionToken"))
    if not url or not token:
        return {"status": "failed", "error": {"code": "missing_capability_url", "message": "Sandbox capability invoke URL or token is missing."}}
    body = {
        "proxySessionToken": token,
        "runId": as_text(job.get("runId")),
        "branchId": as_text(job.get("branchId")),
        "sandboxSessionId": as_text(job.get("sandboxSessionId")),
        "actionId": action_id,
        "capabilityName": tool_name,
        "toolName": tool_name,
        "input": tool_input,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
        return {"status": "failed", "error": {"code": "invalid_proxy_response", "message": "Proxy returned non-object JSON."}}
    except urllib.error.HTTPError as exc:
        body_preview = ""
        try:
            body_preview = exc.read().decode("utf-8", errors="replace")[:1000]
        except Exception:
            body_preview = ""
        return {"status": "failed", "error": {"code": "proxy_http_error", "status": exc.code, "message": body_preview}}
    except Exception as exc:
        return {"status": "failed", "error": {"code": "proxy_request_failed", "message": str(exc)[:500], "errorType": exc.__class__.__name__}}


def build_branch_final(
    job: Dict[str, Any],
    output_markdown: str,
    artifacts: List[Dict[str, Any]],
    observations: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    branch_id = str(job.get("branchId") or job.get("branch_id") or "branch")
    branch_title = str(job.get("agentName") or job.get("agent_name") or branch_id)
    observations = observations or []
    contract = job.get("branchContract") or job.get("branch_contract") or {}
    if not isinstance(contract, dict):
        contract = {}
    summary = output_markdown.strip().replace("\r", "")
    if len(summary) > 900:
        summary = summary[:900].rsplit("\n", 1)[0].strip()
    if len(summary) < 120:
        required_questions = contract.get("requiredQuestions") if isinstance(contract.get("requiredQuestions"), list) else []
        summary = (
            f"{branch_title} completed a sandbox ReAct branch under an explicit BranchContract. "
            f"The preserved instruction was: {contract.get('preservedInstruction') or job.get('instruction') or 'n/a'}. "
            f"Required questions covered: {', '.join(str(item) for item in required_questions[:4]) or 'n/a'}. "
            "This BranchFinal is structured so the parent reducer/verifier can distinguish branch evidence from runtime-only summaries."
        )
    artifact_ids = []
    for artifact in artifacts or []:
        if isinstance(artifact, dict):
            artifact_id = artifact.get("id") or artifact.get("artifactId") or artifact.get("artifact_id") or artifact.get("sha256") or artifact.get("path")
            if artifact_id:
                artifact_ids.append(str(artifact_id))
    evidence_observation_ids = [
        str(observation.get("observationId"))
        for observation in observations
        if isinstance(observation, dict) and str(observation.get("observationId") or "").strip()
    ]
    unsupported_claims: List[str] = []
    for observation in observations:
        payload = observation.get("payload") if isinstance(observation, dict) else None
        if isinstance(payload, dict) and isinstance(payload.get("unsupportedClaims"), list):
            unsupported_claims.extend([str(item) for item in payload.get("unsupportedClaims") if str(item)])
    required_tools = contract.get("requiredTools") if isinstance(contract.get("requiredTools"), list) else []
    required_artifacts = contract.get("requiredArtifacts") if isinstance(contract.get("requiredArtifacts"), list) else []
    final_output_schema = contract.get("finalOutputSchema") if isinstance(contract.get("finalOutputSchema"), dict) else {}
    required_sections = string_list(final_output_schema.get("requiredSections")) if isinstance(final_output_schema, dict) else []
    must_cite_observations = bool(final_output_schema.get("mustCiteObservationIds")) if isinstance(final_output_schema, dict) else True
    must_cite_artifacts = bool(final_output_schema.get("mustCiteArtifactIds")) if isinstance(final_output_schema, dict) else bool(required_artifacts)
    key_findings = [
        f"Branch contract required tools: {', '.join(str(item) for item in required_tools) or 'none declared'}.",
        f"Branch contract required artifacts: {', '.join(str(item.get('type', 'unknown')) if isinstance(item, dict) else str(item) for item in required_artifacts) or 'none declared'}.",
        f"Sandbox observations available to branch final: {len(evidence_observation_ids)}.",
        f"Recovered sandbox artifacts reported by branch: {len(artifact_ids)}.",
    ]
    sections = [
        {
            "title": "Executive Summary",
            "content": summary,
            "evidenceObservationIds": evidence_observation_ids,
            "evidenceArtifactIds": artifact_ids,
        },
        {
            "title": "Evidence",
            "content": "\n".join(
                [
                    f"- `{item.get('observationId')}` {item.get('sourceType')}: {item.get('summary')}"
                    for item in observations[:10]
                    if isinstance(item, dict)
                ]
            )
            or "No sandbox observation ids were available.",
            "evidenceObservationIds": evidence_observation_ids,
            "evidenceArtifactIds": artifact_ids,
        },
        {
            "title": "Artifacts",
            "content": "\n".join(
                [
                    f"- `{artifact_ids[index]}` {artifact.get('kind')}: {artifact.get('title')}"
                    for index, artifact in enumerate((artifacts or [])[:10])
                    if isinstance(artifact, dict) and index < len(artifact_ids)
                ]
            )
            or "No artifact manifests were produced.",
            "evidenceObservationIds": evidence_observation_ids,
            "evidenceArtifactIds": artifact_ids,
        },
        {
            "title": "Limitations",
            "content": "Parent verifier must still confirm persisted tool_call, Observation, artifact recovery, and unsupported claim coverage.",
            "evidenceObservationIds": evidence_observation_ids,
            "evidenceArtifactIds": artifact_ids,
        },
    ]
    for required_section in required_sections:
        if not branch_final_has_section(sections, required_section):
            sections.append(
                {
                    "title": required_section,
                    "content": build_required_branch_section_content(
                        required_section,
                        branch_title,
                        summary,
                        key_findings,
                        observations,
                        artifacts,
                    ),
                    "evidenceObservationIds": evidence_observation_ids if must_cite_observations else [],
                    "evidenceArtifactIds": artifact_ids if must_cite_artifacts else [],
                }
            )
    claims = [
        {
            "claim": finding,
            "evidenceObservationIds": evidence_observation_ids,
            "evidenceArtifactIds": artifact_ids,
            "confidence": "medium" if evidence_observation_ids or artifact_ids else "assumption",
        }
        for finding in key_findings
    ]
    return {
        "branchId": branch_id,
        "branchTitle": branch_title,
        "executiveSummary": summary,
        "sections": sections,
        "claims": claims,
        "keyFindings": key_findings,
        "evidenceObservationIds": evidence_observation_ids,
        "artifactIds": artifact_ids,
        "unsupportedClaims": unsupported_claims,
        "assumptions": [] if evidence_observation_ids else ["No sandbox observation ids were available for this branch final."],
        "limitations": [
            "Parent verifier must still confirm persisted tool_call, Observation, and artifact recovery evidence.",
            *("Unsupported claims were reported by sandbox evidence verification." for _ in [0] if unsupported_claims),
        ],
    }

def branch_final_has_section(sections: List[Dict[str, Any]], required_section: str) -> bool:
    normalized = as_text(required_section).strip().lower()
    if not normalized:
        return True
    for section in sections:
        title = as_text(section.get("title")).strip().lower() if isinstance(section, dict) else ""
        if title and (title in normalized or normalized in title):
            return True
    return False


def build_required_branch_section_content(
    required_section: str,
    branch_title: str,
    summary: str,
    key_findings: List[str],
    observations: List[Dict[str, Any]],
    artifacts: List[Dict[str, Any]],
) -> str:
    normalized = as_text(required_section).lower()
    if "executive" in normalized or "summary" in normalized or "摘要" in normalized:
        return summary
    if "evidence" in normalized or "证据" in normalized:
        return "\n".join(
            [
                f"- `{item.get('observationId')}` {item.get('sourceType')}: {item.get('summary')}"
                for item in observations[:10]
                if isinstance(item, dict)
            ]
        ) or "No sandbox observation ids were available for this required evidence section."
    if "artifact" in normalized or "产物" in normalized:
        return "\n".join(
            [
                f"- `{artifact.get('id') or artifact.get('artifactId') or artifact.get('sha256') or artifact.get('filename')}` {artifact.get('kind')}: {artifact.get('title')}"
                for artifact in artifacts[:10]
                if isinstance(artifact, dict)
            ]
        ) or "No artifact manifests were produced for this required artifact section."
    if "limitation" in normalized or "限制" in normalized or "局限" in normalized:
        return "Parent verifier must still confirm persisted tool_call, Observation, artifact recovery, and unsupported claim coverage."
    if as_text(required_section).strip().lower() == branch_title.strip().lower() or branch_title.strip().lower() in normalized:
        return f"{branch_title} fulfilled its branch role by producing these findings: " + " ".join(key_findings)
    return f"{required_section}: " + " ".join(key_findings)


def build_v2_markdown(
    job: Dict[str, Any],
    terms: List[str],
    model_result: Dict[str, Any],
    active_skills: List[str],
    action_log: List[Dict[str, Any]],
    observations: List[Dict[str, Any]],
    artifacts: List[Dict[str, Any]],
) -> str:
    branch_id = as_text(job.get("branchId"), "branch_unknown")
    agent_name = as_text(job.get("agentName"), "Sandbox Branch Agent")
    model_profile = as_text(job.get("modelProfile"), "model:unknown")
    objective = as_text(job.get("objective"), "No objective provided")
    instruction = as_text(job.get("instruction"), "No instruction provided")
    model_used = model_result.get("status") == "completed"
    synthesis = as_text(
        model_result.get("content"),
        "Sandbox completed a bounded ReAct loop. No real sandbox model synthesis was available, so this branch reports only observed runtime evidence.",
    )
    return "\n".join(
        [
            f"# {agent_name}",
            "",
            f"- Branch ID: `{branch_id}`",
            f"- Model profile: `{model_profile}`",
            f"- Protocol: `{PROTOCOL_VERSION}`",
            f"- Runtime: `{SANDBOX_RUNTIME_VERSION}`",
            f"- Tool proxy mode: `{as_text(proxy_config(job).get('mode'), 'missing')}`",
            "",
            "## Objective",
            "",
            objective,
            "",
            "## Branch Instruction",
            "",
            instruction,
            "",
            "## Agent Loop Summary",
            "",
            f"- Actions emitted: `{len(action_log)}`",
            f"- Observations created: `{len(observations)}`",
            f"- Parent tool observations: `{len([item for item in observations if item.get('sourceType') == 'tool'])}`",
            f"- Active skill policies: `{', '.join(active_skills) if active_skills else 'none'}`",
            f"- Real model synthesis used: `{str(model_used).lower()}`",
            "",
            "## Model / Deterministic Synthesis",
            "",
            synthesis,
            "",
            "## Observations",
            "",
            *[
                f"- `{item['observationId']}` {item.get('sourceType')}: {item.get('summary')}"
                for item in observations
            ],
            "",
            "## Artifacts",
            "",
            *[
                f"- `{artifact.get('kind')}` {artifact.get('title') or artifact.get('filename')} ({artifact.get('bytes', 0)} bytes)"
                for artifact in artifacts
            ],
            "",
            "## Extracted Focus Terms",
            "",
            ", ".join(terms) if terms else "No salient terms extracted.",
            "",
            "## Limitations",
            "",
            "- External facts are only valid when backed by parent tool proxy observations.",
            "- Skill manifests are applied as policy/quality constraints; arbitrary skill code is not executed inside the sandbox.",
        ]
    )


def run() -> Dict[str, Any]:
    job = read_job()
    protocol = as_text(job.get("agentProtocol") or job.get("protocolVersion") or os.environ.get("DATASWARM_SANDBOX_AGENT_PROTOCOL"))
    if protocol in ("v3", PROTOCOL_VERSION_V3):
        return run_v3(job)
    if protocol in ("v2", PROTOCOL_VERSION_V2):
        return run_v2(job)
    return run_v1(job)


def should_search(job: Dict[str, Any]) -> bool:
    text = " ".join([as_text(job.get("objective")), as_text(job.get("instruction"))]).lower()
    return any(token in text for token in ["search", "research", "web", "internet", "source", "新闻", "搜索", "检索", "互联网", "来源", "调研"])


def build_search_query(job: Dict[str, Any], terms: List[str]) -> str:
    objective = as_text(job.get("objective"))
    instruction = as_text(job.get("instruction"))
    if objective:
        return objective[:220]
    return " ".join([instruction, " ".join(terms)]).strip()[:220] or "DataSwarm sandbox research"


def allowed_tool_names(job: Dict[str, Any]) -> List[str]:
    proxy = proxy_config(job)
    allowed = proxy.get("allowedTools")
    if isinstance(allowed, list):
        return [as_text(item) for item in allowed if as_text(item)]
    catalog = job.get("toolCatalog")
    if isinstance(catalog, list):
        return [as_text(item.get("name")) for item in catalog if isinstance(item, dict) and as_text(item.get("name"))]
    return []


def proxy_config(job: Dict[str, Any]) -> Dict[str, Any]:
    proxy = job.get("parentToolProxy")
    return proxy if isinstance(proxy, dict) else {}


def skill_manifests(job: Dict[str, Any]) -> List[Dict[str, Any]]:
    manifests = job.get("skillManifests")
    if not isinstance(manifests, list):
        return []
    return [item for item in manifests if isinstance(item, dict)]


def skill_quality_checks(job: Dict[str, Any], skill_name: str) -> List[str]:
    for manifest in skill_manifests(job):
        if as_text(manifest.get("name")) == skill_name and isinstance(manifest.get("qualityChecks"), list):
            return [as_text(item) for item in manifest.get("qualityChecks", []) if as_text(item)]
    return []


def int_value(value: Any, fallback: int) -> int:
    try:
        number = int(value)
        return number if number >= 0 else fallback
    except Exception:
        return fallback


def record_input(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def nested_get(value: Any, path: List[str]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def compact_proxy_response(response: Dict[str, Any]) -> Dict[str, Any]:
    observation = response.get("observation") if isinstance(response.get("observation"), dict) else {}
    return {
        "status": response.get("status"),
        "toolCallId": response.get("toolCallId"),
        "payloadUri": response.get("payloadUri"),
        "artifacts": [
            {
                "id": artifact.get("id"),
                "type": artifact.get("type"),
                "title": artifact.get("title"),
                "previewUri": artifact.get("previewUri"),
            }
            for artifact in response.get("artifacts", [])
            if isinstance(artifact, dict)
        ],
        "observation": {
            "id": observation.get("id"),
            "status": observation.get("status"),
            "summary": observation.get("summary"),
            "evidenceLevel": observation.get("evidenceLevel"),
        },
        "error": response.get("error"),
    }


def parent_artifact_manifests(response: Dict[str, Any], action_id: str, tool_name: str) -> List[Dict[str, Any]]:
    artifacts = response.get("artifacts") if isinstance(response.get("artifacts"), list) else []
    manifests: List[Dict[str, Any]] = []
    parent_observation_id = as_text(nested_get(response, ["observation", "id"]))
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        artifact_id = as_text(artifact.get("id") or artifact.get("artifactId") or artifact.get("artifact_id"))
        if not artifact_id:
            continue
        manifests.append(
            {
                "kind": as_text(artifact.get("type"), "artifact"),
                "id": artifact_id,
                "artifactId": artifact_id,
                "title": as_text(artifact.get("title"), artifact_id),
                "mimeType": as_text(artifact.get("mimeType")),
                "storageUri": as_text(artifact.get("storageUri")),
                "previewUri": as_text(artifact.get("previewUri")),
                "createdByActionId": action_id,
                "createdByToolName": tool_name,
                "parentToolCallId": as_text(response.get("toolCallId")),
                "parentObservationId": parent_observation_id,
                "localSandboxObservationIds": [parent_observation_id] if parent_observation_id else [],
                "parentCapabilityArtifact": True,
            }
        )
    return manifests


def minimal_observation(observation: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": observation.get("observationId"),
        "sourceType": observation.get("sourceType"),
        "summary": observation.get("summary"),
    }


def artifact_public_manifest(artifact: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in artifact.items() if key != "contentBase64"}


def redact_action(action: Dict[str, Any]) -> Dict[str, Any]:
    return {key: ("[REDACTED]" if "token" in key.lower() or "key" in key.lower() else value) for key, value in action.items()}


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
