#!/usr/bin/env python3
"""DataSwarm E2B template entrypoint.

The parent Orchestrator normally runs code through E2B Code Interpreter, but
the template itself should still be self-describing and ready-checkable. This
entrypoint validates that the canonical sandbox agent is importable inside the
image and can optionally execute one job from DATASWARM_AGENT_JOB_JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict


def add_local_paths() -> None:
    current = Path(__file__).resolve()
    candidates = [
        current.parent,
        current.parent.parent / "agent",
        Path("/home/user/dataswarm"),
    ]
    for candidate in candidates:
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


def readiness_payload(agent: Any) -> Dict[str, Any]:
    return {
        "status": "ready",
        "template": os.environ.get("DATASWARM_SANDBOX_TEMPLATE", "dataswarm-agent-runtime"),
        "protocolVersion": getattr(agent, "PROTOCOL_VERSION", "unknown"),
        "runtimeVersion": getattr(agent, "SANDBOX_RUNTIME_VERSION", "unknown"),
        "entrypoint": "sandbox/e2b/entrypoint.py",
        "supportsJobEnv": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="DataSwarm E2B sandbox template entrypoint")
    parser.add_argument("--ready", action="store_true", help="print readiness JSON and exit")
    parser.add_argument("--run-job", action="store_true", help="run DATASWARM_AGENT_JOB_JSON through the sandbox agent")
    args = parser.parse_args()

    add_local_paths()
    import dataswarm_sandbox_agent as agent

    if args.ready:
        print(json.dumps(readiness_payload(agent), ensure_ascii=False), flush=True)
        return 0

    if args.run_job or os.environ.get("DATASWARM_AGENT_JOB_JSON"):
        return agent.main()

    print(json.dumps(readiness_payload(agent), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
