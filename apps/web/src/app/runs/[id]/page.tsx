import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Clock3,
  GitBranch,
  Search,
  Server,
  Sparkles,
} from "lucide-react";
import { listApprovals } from "@/server/repositories/approvals";
import { listAgentSessions } from "@/server/repositories/agent-sessions";
import { getConversation } from "@/server/repositories/conversations";
import { listEvalResults } from "@/server/repositories/eval-results";
import { listRunEventsAfter, type RunEventEnvelope } from "@/server/repositories/events";
import { listObservedLogsForConversation } from "@/server/repositories/logs";
import { diagnoseConversation } from "@/server/repositories/diagnostics";
import { getRun } from "@/server/repositories/runs";
import { listSandboxSessions } from "@/server/repositories/sandbox-sessions";
import { listSelfImprovementCandidates, summarizeSelfImprovementCandidates } from "@/server/repositories/self-improvement";
import { getSystemSnapshot } from "@/server/repositories/system";
import { listTraceSpans } from "@/server/repositories/trace";
import { ImprovementActions, ImprovementDiagnosticsActions } from "./improvement-actions";

type RunPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    conversationId?: string;
    view?: string;
    q?: string;
  }>;
};

type TraceSpanRow = {
  id?: string;
  trace_id?: string;
  parent_span_id?: string | null;
  agent_session_id?: string | null;
  span_kind?: string;
  name?: string;
  status?: string;
  started_at?: string;
  ended_at?: string | null;
  attributes_json?: string | null;
};

const views = [
  "overview",
  "diagnostics",
  "sessions",
  "swarm",
  "trace",
  "spans",
  "events",
  "evals",
  "approvals",
  "improvements",
  "system",
  "logs",
] as const;

