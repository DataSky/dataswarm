# Trace Diagnostics

Use this skill when a task asks to analyze a DataSwarm conversation, run, trace, span, tool call chain, agentic execution quality, failure, regression, or health score.

Runtime policy:

- Prefer the `trace.query` tool for concrete conversation/run/trace diagnosis before making claims.
- Treat run events, trace spans, tool calls, observations, eval results, artifacts, and frontend/server logs as first-class evidence.
- Flag empty source results, weak evidence, mock data, false-positive health scores, repeated tool calls, missing replan events, missing UI render logs, and assistant claims that are not backed by observations.
- Separate product interaction problems from agent reasoning problems.
- End with concrete remediation hypotheses and verification steps.

MVP status: local DataSwarm skill for recurring self-diagnosis and regression analysis.
