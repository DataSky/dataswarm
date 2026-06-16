# Frontend Design

Use this skill when DataSwarm needs user-facing design direction, UI implementation guidance, or critique for chat, artifacts, trace, skills, projects, settings, or swarm execution screens.

## Role

Act as the design lead for a serious agentic data platform. DataSwarm is not a landing page or generic dashboard: it is a workspace where a user gives instructions, watches agentic work unfold, inspects evidence, reviews artifacts, and diagnoses runtime behavior. Keep the interface calm, precise, and operational, but give it a distinctive point of view grounded in agents, traces, evidence, and data work.

## Activation Boundaries

Use this skill for:

- Conversation flow, streaming output, runtime cards, tool/skill cards, and recommended next actions.
- Artifact catalog, preview, source view, image/report rendering, download/open controls, and provenance metadata.
- Trace, span, event, observation, diagnostics, and self-improvement views.
- Skills, projects, settings, model access, E2B readiness, sandbox status, and data-retention controls.
- Visual style, typography, spacing, layout, responsive behavior, accessibility, and product copy.

Do not use this skill for backend-only changes unless users will see or operate the result.

## Design Workflow

1. **Pin the surface**
   Name the exact DataSwarm surface, its primary user, and the single job it must do. Avoid designing "a better UI" in the abstract.

2. **Draft a compact direction**
   Define a small token plan before implementation:
   - Color: 4-6 named roles with hex values or existing CSS variables.
   - Type: display, body, and mono/data roles.
   - Layout: shell, panels, scroll containers, and fixed regions.
   - Signature: one memorable interaction or structure that fits DataSwarm, such as branch timelines, evidence-backed artifact cards, or trace-linked runtime steps.

3. **Critique before building**
   Reject generic AI-dashboard defaults: decorative gradients, oversized hero sections, single-hue palettes, card piles, and ornamental status chips. Revise anything that could belong unchanged in a random SaaS tool.

4. **Implement with constraints**
   Treat layout constraints as product logic. Every fixed panel, message card, artifact preview, table, code block, iframe, long id, hash, URL, and trace payload must have explicit width, overflow, wrapping, and scroll behavior.

5. **Verify the experience**
   Check desktop and narrow widths. Confirm states for idle, running, streaming, completed, failed, disabled, empty, hover, focus, loading, and selected. Use trace/events/artifacts as evidence when diagnosing an existing bug.

## DataSwarm UI Principles

- **Workspace first**: the first screen should be the usable agent workspace, not a marketing composition.
- **Process is visible but not noisy**: runtime cards should be compact, expandable, and tied to trace/span/event records.
- **Artifacts are inspectable objects**: show type, status, size, provenance, quality signals, preview/source modes, open-in-new-window, and download without letting content break the shell.
- **Trace is a diagnostic surface**: use session/run/trace/span/event/observation hierarchy; separate facts from hypotheses.
- **Swarm needs topology**: branch agents should appear as branches, batches, timelines, and reduce/verify phases, not as loose assistant prose.
- **Skills are policies**: show purpose, activation guidance, required tools, preferred capabilities, risk, status, and quality checks.
- **Settings are control plane**: model access, E2B readiness, local data retention, and high-risk actions need clear grouping and safety language.

## Copy Rules

- Name controls by what users can do: "Open preview", "Disable skill", "Clear local conversations".
- Keep labels stable between action, loading state, result, and toast.
- Avoid vague errors. Say what failed, what was preserved, and what the next available action is.
- Use implementation terms only when the user is explicitly inspecting runtime internals.

## Verification Checklist

Before finalizing a UI change, confirm:

- No element expands outside the viewport or its panel.
- Long Chinese/English titles, ids, hashes, URLs, tables, code, and JSON are handled.
- Conversation scroll, fixed sidebars, artifact drawers, and input composer do not fight each other.
- Keyboard focus is visible and interactive elements have accessible names.
- Contrast, spacing, density, and type scale remain coherent across desktop and mobile.
- Motion is purposeful and respects reduced-motion expectations.
- The result can be tested through screenshots, DOM/layout checks, smoke tests, or trace/event assertions.