export default async function RunPage({ params, searchParams }: RunPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const view = views.includes(query.view as (typeof views)[number]) ? query.view : "overview";
  const q = (query.q ?? "").trim().toLowerCase();

  const run = await getRun(id);
  if (!run) {
    notFound();
  }

  const [conversation, diagnostics, events, spans, agentSessions, sandboxSessions, evals, approvals, improvements, systemSnapshot, logs] = await Promise.all([
    getConversation(run.conversationId),
    diagnoseConversation(run.conversationId),
    listRunEventsAfter(id, 0),
    listTraceSpans(id) as Promise<TraceSpanRow[]>,
    listAgentSessions(id),
    listSandboxSessions(id),
    listEvalResults(id),
    listApprovals(id),
    listSelfImprovementCandidates(id),
    getSystemSnapshot(),
    listObservedLogsForConversation(run.conversationId),
  ]);
  const backConversationId = query.conversationId ?? conversation?.id ?? run.conversationId;

  const filteredEvents = filterRows(events, q);
  const filteredSpans = filterRows(spans, q);
  const filteredAgents = filterRows(agentSessions, q);
  const filteredSandboxes = filterRows(sandboxSessions, q);
  const filteredEvals = filterRows(evals, q);
  const filteredApprovals = filterRows(approvals, q);
  const filteredImprovements = filterRows(improvements, q);
  const filteredLogs = filterRows(logs, q);
  const traceGroups = groupSpansByTrace(filteredSpans);

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <Link
              href={backConversationId ? `/?conversationId=${backConversationId}` : "/"}
              className="mb-2 inline-flex items-center gap-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <ArrowLeft className="size-4" />
              Back to conversation
            </Link>
            <div className="flex min-w-0 items-center gap-2">
              <Activity className="size-5 text-[var(--accent)]" />
              <h1 className="truncate text-lg font-semibold">Run Trace</h1>
              <StatusPill status={run.status} />
            </div>
            <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-[var(--muted)]">
              <span>{run.id}</span>
              <span>{run.modelProfile ?? "model:unknown"}</span>
              <span>{run.mode}</span>
            </div>
          </div>
          <form className="hidden min-w-[280px] items-center gap-2 border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 md:flex">
            <Search className="size-4 text-[var(--muted)]" />
            <input
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search session, trace, span, event..."
              className="w-full bg-transparent text-sm outline-none"
            />
            <input type="hidden" name="view" value={view} />
          </form>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-5 py-5">
        <nav className="flex gap-2 overflow-x-auto">
          {views.map((item) => (
            <Link
              key={item}
              href={`/runs/${run.id}?conversationId=${backConversationId}&view=${item}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`whitespace-nowrap border px-3 py-2 text-sm capitalize ${
                view === item
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {item}
            </Link>
          ))}
        </nav>

        {view === "overview" ? (
          <Overview
            runId={run.id}
            conversationTitle={conversation?.title ?? "Unknown conversation"}
            events={filteredEvents}
            spans={filteredSpans}
            agents={filteredAgents.length}
            sandboxes={filteredSandboxes.length}
            evals={filteredEvals.length}
            approvals={filteredApprovals.length}
            improvements={filteredImprovements.length}
          />
        ) : null}
        {view === "diagnostics" ? <Diagnostics diagnostic={diagnostics} /> : null}
        {view === "sessions" ? <Sessions agents={filteredAgents} sandboxes={filteredSandboxes} /> : null}
        {view === "swarm" ? <SwarmTimeline events={filteredEvents} /> : null}
        {view === "trace" ? <TraceGroups groups={traceGroups} /> : null}
        {view === "spans" ? <Spans spans={filteredSpans} /> : null}
        {view === "events" ? <Events events={filteredEvents} /> : null}
        {view === "evals" ? <Evals evals={filteredEvals} /> : null}
        {view === "approvals" ? <Approvals approvals={filteredApprovals} /> : null}
        {view === "improvements" ? <Improvements runId={run.id} improvements={filteredImprovements} /> : null}
        {view === "system" ? <SystemReadiness snapshot={systemSnapshot} /> : null}
        {view === "logs" ? <Logs logs={filteredLogs} /> : null}
      </div>
    </main>
  );
}

function Diagnostics({ diagnostic }: { diagnostic: Awaited<ReturnType<typeof diagnoseConversation>> }) {
  if (!diagnostic) {
    return (
      <Panel title="Conversation Diagnostics">
        <EmptyState label="No diagnostics available" />
      </Panel>
    );
  }
  const summary = diagnostic.summary;
  const runtime = summary.runtimeConsistency;
  const productHealth = summary.productHealth;
  const observations = summary.observations;
  const sandbox = summary.sandbox;
  const canonical = summary.canonicalVerification;
  const remediation = summary.remediation;
  const highRiskCount = remediation.filter((item) => item.severity === "high").length;

  return (
    <section className="grid gap-4">
      <Panel title="Conversation Health">
        <div className="grid gap-3">
          <div className="grid gap-2 md:grid-cols-4">
            <Metric icon={<Activity className="size-4" />} label="Runs" value={summary.runCount} />
            <Metric icon={<Activity className="size-4" />} label="Events" value={summary.eventCount} />
            <Metric icon={<GitBranch className="size-4" />} label="Trace Spans" value={summary.traceSpanCount} />
            <Metric icon={<Sparkles className="size-4" />} label="Remediation" value={`${remediation.length} total / ${highRiskCount} high`} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Stale Activities" value={runtime.staleRunningActivityCount} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Stale Spans" value={runtime.staleTraceSpanCount} />
            <Metric icon={<Server className="size-4" />} label="Sandbox Failures" value={sandbox.preflightFailureCount} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Canonical Failed" value={canonical.failed} />
          </div>
          <div className="grid gap-2">
            {summary.diagnosis.slice(0, 10).map((item) => (
              <div key={item} className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm leading-6 text-[var(--foreground)]">
                {item}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title="Runtime Consistency">
          <div className="grid gap-3">
            <div className="grid gap-2 md:grid-cols-2">
              <Metric icon={<Activity className="size-4" />} label="Activities" value={runtime.activityCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Open" value={runtime.openActivityCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Stale Activities" value={runtime.staleRunningActivityCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Stale Spans" value={runtime.staleTraceSpanCount} />
              <Metric icon={<GitBranch className="size-4" />} label="Swarm Plan Settled" value={runtime.swarmPlanSettledByLaterStageCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Terminal Runs" value={runtime.terminalRunCount} />
            </div>
            <DataCard
              title="Runtime Lifecycle Evidence"
              meta={["runtimeConsistency", `issues:${runtime.issues.length}`]}
              body={{
                openActivities: runtime.openActivities,
                staleTraceSpans: runtime.staleTraceSpans,
                issues: runtime.issues,
                diagnosis: runtime.diagnosis,
              }}
            />
          </div>
        </Panel>

        <Panel title="Product And Evidence Signals">
          <div className="grid gap-3">
            <div className="grid gap-2 md:grid-cols-2">
              <Metric icon={<Activity className="size-4" />} label="UI Logs" value={productHealth.uiLogCount} />
              <Metric icon={<Server className="size-4" />} label="Server Logs" value={productHealth.serverLogCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Observations" value={observations.observationCount} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Quality Issues" value={summary.qualityIssues.length} />
            </div>
            <DataCard
              title="Product Health"
              meta={["submit", "sse", "runtime_cards", "suggestions"]}
              body={{
                hasSubmitAccepted: productHealth.hasSubmitAccepted,
                hasServerMessageAccepted: productHealth.hasServerMessageAccepted,
                hasSseOpen: productHealth.hasSseOpen,
                hasRuntimeItemRenderSignal: productHealth.hasRuntimeItemRenderSignal,
                hasSuggestionsRenderSignal: productHealth.hasSuggestionsRenderSignal,
                issues: productHealth.issues,
              }}
            />
            <DataCard
              title="Observation Summary"
              meta={["observations", "evidence"]}
              body={{
                sourceTypes: observations.sourceTypes,
                sourceNames: observations.sourceNames,
                statuses: observations.statuses,
                evidenceLevels: observations.evidenceLevels,
                missingEnv: observations.missingEnv,
                verificationCommands: observations.verificationCommands,
              }}
            />
          </div>
        </Panel>
      </section>

      <Panel title="Structured Remediation">
        <div className="grid gap-3">
          {remediation.length === 0 ? (
            <EmptyState label="No remediation items" />
          ) : (
            remediation.map((item) => (
              <DataCard
                key={item.id}
                title={item.title}
                meta={[item.id, item.category, item.severity]}
                body={{
                  evidence: item.evidence,
                  recommendedAction: item.recommendedAction,
                  verificationCommands: item.verificationCommands,
                }}
              />
            ))
          )}
        </div>
      </Panel>
    </section>
  );
}

function Overview({
  runId,
  conversationTitle,
  events,
  spans,
  agents,
  sandboxes,
  evals,
  approvals,
  improvements,
}: {
  runId: string;
  conversationTitle: string;
  events: RunEventEnvelope[];
  spans: TraceSpanRow[];
  agents: number;
  sandboxes: number;
  evals: number;
  approvals: number;
  improvements: number;
}) {
  const latestEvents = events.slice(-8).reverse();
  return (
    <section className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="grid gap-3">
        <Metric icon={<Boxes className="size-4" />} label="Run" value={runId.slice(0, 18)} />
        <Metric icon={<Sparkles className="size-4" />} label="Conversation" value={conversationTitle} />
        <Metric icon={<Activity className="size-4" />} label="Events" value={events.length} />
        <Metric icon={<GitBranch className="size-4" />} label="Spans" value={spans.length} />
        <Metric icon={<Server className="size-4" />} label="Agents / Sandboxes" value={`${agents} / ${sandboxes}`} />
        <Metric icon={<CheckCircle2 className="size-4" />} label="Evals" value={evals} />
        <Metric icon={<CheckCircle2 className="size-4" />} label="Approvals" value={approvals} />
        <Metric icon={<Sparkles className="size-4" />} label="Improvements" value={improvements} />
      </div>
      <Panel title="Recent Events">
        <div className="grid gap-2">
          {latestEvents.length === 0 ? (
            <EmptyState label="No events" />
          ) : (
            latestEvents.map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      </Panel>
    </section>
  );
}

function Sessions({
  agents,
  sandboxes,
}: {
  agents: Awaited<ReturnType<typeof listAgentSessions>>;
  sandboxes: Awaited<ReturnType<typeof listSandboxSessions>>;
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <Panel title="Agent Sessions">
        <div className="grid gap-2">
          {agents.length === 0 ? (
            <EmptyState label="No agent sessions" />
          ) : (
            agents.map((agent) => (
              <DataCard
                key={agent.id}
                title={agent.name}
                meta={[agent.id, agent.role, agent.modelProfile, agent.status]}
                body={agent.metadata}
              />
            ))
          )}
        </div>
      </Panel>
      <Panel title="Sandbox Sessions">
        <div className="grid gap-2">
          {sandboxes.length === 0 ? (
            <EmptyState label="No sandbox sessions" />
          ) : (
            sandboxes.map((sandbox) => (
              <DataCard
                key={sandbox.id}
                title={sandbox.provider}
                meta={[sandbox.id, sandbox.agentSessionId ?? "agent:unknown", sandbox.status, sandbox.template ?? "template:none"]}
                body={{
                  externalSandboxId: sandbox.externalSandboxId,
                  resourceLimits: sandbox.resourceLimits,
                  envPolicy: sandbox.envPolicy,
                  metadata: sandbox.metadata,
                }}
              />
            ))
          )}
        </div>
      </Panel>
    </section>
  );
}

function SwarmTimeline({ events }: { events: RunEventEnvelope[] }) {
  const timeline = buildSwarmTimeline(events);
  const hasSwarm =
    timeline.plans.length > 0 ||
    timeline.branches.length > 0 ||
    timeline.merges.length > 0 ||
    timeline.verifications.length > 0 ||
    timeline.reviews.length > 0;

  return (
    <section className="grid gap-4">
      <Panel title="Swarm Tree">
        {!hasSwarm ? (
          <EmptyState label="No swarm events" />
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-5">
              <Metric icon={<GitBranch className="size-4" />} label="Plans" value={timeline.plans.length} />
              <Metric icon={<Server className="size-4" />} label="Branches" value={timeline.branches.length} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Reduce / Merge" value={timeline.merges.length} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Verify" value={timeline.verifications.length} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Review" value={timeline.reviews.length} />
            </div>
            {timeline.plans.map((plan) => (
              <div key={plan.seq} className="border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Plan: {plan.strategy || "unknown strategy"}</div>
                  <span className="font-mono text-[11px] text-[var(--muted)]">#{plan.seq}</span>
                </div>
                <div className="mt-2 text-sm text-[var(--muted)]">{plan.reason || "No plan reason recorded."}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {timeline.branches.length > 0 ? (
        <Panel title="Branch Timeline">
          <div className="grid gap-3">
            {timeline.branches.map((branch) => (
              <div key={branch.branchId} className="grid gap-3 border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{branch.title}</div>
                    <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-[var(--muted)]">
                      <span>{branch.branchId}</span>
                      {branch.modelProfile ? <span>{branch.modelProfile}</span> : null}
                      {branch.sandboxSessionId ? <span>sandbox:{branch.sandboxSessionId.slice(0, 18)}</span> : null}
                      {branch.artifactId ? <span>artifact:{branch.artifactId.slice(0, 18)}</span> : null}
                    </div>
                  </div>
                  <StatusPill status={branch.status} />
                </div>
                <div className="grid gap-2">
                  {branch.steps.map((step) => (
                    <div key={`${branch.branchId}-${step.seq}-${step.type}`} className="border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium">{step.label}</span>
                        <span className="font-mono text-[11px] text-[var(--muted)]">#{step.seq}</span>
                      </div>
                      {step.detail ? <div className="mt-1 text-xs leading-5 text-[var(--muted)]">{step.detail}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {timeline.merges.length > 0 ? (
        <Panel title="Reduce / Merge">
          <div className="grid gap-2">
            {timeline.merges.map((merge) => (
              <DataCard
                key={`${merge.type}-${merge.seq}`}
                title={merge.type}
                meta={[`#${merge.seq}`, merge.status, `completed:${merge.completedBranches}`, `failed:${merge.failedBranches}`]}
                body={merge.payload}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {timeline.verifications.length > 0 ? (
        <Panel title="Verify">
          <div className="grid gap-2">
            {timeline.verifications.map((verification) => (
              <DataCard
                key={`verify-${verification.seq}`}
                title="swarm.verify"
                meta={[
                  `#${verification.seq}`,
                  verification.status,
                  `checks:${verification.checkCount}`,
                  `completed:${verification.completedBranches}`,
                  `failed:${verification.failedBranches}`,
                ]}
                body={verification.payload}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {timeline.reviews.length > 0 ? (
        <Panel title="Review">
          <div className="grid gap-2">
            {timeline.reviews.map((review) => (
              <DataCard
                key={`review-${review.seq}`}
                title="swarm.review"
                meta={[`#${review.seq}`, review.status, `mode:${review.reviewMode}`, `findings:${review.findingCount}`]}
                body={review.payload}
              />
            ))}
          </div>
        </Panel>
      ) : null}
    </section>
  );
}

function TraceGroups({ groups }: { groups: Array<{ traceId: string; spans: TraceSpanRow[] }> }) {
  return (
    <section className="grid gap-4">
      {groups.length === 0 ? (
        <Panel title="Trace">
          <EmptyState label="No trace groups" />
        </Panel>
      ) : (
        groups.map((group) => (
          <Panel key={group.traceId} title={group.traceId}>
            <div className="grid gap-2">
              {group.spans.map((span) => (
                <div
                  key={span.id}
                  className="border border-[var(--line)] bg-[var(--surface-2)] p-3"
                  style={{ marginLeft: `${Math.min(depthOf(span, group.spans) * 18, 72)}px` }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{span.name ?? span.span_kind ?? span.id}</div>
                    <StatusPill status={span.status ?? "unknown"} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-[var(--muted)]">
                    <span>{span.id}</span>
                    <span>{span.span_kind}</span>
                    {span.parent_span_id ? <span>parent:{span.parent_span_id.slice(0, 12)}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ))
      )}
    </section>
  );
}

function Spans({ spans }: { spans: TraceSpanRow[] }) {
  return (
    <Panel title="Spans">
      <div className="grid gap-2">
        {spans.length === 0 ? (
          <EmptyState label="No spans" />
        ) : (
          spans.map((span) => (
            <DataCard
              key={span.id}
              title={span.name ?? span.span_kind ?? "span"}
              meta={[span.id ?? "", span.trace_id ?? "", span.span_kind ?? "", span.status ?? ""]}
              body={parseJsonObject(span.attributes_json)}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

function Events({ events }: { events: RunEventEnvelope[] }) {
  return (
    <Panel title="Events">
      <div className="grid gap-2">
        {events.length === 0 ? <EmptyState label="No events" /> : events.map((event) => <EventRow key={event.id} event={event} />)}
      </div>
    </Panel>
  );
}

function Evals({ evals }: { evals: Awaited<ReturnType<typeof listEvalResults>> }) {
  return (
    <Panel title="Evaluations">
      <div className="grid gap-2">
        {evals.length === 0 ? (
          <EmptyState label="No evaluations" />
        ) : (
          evals.map((item) => (
            <DataCard
              key={item.id}
              title={item.evalType}
              meta={[item.id, item.status, item.score === null ? "score:n/a" : `score:${item.score}`, item.traceSpanId ?? "span:none"]}
              body={{ summary: item.summary, checks: item.checks, artifactId: item.artifactId }}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

function Approvals({ approvals }: { approvals: Awaited<ReturnType<typeof listApprovals>> }) {
  return (
    <Panel title="Approvals">
      <div className="grid gap-2">
        {approvals.length === 0 ? (
          <EmptyState label="No approvals" />
        ) : (
          approvals.map((item) => (
            <DataCard
              key={item.id}
              title={item.requestSummary}
              meta={[
                item.id,
                item.status,
                item.riskLevel,
                item.toolCallId ?? "tool_call:none",
                item.resolvedAt ?? "resolved:none",
              ]}
              body={{
                requestPayloadUri: item.requestPayloadUri,
                decisionByUserId: item.decisionByUserId,
                decisionComment: item.decisionComment,
                metadata: item.metadata,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              }}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

function Improvements({
  runId,
  improvements,
}: {
  runId: string;
  improvements: Awaited<ReturnType<typeof listSelfImprovementCandidates>>;
}) {
  const summary = summarizeSelfImprovementCandidates(improvements);
  return (
    <Panel title="Self-Improvement Candidates">
      <div className="grid gap-3">
        <ImprovementDiagnosticsActions runId={runId} />
        {improvements.length === 0 ? (
          <EmptyState label="No queued improvements" />
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-4">
              <Metric icon={<Sparkles className="size-4" />} label="Candidates" value={summary.total} />
              <Metric icon={<Activity className="size-4" />} label="Queue Health" value={summary.queueHealth} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Open" value={summary.open} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="High Open" value={summary.highSeverityOpen} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Applied" value={summary.applied} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Applied Receipts" value={`${summary.appliedWithReceipt}/${summary.applied}`} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Missing Receipts" value={summary.appliedMissingReceipt} />
              <Metric icon={<CheckCircle2 className="size-4" />} label="Command Results" value={summary.receiptCommandResults} />
              <Metric icon={<Sparkles className="size-4" />} label="Pending Shadow" value={summary.pendingShadowTest} />
              <Metric icon={<Sparkles className="size-4" />} label="Ready Bundles" value={summary.readyForPatchBundle} />
              <Metric icon={<Sparkles className="size-4" />} label="Ready Review" value={summary.readyForHumanDecision} />
              <Metric icon={<Sparkles className="size-4" />} label="Awaiting Apply" value={summary.approvedAwaitingApplication} />
            </div>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
              <div className="text-xs font-semibold uppercase text-[var(--muted)]">Next Operator Actions</div>
              {summary.nextOperatorActions.length === 0 ? (
                <div className="mt-2 text-sm text-[var(--muted)]">No open self-improvement action required.</div>
              ) : (
                <div className="mt-2 grid gap-2">
                  {summary.nextOperatorActions.map((action) => (
                    <div key={action.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
                      <div className="text-sm font-medium">{action.label}</div>
                      <div className="flex items-center gap-2">
                        <StatusPill status={action.severity} />
                        <span className="font-mono text-[11px] text-[var(--muted)]">count:{action.count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
              <div className="text-xs font-semibold uppercase text-[var(--muted)]">Queue Distribution</div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <DataCard title="By Status" meta={["self_improvement", "status"]} body={summary.byStatus} />
                <DataCard title="By Severity" meta={["self_improvement", "severity"]} body={summary.bySeverity} />
                <DataCard title="By Type" meta={["self_improvement", "type"]} body={summary.byType} />
              </div>
            </div>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
              <div className="text-xs font-semibold uppercase text-[var(--muted)]">Verification Commands</div>
              {summary.requiredCommands.length === 0 ? (
                <div className="mt-2 text-sm text-[var(--muted)]">No explicit verification commands recorded.</div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {summary.requiredCommands.map((command) => (
                    <span key={command} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 font-mono text-[11px] text-[var(--muted)]">
                      {command}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {improvements.map((item) => {
              const requiredCommands = stringArray(item.verificationPlan.required_commands);
              const appliedReceipt = latestAppliedVerificationReceipt(item.proposal);
              return (
                <DataCard
                  key={item.id}
                  title={item.title}
                  meta={[
                    item.id,
                    item.candidateType,
                    item.status,
                    item.severity,
                    item.evalResultId ?? "eval:none",
                    item.traceSpanId ?? "span:none",
                    appliedReceipt ? "applied_receipt:present" : item.status === "applied" ? "applied_receipt:missing" : "applied_receipt:n/a",
                  ]}
                  actions={
                    <ImprovementActions
                      runId={runId}
                      candidateId={item.id}
                      status={item.status}
                      requiredCommands={requiredCommands}
                    />
                  }
                  body={{
                    rationale: item.rationale,
                    latestShadowTest: latestArrayItem(item.evidence.shadowTests),
                    patchBundle: item.proposal.patchBundle ?? null,
                    appliedVerificationReceipt: summarizeVerificationReceipt(appliedReceipt, requiredCommands),
                    decisions: Array.isArray(item.proposal.decisions) ? item.proposal.decisions : [],
                    evidence: item.evidence,
                    proposal: item.proposal,
                    verificationPlan: item.verificationPlan,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                  }}
                />
              );
            })}
          </>
        )}
      </div>
    </Panel>
  );
}

function SystemReadiness({ snapshot }: { snapshot: Awaited<ReturnType<typeof getSystemSnapshot>> }) {
  const e2b = snapshot.sandbox.e2b;
  return (
    <section className="grid gap-4">
      <Panel title="E2B Sandbox Readiness">
        <div className="grid gap-3">
          <div className="grid gap-2 md:grid-cols-4">
            <Metric icon={<Server className="size-4" />} label="Status" value={<StatusPill status={e2b.status} />} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Provider Selected" value={String(e2b.providerSelected)} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Template Verified" value={String(e2b.templateVerified)} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Live Smoke" value={String(e2b.liveSmokeVerified)} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Live Smoke Ready" value={String(e2b.readyForLiveSmoke)} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="Orchestrator Ready" value={String(e2b.readyForOrchestrator)} />
            <Metric icon={<Clock3 className="size-4" />} label="Timeout" value={`${e2b.timeoutMs}ms`} />
            <Metric icon={<GitBranch className="size-4" />} label="Retry Attempts" value={e2b.retryMaxAttempts} />
          </div>
          <DataCard
            title="Readiness Evidence"
            meta={[
              `template:${e2b.template}`,
              `templateSource:${e2b.templateSource}`,
              `templateVerification:${e2b.templateVerificationSource}`,
              `model:${e2b.modelMode}`,
              `secrets:${e2b.modelSecretsForwarding}`,
            ]}
            body={{
              sdkDependency: e2b.sdkDependency,
              requiredEnv: e2b.requiredEnv,
              missingEnv: e2b.missingEnv,
              templateVerificationReceiptPath: e2b.templateVerificationReceiptPath,
              templateBuildId: e2b.templateBuildId,
              templateVerifiedAt: e2b.templateVerifiedAt,
              liveSmokeReceiptPath: e2b.liveSmokeReceiptPath,
              liveSmokeReceiptStatus: e2b.liveSmokeReceiptStatus,
              liveSmokeVerifiedAt: e2b.liveSmokeVerifiedAt,
              liveSmokeExternalSandboxId: e2b.liveSmokeExternalSandboxId,
              liveSmokeElapsedMs: e2b.liveSmokeElapsedMs,
              sandboxAgentProtocol: e2b.sandboxAgentProtocol,
              readinessReasons: e2b.readinessReasons,
            }}
          />
        </div>
      </Panel>

      <Panel title="Operator Next Steps">
        <div className="grid gap-3">
          {e2b.nextSteps.length === 0 ? (
            <EmptyState label="No next steps recorded" />
          ) : (
            <ol className="grid gap-2">
              {e2b.nextSteps.map((step) => (
                <li key={step} className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)]">
                  {step}
                </li>
              ))}
            </ol>
          )}
          <DataCard
            title="Verification Commands"
            meta={["secret_safe", "operator_runnable"]}
            body={{
              commands: e2b.verificationCommands,
              templateBuildCommand: e2b.templateBuildCommand,
              liveSmokeCommand: e2b.liveSmokeCommand,
            }}
          />
        </div>
      </Panel>

      <Panel title="System Snapshot">
        <DataCard title="Local Storage Counts" meta={[snapshot.dataDir]} body={snapshot.counts} />
      </Panel>
    </section>
  );
}

function Logs({ logs }: { logs: Awaited<ReturnType<typeof listObservedLogsForConversation>> }) {
  return (
    <Panel title="Unified Logs">
      <div className="grid gap-2">
        {logs.length === 0 ? (
          <EmptyState label="No logs" />
        ) : (
          logs.map((log) => (
            <DataCard
              key={log.id}
              title={`${log.source}.${log.event}`}
              meta={[
                log.id,
                log.level,
                log.conversationId ?? "conversation:none",
                log.runId ?? "run:none",
                log.createdAt,
              ]}
              body={log.payload}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

function EventRow({ event }: { event: RunEventEnvelope }) {
  return (
    <div className="grid gap-2 border border-[var(--line)] bg-[var(--surface-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock3 className="size-4 text-[var(--muted)]" />
          <span className="text-sm font-medium">{event.type}</span>
        </div>
        <span className="font-mono text-[11px] text-[var(--muted)]">#{event.seq}</span>
      </div>
      <div className="flex flex-wrap gap-2 font-mono text-[11px] text-[var(--muted)]">
        <span>{event.id}</span>
        <span>{event.producer.kind}</span>
        {event.trace?.span_id ? <span>span:{event.trace.span_id.slice(0, 12)}</span> : null}
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs leading-5">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </div>
  );
}

function DataCard({
  title,
  meta,
  actions,
  body,
}: {
  title: string;
  meta: string[];
  actions?: React.ReactNode;
  body: unknown;
}) {
  return (
    <div className="grid gap-2 border border-[var(--line)] bg-[var(--surface-2)] p-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="flex flex-wrap gap-2 font-mono text-[11px] text-[var(--muted)]">
        {meta.filter(Boolean).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      {actions ? <div>{actions}</div> : null}
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs leading-5">
        {JSON.stringify(body, null, 2)}
      </pre>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border border-[var(--line)] bg-[var(--surface)]">
      <div className="border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-2 text-[var(--muted)]">
        {icon}
        <span className="text-xs uppercase">{label}</span>
      </div>
      <div className="mt-2 truncate font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const done = status === "completed";
  const failed = status === "failed" || status === "cancelled";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] ${
        done
          ? "bg-[var(--success-soft)] text-[var(--success)]"
          : failed
            ? "bg-[var(--warning-soft)] text-[var(--warning)]"
            : "bg-[var(--blue-soft)] text-[var(--blue)]"
      }`}
    >
      {status}
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-10 text-center text-sm text-[var(--muted)]">{label}</div>;
}

type SwarmTimelineModel = {
  plans: Array<{
    seq: number;
    strategy: string;
    reason: string;
  }>;
  branches: Array<{
    branchId: string;
    title: string;
    modelProfile: string;
    agentSessionId: string;
    sandboxSessionId: string;
    status: string;
    artifactId: string;
    steps: Array<{
      seq: number;
      type: string;
      label: string;
      detail: string;
    }>;
  }>;
  merges: Array<{
    seq: number;
    type: string;
    status: string;
    completedBranches: string;
    failedBranches: string;
    payload: Record<string, unknown>;
  }>;
  verifications: Array<{
    seq: number;
    status: string;
    checkCount: number;
    completedBranches: string;
    failedBranches: string;
    payload: Record<string, unknown>;
  }>;
  reviews: Array<{
    seq: number;
    status: string;
    reviewMode: string;
    findingCount: number;
    payload: Record<string, unknown>;
  }>;
};

function buildSwarmTimeline(events: RunEventEnvelope[]): SwarmTimelineModel {
  const plans: SwarmTimelineModel["plans"] = [];
  const branches = new Map<string, SwarmTimelineModel["branches"][number]>();
  const merges: SwarmTimelineModel["merges"] = [];
  const verifications: SwarmTimelineModel["verifications"] = [];
  const reviews: SwarmTimelineModel["reviews"] = [];

  for (const event of events) {
    const payload = recordValue(event.payload);
    if (event.type === "swarm.plan") {
      plans.push({
        seq: event.seq,
        strategy: stringValue(payload.strategy),
        reason: stringValue(payload.reason),
      });
      const branchPayloads = Array.isArray(payload.branches) ? payload.branches : [];
      for (const item of branchPayloads) {
        const branch = recordValue(item);
        const branchId = stringValue(branch.branch_id);
        if (!branchId) {
          continue;
        }
        const entry = ensureSwarmBranch(branches, branchId);
        entry.title = stringValue(branch.title) || entry.title;
        entry.modelProfile = stringValue(branch.model_profile) || entry.modelProfile;
      }
      continue;
    }

    if (event.type === "swarm.reduce" || event.type === "swarm.merge" || event.type === "swarm.cancelled") {
      merges.push({
        seq: event.seq,
        type: event.type,
        status: stringValue(payload.status) || "unknown",
        completedBranches: String(payload.completed_branch_count ?? "0"),
        failedBranches: String(payload.failed_branch_count ?? "0"),
        payload,
      });
      continue;
    }

    if (event.type === "swarm.verify") {
      verifications.push({
        seq: event.seq,
        status: stringValue(payload.status) || "unknown",
        checkCount: Array.isArray(payload.checks) ? payload.checks.length : 0,
        completedBranches: String(payload.completed_branch_count ?? "0"),
        failedBranches: String(payload.failed_branch_count ?? "0"),
        payload,
      });
      continue;
    }

    if (event.type === "swarm.review") {
      reviews.push({
        seq: event.seq,
        status: stringValue(payload.status) || "unknown",
        reviewMode: stringValue(payload.review_mode) || "unknown",
        findingCount: Number(payload.finding_count ?? 0),
        payload,
      });
      continue;
    }

    const branchId = stringValue(payload.branch_id);
    if (!branchId) {
      continue;
    }
    const branch = ensureSwarmBranch(branches, branchId);
    branch.agentSessionId = stringValue(payload.agent_session_id) || branch.agentSessionId;
    branch.sandboxSessionId = stringValue(payload.sandbox_session_id) || branch.sandboxSessionId;
    branch.modelProfile = stringValue(payload.model_profile) || branch.modelProfile;

    if (event.type === "swarm.branch.started") {
      branch.status = "running";
      branch.steps.push({
        seq: event.seq,
        type: event.type,
        label: "Branch started",
        detail: [branch.modelProfile, branch.sandboxSessionId ? `sandbox ${branch.sandboxSessionId}` : ""].filter(Boolean).join(" · "),
      });
      continue;
    }

    if (event.type === "sandbox.agent.event") {
      const agentEventType = stringValue(payload.agent_event_type);
      branch.steps.push({
        seq: event.seq,
        type: event.type,
        label: agentEventType || "Sandbox event",
        detail: stringValue(payload.message),
      });
      continue;
    }

    if (event.type === "swarm.branch.completed") {
      branch.status = "completed";
      branch.artifactId = stringValue(payload.artifact_id) || branch.artifactId;
      branch.steps.push({
        seq: event.seq,
        type: event.type,
        label: `Branch completed${payload.attempt ? ` (${payload.attempt}/${payload.max_attempts ?? "?"})` : ""}`,
        detail: stringValue(payload.output_summary),
      });
      continue;
    }

    if (event.type === "swarm.branch.failed") {
      branch.status = stringValue(payload.status) || "failed";
      branch.steps.push({
        seq: event.seq,
        type: event.type,
        label: `Branch ${branch.status}`,
        detail: [stringValue(payload.error_code), stringValue(payload.error)].filter(Boolean).join(": "),
      });
    }
  }

  return {
    plans,
    branches: Array.from(branches.values()).map((branch) => ({
      ...branch,
      steps: [...branch.steps].sort((a, b) => a.seq - b.seq),
    })),
    merges,
    verifications,
    reviews,
  };
}

function ensureSwarmBranch(branches: Map<string, SwarmTimelineModel["branches"][number]>, branchId: string) {
  const existing = branches.get(branchId);
  if (existing) {
    return existing;
  }
  const created: SwarmTimelineModel["branches"][number] = {
    branchId,
    title: branchId,
    modelProfile: "",
    agentSessionId: "",
    sandboxSessionId: "",
    status: "planned",
    artifactId: "",
    steps: [],
  };
  branches.set(branchId, created);
  return created;
}

function filterRows<T>(rows: T[], q: string): T[] {
  if (!q) {
    return rows;
  }
  return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
}

function groupSpansByTrace(spans: TraceSpanRow[]) {
  const groups = new Map<string, TraceSpanRow[]>();
  for (const span of spans) {
    const traceId = span.trace_id ?? "trace:unknown";
    groups.set(traceId, [...(groups.get(traceId) ?? []), span]);
  }
  return Array.from(groups, ([traceId, groupSpans]) => ({ traceId, spans: sortTraceSpans(groupSpans) }));
}

function sortTraceSpans(spans: TraceSpanRow[]) {
  return [...spans].sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
}

function depthOf(span: TraceSpanRow, spans: TraceSpanRow[]) {
  let depth = 0;
  let parentId = span.parent_span_id;
  while (parentId && depth < 8) {
    const parent = spans.find((item) => item.id === parentId);
    if (!parent) {
      break;
    }
    depth += 1;
    parentId = parent.parent_span_id;
  }
  return depth;
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function latestArrayItem(value: unknown) {
  return Array.isArray(value) && value.length > 0 ? value[value.length - 1] : null;
}

function latestAppliedVerificationReceipt(proposal: unknown) {
  const proposalRecord = recordValue(proposal);
  const decisions = Array.isArray(proposalRecord.decisions) ? proposalRecord.decisions : [];
  for (const item of [...decisions].reverse()) {
    const decision = recordValue(item);
    if (decision.action === "mark_applied" && decision.status === "applied") {
      const receipt = recordValue(decision.verificationReceipt);
      return Object.keys(receipt).length > 0 ? receipt : null;
    }
  }
  return null;
}

function summarizeVerificationReceipt(receipt: Record<string, unknown> | null, requiredCommands: string[]) {
  if (!receipt) {
    return null;
  }
  const commandResults = Array.isArray(receipt.commandResults) ? receipt.commandResults.map(recordValue) : [];
  const passedCommands = new Set(
    commandResults
      .filter((item) => item.status === "passed")
      .map((item) => stringValue(item.command))
      .filter(Boolean),
  );
  return {
    operatorConfirmed: receipt.operatorConfirmed === true,
    submittedAt: stringValue(receipt.submittedAt),
    requiredCommandCount: requiredCommands.length,
    passedCommandCount: requiredCommands.filter((command) => passedCommands.has(command)).length,
    complete: requiredCommands.length > 0 && requiredCommands.every((command) => passedCommands.has(command)),
    commandResults,
  };
}
