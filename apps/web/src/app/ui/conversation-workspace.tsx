"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Paperclip,
  PanelRightOpen,
  Sparkles,
  User,
  X,
} from "lucide-react";
import type { ArtifactRecord } from "@/server/repositories/artifacts";
import type { ConversationSummary, MessageRecord } from "@/server/repositories/conversations";
import type { RunEventEnvelope } from "@/server/repositories/events";
import type { ModelProfile } from "@/server/repositories/model-profiles";

type ConversationDetail = ConversationSummary & {
  messages: MessageRecord[];
};

type UiMessage = {
  id: string;
  runId: string | null;
  role: string;
  status: string;
  parts: UiMessagePart[];
};

type UiMessagePart =
  | { type: "text"; text: string }
  | { type: "artifact_preview"; artifactId: string };

type RuntimeActivityItem = {
  id: string;
  kind: "skill" | "tool" | "model" | "artifact" | "system";
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  detail?: string;
  details?: Array<{ label: string; value: string }>;
  preview?: Array<{ title?: string; url?: string }>;
};

type RuntimeActivityByRun = Record<string, RuntimeActivityItem[]>;

type ConversationTurn = {
  key: string;
  runId: string | null;
  user?: UiMessage;
  assistant?: UiMessage;
};

type SuggestionContext = {
  userText: string;
  assistantText: string;
  normalizedUser: string;
  normalizedAssistant: string;
  recentContext: string;
  topic: string;
};

type SuggestionCandidateSet = {
  primary: string[];
  fallback: string[];
};

const STREAM_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.cancel.requested",
  "message.created",
  "message.part.started",
  "message.part.delta",
  "message.part.completed",
  "message.completed",
  "model.call.started",
  "model.call.completed",
  "model.call.failed",
  "action.proposed",
  "action.validated",
  "action.blocked",
  "agent.replan.requested",
  "skill.selected",
  "tool.call.requested",
  "tool.call.started",
  "tool.call.output",
  "tool.call.completed",
  "tool.call.failed",
  "observation.created",
  "observation.failed",
  "artifact.create.started",
  "artifact.created",
  "artifact.preview.ready",
  "approval.decision.recorded",
  "eval.started",
  "eval.completed",
  "self_improvement.analysis.queued",
  "self_improvement.analysis.started",
  "self_improvement.analysis.completed",
  "self_improvement.analysis.failed",
  "self_improvement.candidates.queued",
  "self_improvement.diagnostics_analysis.started",
  "self_improvement.diagnostics_analysis.completed",
  "swarm.plan",
  "swarm.branch.started",
  "swarm.branch.completed",
  "swarm.branch.failed",
  "sandbox.agent.event",
  "sandbox.cancel.requested",
  "swarm.reduce",
  "swarm.merge",
  "swarm.verify",
  "swarm.review",
  "swarm.cancelled",
] as const;

export function ConversationWorkspace({
  selected,
  models,
  initialRunId,
  initialArtifacts,
  initialRunEvents,
}: {
  selected: ConversationDetail | null;
  models: ModelProfile[];
  initialRunId: string | null;
  initialArtifacts: ArtifactRecord[];
  initialRunEvents: RunEventEnvelope[];
}) {
  const initialMessages = useMemo(
    () =>
      (selected?.messages ?? []).map((message) => ({
        id: message.id,
        runId: message.runId,
        role: message.role,
        status: message.status,
        parts: partsToUiParts(message.parts, initialArtifacts),
      })),
    [initialArtifacts, selected?.messages],
  );
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [runtimeItemsByRun, setRuntimeItemsByRun] = useState<RuntimeActivityByRun>(() =>
    activityItemsByRunFromEvents(initialRunEvents),
  );
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>(() =>
    buildSuggestedPromptsFromMessages(initialMessages),
  );
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>(initialArtifacts);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(initialArtifacts[0]?.id ?? null);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(selected?.defaultModel ?? "dmx:gpt-5.5-1m");
  const [runStatus, setRunStatus] = useState("idle");
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId);
  const [error, setError] = useState<string | null>(null);

  const orchestratorModels = models.filter((item) => item.role === "orchestrator");
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? artifacts[0] ?? null;
  const turns = useMemo(() => buildConversationTurns(messages), [messages]);
  const canSend = Boolean(selected?.id && input.trim() && runStatus !== "running" && runStatus !== "submitting");
  const canRunQuickPrompt = Boolean(selected?.id && runStatus !== "running" && runStatus !== "submitting");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const latestSeqByRunRef = useRef<Record<string, number>>({});
  const assistantMessageIdByRunRef = useRef<Record<string, string>>({});
  const localMessageCounterRef = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, runtimeItemsByRun, runStatus, suggestedPrompts]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
    };
  }, []);

  function setSuggestedPromptsFromMessages(nextMessages: UiMessage[]) {
    const prompts = buildSuggestedPromptsFromMessages(nextMessages);
    setSuggestedPrompts(prompts);
    if (prompts.length > 0) {
      const latestUser = [...nextMessages].reverse().find((message) => message.role === "user");
      logUi("suggestions.rendered", {
        conversationId: selected?.id,
        promptCount: prompts.length,
        prompts,
        latestUserPreview: latestUser ? messageText(latestUser).slice(0, 120) : null,
      });
    }
  }

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!selected || !text || runStatus === "running" || runStatus === "submitting") {
      logUi("message.submit.skipped", {
        hasSelected: Boolean(selected),
        inputLength: text.length,
        runStatus,
      });
      return;
    }

    localMessageCounterRef.current += 1;
    const localUserMessageId = `local-user-${localMessageCounterRef.current}`;
    setInput("");
    setError(null);
    setSuggestedPrompts([]);
    setRunStatus("submitting");
    logUi("message.submit.start", {
      conversationId: selected.id,
      localUserMessageId,
      model,
      textLength: text.length,
      textPreview: text.slice(0, 120),
    });
    setMessages((current) => [
      ...current,
      { id: localUserMessageId, runId: null, role: "user", status: "completed", parts: [{ type: "text", text }] },
    ]);

    try {
      const response = await fetch(`/api/conversations/${selected.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model, mode: "agent" }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        logUi("message.submit.failed_response", {
          conversationId: selected.id,
          localUserMessageId,
          status: response.status,
          error: payload.error,
        });
        setRunStatus("failed");
        setError(payload.error ?? "Message submission failed.");
        return;
      }

      const payload = (await response.json()) as { message_id: string; run_id: string; stream_url: string };
      logUi("message.submit.accepted", {
        conversationId: selected.id,
        localUserMessageId,
        serverMessageId: payload.message_id,
        runId: payload.run_id,
        streamUrl: payload.stream_url,
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === localUserMessageId
            ? { ...message, id: payload.message_id, runId: payload.run_id }
            : message,
        ),
      );
      setRuntimeItemsByRun((current) => ({ ...current, [payload.run_id]: current[payload.run_id] ?? [] }));
      setActiveRunId(payload.run_id);
      setRunStatus("running");
      latestSeqByRunRef.current[payload.run_id] = 0;
      connectRunStream(payload.stream_url, payload.run_id);
    } catch (sendError) {
      logUi("message.submit.error", {
        conversationId: selected.id,
        localUserMessageId,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
      setRunStatus("failed");
      setError(sendError instanceof Error ? sendError.message : "Message submission failed.");
    }
  }

  function connectRunStream(streamUrl: string, runId: string, fromSeq = 0) {
    streamRef.current?.close();
    const eventSourceUrl = withFromSeq(streamUrl, fromSeq);
    latestSeqByRunRef.current[runId] = Math.max(latestSeqByRunRef.current[runId] ?? 0, fromSeq);
    logUi("events.connect", { conversationId: selected?.id, runId, streamUrl: eventSourceUrl, fromSeq });
    const source = new EventSource(eventSourceUrl);
    streamRef.current = source;
    const setAssistantMessageId = (messageId: string) => {
      assistantMessageIdByRunRef.current[runId] = messageId;
    };
    const getAssistantMessageId = () => assistantMessageIdByRunRef.current[runId] ?? null;
    const seenEventIds = new Set<string>();

    const shouldApplyEvent = (parsed: RunEventEnvelope) => {
      if (seenEventIds.has(parsed.id)) {
        return false;
      }
      seenEventIds.add(parsed.id);
      const latestSeq = latestSeqByRunRef.current[runId] ?? fromSeq;
      if (parsed.seq > latestSeq + 1) {
        logUi("events.seq_gap", {
          conversationId: selected?.id,
          runId,
          expectedSeq: latestSeq + 1,
          receivedSeq: parsed.seq,
          eventId: parsed.id,
          eventType: parsed.type,
        });
        source.close();
        if (streamRef.current === source) {
          streamRef.current = null;
          connectRunStream(streamUrl, runId, latestSeq);
        }
        return false;
      }
      if (parsed.seq > latestSeq) {
        latestSeqByRunRef.current[runId] = parsed.seq;
      }
      return true;
    };

    source.addEventListener("open", () => {
      logUi("events.open", { conversationId: selected?.id, runId, streamUrl: eventSourceUrl });
    });

    for (const eventType of STREAM_EVENT_TYPES) {
      source.addEventListener(eventType, (event) => {
        const parsed = parseEvent(event);
        if (!shouldApplyEvent(parsed)) {
          return;
        }
        logUi(`events.${eventType}`, summarizeRunEvent(parsed));
        handleRunEvent(parsed, source, {
          getAssistantMessageId,
          setAssistantMessageId,
        });
      });
    }

    source.onerror = () => {
      logUi("events.error", { conversationId: selected?.id, runId, streamUrl: eventSourceUrl, readyState: source.readyState });
      setRunStatus((current) => (current === "completed" ? current : "failed"));
      setError("Run event stream disconnected.");
      void refreshConversation();
      source.close();
      if (streamRef.current === source) {
        streamRef.current = null;
      }
    };

    function handleRunEvent(
      parsed: RunEventEnvelope,
      source: EventSource,
      context: {
        getAssistantMessageId: () => string | null;
        setAssistantMessageId: (messageId: string) => void;
      },
    ) {
      const item = activityItemFromEvent(parsed);
      if (item) {
        upsertRuntimeItem(parsed.run_id, item);
      }

      if (parsed.type === "message.created") {
        const payload = asPayload(parsed.payload);
        if (payload.role !== "assistant") {
          return;
        }
        const messageId = String(payload.message_id);
        context.setAssistantMessageId(messageId);
        setMessages((current) => {
          if (current.some((message) => message.id === messageId)) {
            return current.map((message) =>
              message.id === messageId ? { ...message, runId: parsed.run_id, status: "streaming" } : message,
            );
          }
          return [
            ...current,
            {
              id: messageId,
              runId: parsed.run_id,
              role: "assistant",
              status: "streaming",
              parts: [{ type: "text", text: "" }],
            },
          ];
        });
        return;
      }

      if (parsed.type === "message.part.delta") {
        const delta = asPayload(parsed.payload).delta as { text?: string } | undefined;
        if (!delta?.text) {
          return;
        }
        const assistantMessageId = context.getAssistantMessageId();
        if (!assistantMessageId) {
          void refreshConversation();
          return;
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId ? { ...message, parts: appendTextDelta(message.parts, delta.text ?? "") } : message,
          ),
        );
        return;
      }

      if (parsed.type === "message.completed") {
        const assistantMessageId = context.getAssistantMessageId();
        if (!assistantMessageId) {
          void refreshConversation();
        } else {
          setMessages((current) =>
            current.map((message) => (message.id === assistantMessageId ? { ...message, status: "completed" } : message)),
          );
        }
        void refreshConversation();
        return;
      }

      if (parsed.type === "artifact.created" || parsed.type === "artifact.preview.ready") {
        void refreshArtifacts();
        return;
      }

      if (parsed.type === "run.completed") {
        setRunStatus("completed");
        void refreshConversation();
        void refreshArtifacts();
        source.close();
        if (streamRef.current === source) {
          streamRef.current = null;
        }
        return;
      }

      if (parsed.type === "run.failed") {
        const runError = asPayload(parsed.payload).error as { message?: string } | undefined;
        setRunStatus("failed");
        setError(runError?.message ?? "Run failed.");
        void refreshConversation();
        source.close();
        if (streamRef.current === source) {
          streamRef.current = null;
        }
        return;
      }

      if (parsed.type === "run.cancelled") {
        setRunStatus("cancelled");
        void refreshConversation();
        void refreshArtifacts();
        source.close();
        if (streamRef.current === source) {
          streamRef.current = null;
        }
      }
    }
  }

  function upsertRuntimeItem(runId: string, item: RuntimeActivityItem) {
    setRuntimeItemsByRun((current) => {
      const currentRunItems = current[runId] ?? [];
      const index = currentRunItems.findIndex((candidate) => candidate.id === item.id);
      const nextRunItems = [...currentRunItems];
      if (index === -1) {
        nextRunItems.push(item);
      } else {
        nextRunItems[index] = mergeRuntimeActivityItem(nextRunItems[index], item);
      }
      return { ...current, [runId]: settleSwarmPlanItems(nextRunItems) };
    });
    logUi("runtime.item.upsert", {
      conversationId: selected?.id,
      runId,
      itemId: item.id,
      itemKind: item.kind,
      itemTitle: item.title,
      itemStatus: item.status,
    });
  }

  async function refreshConversation() {
    if (!selected?.id) {
      return;
    }
    logUi("conversation.refresh.start", { conversationId: selected.id });
    const response = await fetch(`/api/conversations/${selected.id}`);
    if (!response.ok) {
      logUi("conversation.refresh.failed", { conversationId: selected.id, status: response.status });
      return;
    }
    const payload = (await response.json()) as { conversation: ConversationDetail };
    logUi("conversation.refresh.ok", {
      conversationId: selected.id,
      messageCount: payload.conversation.messages.length,
      lastMessageRole: payload.conversation.messages.at(-1)?.role,
      lastMessageStatus: payload.conversation.messages.at(-1)?.status,
    });
    const nextMessages = payload.conversation.messages.map((message) => ({
        id: message.id,
        runId: message.runId,
        role: message.role,
        status: message.status,
        parts: partsToUiParts(message.parts, artifacts),
      }));
    setMessages(nextMessages);
    setSuggestedPromptsFromMessages(nextMessages);
  }

  async function refreshArtifacts() {
    if (!selected?.id) {
      return;
    }
    logUi("artifacts.refresh.start", { conversationId: selected.id });
    const response = await fetch(`/api/conversations/${selected.id}/artifacts`);
    if (!response.ok) {
      logUi("artifacts.refresh.failed", { conversationId: selected.id, status: response.status });
      return;
    }
    const payload = (await response.json()) as { artifacts: ArtifactRecord[] };
    logUi("artifacts.refresh.ok", {
      conversationId: selected.id,
      artifactCount: payload.artifacts.length,
      artifactIds: payload.artifacts.map((artifact) => artifact.id),
    });
    setArtifacts(payload.artifacts);
    setSelectedArtifactId((current) => current ?? payload.artifacts[0]?.id ?? null);
  }

  return (
    <section className="relative h-screen min-h-0 overflow-hidden bg-[var(--workspace)]">
      <div className="flex h-screen min-w-0 flex-col">
        <header className="flex min-h-16 items-center justify-between border-b border-[var(--line)] bg-[var(--surface)] px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{selected?.title ?? "Conversation"}</h1>
              <StatusPill status={runStatus} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-[var(--muted)]">
              <span>{activeRunId ? activeRunId.slice(0, 18) : selected?.id?.slice(0, 18) ?? "pending"}</span>
              <span>{model}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeRunId ? (
              <a
                className="inline-flex items-center gap-2 border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                href={`/runs/${activeRunId}${selected?.id ? `?conversationId=${selected.id}` : ""}`}
                target="_blank"
                rel="noreferrer"
              >
                <Activity className="size-4" />
                Trace
              </a>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-2 border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
              onClick={() => setArtifactPanelOpen(true)}
              aria-label="Open artifacts"
            >
              <PanelRightOpen className="size-4" />
              Artifacts
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {!selected ? (
            <EmptyPanel title="No conversation selected" />
          ) : messages.length === 0 ? (
            <EmptyPanel title="Ready" />
          ) : (
            <div className="mx-auto max-w-4xl space-y-4">
              {turns.map((turn) => (
                <ConversationTurnView
                  key={turn.key}
                  turn={turn}
                  runtimeItems={turn.runId ? runtimeItemsByRun[turn.runId] ?? [] : []}
                  artifacts={turn.runId ? artifacts.filter((artifact) => artifact.runId === turn.runId) : []}
                  onArtifactClick={(artifactId) => {
                    setSelectedArtifactId(artifactId);
                    setArtifactPanelOpen(true);
                  }}
                />
              ))}
              {(runStatus === "running" || runStatus === "submitting") && (
                <div className="flex items-center gap-2 pl-11 text-sm text-[var(--muted)]">
                  <Loader2 className="size-4 animate-spin" />
                  DataSwarm is working...
                </div>
              )}
              {suggestedPrompts.length > 0 ? (
                <SuggestedPromptList
                  prompts={suggestedPrompts}
                  disabled={!canRunQuickPrompt}
                  onSelect={(prompt) => void sendMessage(prompt)}
                />
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <footer className="border-t border-[var(--line)] bg-[var(--surface)] p-4">
          {error ? <div className="mb-3 text-sm text-[var(--danger)]">{error}</div> : null}
          <form
            className="mx-auto grid max-w-4xl gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              className="min-h-20 resize-none bg-transparent px-2 py-2 text-sm outline-none"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder="Ask DataSwarm to research, analyze, visualize, or coordinate agents..."
              disabled={!selected || runStatus === "running" || runStatus === "submitting"}
            />
            <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] pt-2">
              <div className="flex min-w-0 items-center gap-2">
                <select
                  className="h-10 max-w-[220px] border border-[var(--line)] bg-[var(--surface)] px-3 text-sm outline-none"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={runStatus === "running" || runStatus === "submitting"}
                  aria-label="Select model"
                >
                  {orchestratorModels.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled
                  className="inline-flex size-10 items-center justify-center border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] disabled:opacity-60"
                  aria-label="Attach files"
                >
                  <Paperclip className="size-4" />
                </button>
              </div>
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex size-10 items-center justify-center bg-[var(--accent)] text-white disabled:bg-[var(--disabled)] disabled:text-[var(--muted)]"
                aria-label="Send message"
              >
                {runStatus === "running" || runStatus === "submitting" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </button>
            </div>
          </form>
        </footer>
      </div>

      <ArtifactPanel
        artifacts={artifacts}
        selectedArtifact={selectedArtifact}
        open={artifactPanelOpen}
        onOpenChange={setArtifactPanelOpen}
        onSelect={setSelectedArtifactId}
      />
    </section>
  );
}

function ConversationTurnView({
  turn,
  runtimeItems,
  artifacts,
  onArtifactClick,
}: {
  turn: ConversationTurn;
  runtimeItems: RuntimeActivityItem[];
  artifacts: ArtifactRecord[];
  onArtifactClick: (artifactId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {turn.user ? <MessageBubble message={turn.user} artifacts={[]} onArtifactClick={onArtifactClick} /> : null}
      {turn.assistant || runtimeItems.length > 0 ? (
        <article className="flex justify-start gap-3">
          <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
            <Bot className="size-4" />
          </div>
          <div className="grid min-w-0 w-full max-w-3xl gap-3">
            {runtimeItems.length > 0 ? <RuntimeActivityList items={runtimeItems} /> : null}
            {turn.assistant ? (
              <MessageCard message={turn.assistant} artifacts={artifacts} onArtifactClick={onArtifactClick} />
            ) : (
              <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase text-[var(--muted)]">
                  <span>assistant</span>
                  <span>streaming</span>
                </div>
                <div className="flex items-center gap-2 text-sm leading-6 text-[var(--muted)]">
                  <Loader2 className="size-4 animate-spin" />
                  DataSwarm is working...
                </div>
              </div>
            )}
          </div>
        </article>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  artifacts,
  onArtifactClick,
}: {
  message: UiMessage;
  artifacts: ArtifactRecord[];
  onArtifactClick: (artifactId: string) => void;
}) {
  const isUser = message.role === "user";
  const Icon = isUser ? User : Bot;

  return (
    <article className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon className="size-4" />
        </div>
      ) : null}
      <div className={`min-w-0 max-w-[78%] ${isUser ? "order-first" : ""}`}>
        <MessageCard message={message} artifacts={artifacts} onArtifactClick={onArtifactClick} />
      </div>
      {isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--user-surface)] text-[var(--user-foreground)]">
          <Icon className="size-4" />
        </div>
      ) : null}
    </article>
  );
}

function MessageCard({
  message,
  artifacts,
  onArtifactClick,
}: {
  message: UiMessage;
  artifacts: ArtifactRecord[];
  onArtifactClick: (artifactId: string) => void;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={`min-w-0 max-w-full overflow-hidden rounded-lg border px-4 py-3 ${
        isUser
          ? "border-[var(--user-line)] bg-[var(--user-surface)] text-[var(--user-foreground)]"
          : "border-[var(--line)] bg-[var(--surface)]"
      }`}
    >
      <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase text-[var(--muted)]">
        <span>{message.role}</span>
        <span>{message.status}</span>
      </div>
      <div className="min-w-0 space-y-3 text-[15px] leading-7">
        {message.parts.map((part, index) =>
          part.type === "text" ? (
            <MessageContentRenderer key={index} text={cleanMockCopy(part.text)} />
          ) : (
            <button
              key={index}
              type="button"
              onClick={() => onArtifactClick(part.artifactId)}
              className="inline-flex items-center gap-2 border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-xs text-[var(--accent)] hover:border-[var(--accent)]"
            >
              <FileText className="size-3.5" />
              {part.artifactId.slice(0, 18)}
            </button>
          ),
        )}
      </div>
      {!isUser && artifacts.length > 0 ? (
        <div className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3">
          <div className="text-xs font-semibold uppercase text-[var(--muted)]">Artifacts</div>
          <div className="grid gap-2">
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onArtifactClick(artifact.id)}
                className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2 text-left hover:border-[var(--accent-muted)]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ArtifactIcon type={artifact.type} />
                  <span className="truncate text-sm font-medium">{artifact.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--muted)]">{artifact.type}</span>
                </div>
                {artifact.type === "image" ? (
                  <iframe
                    src={`/api/artifacts/${artifact.id}/preview`}
                    title={`${artifact.title} preview`}
                    className="h-72 w-full rounded-md border border-[var(--line)] bg-white"
                  />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeActivityList({ items }: { items: RuntimeActivityItem[] }) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());

  function toggleItem(itemId: string) {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  return (
    <div className="grid gap-2">
      {items.map((item) => {
        const isExpanded = expandedItems.has(item.id);
        const hasDetails = Boolean(item.detail || item.details?.length || item.preview?.length);
        return (
          <div key={item.id} className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 text-left"
              onClick={() => hasDetails && toggleItem(item.id)}
              aria-expanded={isExpanded}
            >
              <div className="flex min-w-0 items-center gap-2">
                {hasDetails ? (
                  isExpanded ? (
                    <ChevronDown className="size-4 shrink-0 text-[var(--muted)]" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-[var(--muted)]" />
                  )
                ) : null}
                <ActivityIcon item={item} />
                <span className="truncate text-sm font-medium">{item.title}</span>
              </div>
              <StatusPill status={item.status} />
            </button>
            {isExpanded ? (
              <div className="mt-2 rounded-md border border-[var(--line)] bg-[var(--surface)] p-2">
                {item.detail ? <div className="text-sm leading-6 text-[var(--muted)]">{item.detail}</div> : null}
                {item.details && item.details.length > 0 ? (
                  <dl className="mt-2 grid gap-1 text-xs leading-5">
                    {item.details.map((detail) => (
                      <div key={`${item.id}:${detail.label}`} className="grid gap-1 sm:grid-cols-[128px_minmax(0,1fr)]">
                        <dt className="font-mono uppercase text-[var(--muted)]">{detail.label}</dt>
                        <dd className="min-w-0 break-words text-[var(--foreground)]">{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {item.preview && item.preview.length > 0 ? (
                  <div className="mt-2 grid gap-1">
                    {item.preview.slice(0, 5).map((source, index) => (
                      <a
                        key={`${source.url ?? source.title ?? index}`}
                        href={sanitizeMarkdownHref(source.url ?? "#")}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--accent)] hover:border-[var(--accent)]"
                      >
                        {index + 1}. {source.title ?? source.url ?? "Source"}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ActivityIcon({ item }: { item: RuntimeActivityItem }) {
  if (item.status === "running" || item.status === "queued") {
    return <Loader2 className="size-4 shrink-0 animate-spin text-[var(--blue)]" />;
  }
  if (item.kind === "tool") {
    return <Activity className="size-4 shrink-0 text-[var(--accent)]" />;
  }
  if (item.kind === "artifact") {
    return <FileText className="size-4 shrink-0 text-[var(--blue)]" />;
  }
  return <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" />;
}

function SuggestedPromptList({
  prompts,
  disabled,
  onSelect,
}: {
  prompts: string[];
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className="ml-11 max-w-3xl rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2.5">
      <div className="mb-2 text-xs font-semibold uppercase text-[var(--muted)]">Recommended next questions</div>
      <div className="flex flex-wrap gap-1.5">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(prompt)}
            className="rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--foreground)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function ArtifactPanel({
  artifacts,
  selectedArtifact,
  open,
  onOpenChange,
  onSelect,
}: {
  artifacts: ArtifactRecord[];
  selectedArtifact: ArtifactRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (artifactId: string) => void;
}) {
  return (
    <aside
      className={`fixed inset-y-0 right-0 z-30 flex w-full max-w-[440px] flex-col border-l border-[var(--line)] bg-[var(--surface)] shadow-2xl transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex h-16 items-center justify-between border-b border-[var(--line)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Artifacts</h2>
          <p className="font-mono text-xs text-[var(--muted)]">
            {artifacts.length} files · {formatBytes(artifacts.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0))}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center border border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
          onClick={() => onOpenChange(false)}
          aria-label="Close artifacts"
        >
          <X className="size-4" />
        </button>
      </div>

      {open ? (
        <div className="grid min-h-0 flex-1 grid-rows-[240px_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b border-[var(--line)] p-3">
            <div className="grid gap-2">
              {artifacts.length === 0 ? (
                <div className="px-2 py-8 text-sm text-[var(--muted)]">No artifacts</div>
              ) : (
                artifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    onClick={() => onSelect(artifact.id)}
                    className={`grid w-full gap-1 border px-3 py-2 text-left ${
                      selectedArtifact?.id === artifact.id
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--surface-2)] hover:border-[var(--accent-muted)]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ArtifactIcon type={artifact.type} />
                      <span className="truncate text-sm font-medium">{artifact.title}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 font-mono text-xs text-[var(--muted)]">
                      <span>{artifact.type}</span>
                      <span>{formatBytes(artifact.sizeBytes)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--muted)]">
                      <span>{artifact.status}</span>
                      <span>{artifact.contentHash ? truncateHash(artifact.contentHash) : "no hash"}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="min-h-0 p-3">
            {selectedArtifact ? (
              <div className="flex h-full flex-col">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{selectedArtifact.title}</h3>
                    <p className="font-mono text-xs text-[var(--muted)]">{selectedArtifact.id}</p>
                  </div>
                  <div className="flex gap-1">
                    <a
                      className="inline-flex size-8 items-center justify-center border border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
                      href={`/api/artifacts/${selectedArtifact.id}/download`}
                      aria-label="Download artifact"
                    >
                      <Download className="size-4" />
                    </a>
                    <a
                      className="inline-flex size-8 items-center justify-center border border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
                      href={`/api/artifacts/${selectedArtifact.id}/preview`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open artifact preview"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  </div>
                </div>
                <div className="mb-3 grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <ArtifactMeta label="Type" value={selectedArtifact.type} />
                    <ArtifactMeta label="Status" value={selectedArtifact.status} />
                    <ArtifactMeta label="Version" value={selectedArtifact.version ? `v${selectedArtifact.version}` : "n/a"} />
                    <ArtifactMeta label="Size" value={formatBytes(selectedArtifact.sizeBytes)} />
                    <ArtifactMeta label="Run" value={selectedArtifact.runId} />
                    <ArtifactMeta label="Hash" value={selectedArtifact.contentHash ? truncateHash(selectedArtifact.contentHash) : "n/a"} />
                  </div>
                  {Object.keys(selectedArtifact.metadata).length > 0 ? (
                    <details className="rounded-md border border-[var(--line)] bg-white px-2 py-1.5">
                      <summary className="cursor-pointer font-medium text-[var(--muted)]">Metadata</summary>
                      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                        {JSON.stringify(selectedArtifact.metadata, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
                <iframe
                  title={`${selectedArtifact.title} preview`}
                  src={`/api/artifacts/${selectedArtifact.id}/preview`}
                  className="min-h-0 flex-1 border border-[var(--line)] bg-white"
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">No preview</div>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function ArtifactMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-white px-2 py-1.5">
      <div className="text-[10px] uppercase text-[var(--muted)]">{label}</div>
      <div className="truncate font-mono text-[11px]">{value}</div>
    </div>
  );
}

type PreviewSchemaKind = "html.document" | "html.fragment";

type PreviewSpec = {
  kind: PreviewSchemaKind;
  title: string;
  renderer: "sandboxed-iframe";
  schema: {
    type: PreviewSchemaKind;
    contentField: "html";
    maxInlineHeight: number;
  };
  data: {
    html: string;
    bytes: number;
    lines: number;
  };
};

const previewCatalog: Record<PreviewSchemaKind, (input: { spec: PreviewSpec }) => ReactNode> = {
  "html.document": HtmlPreviewCard,
  "html.fragment": HtmlPreviewCard,
};

function MessageContentRenderer({ text }: { text: string }) {
  return <MarkdownText text={text} />;
}

function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="min-w-0 max-w-full space-y-3 overflow-hidden">
      {blocks.map((block, index) => {
        const previewSpec = previewSpecFromBlock(block);
        if (previewSpec) {
          const PreviewRenderer = previewCatalog[previewSpec.kind];
          return <PreviewRenderer key={index} spec={previewSpec} />;
        }
        if (block.type === "heading") {
          const HeadingTag = `h${block.level}` as "h1" | "h2" | "h3";
          const headingClass =
            block.level === 1
              ? "text-base font-semibold leading-7"
              : block.level === 2
                ? "text-[15px] font-semibold leading-7"
                : "text-sm font-semibold leading-6";
          return (
            <HeadingTag key={index} className={`${headingClass} min-w-0 break-words`}>
              {renderInlineMarkdown(block.text)}
            </HeadingTag>
          );
        }
        if (block.type === "unordered-list") {
          return (
            <ul key={index} className="min-w-0 list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="break-words">
                  {renderInlineMarkdown(item)}
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "ordered-list") {
          return (
            <ol key={index} className="min-w-0 list-decimal space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="break-words">
                  {renderInlineMarkdown(item)}
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm leading-6"
            >
              <code className="break-words">{block.text}</code>
            </pre>
          );
        }
        if (block.type === "table") {
          return (
            <div key={index} className="max-w-full overflow-x-auto rounded-lg border border-[var(--line)]">
              <table className="w-full border-collapse text-left text-sm leading-6">
                <thead className="bg-[var(--surface-2)]">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex} className="min-w-[120px] border-b border-[var(--line)] px-3 py-2 font-semibold">
                        {renderInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-[var(--line)]">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="min-w-[120px] break-words px-3 py-2 align-top">
                          {renderInlineMarkdown(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "horizontal-rule") {
          return <hr key={index} className="border-[var(--line)]" />;
        }
        return (
          <p key={index} className="min-w-0 whitespace-pre-wrap break-words">
            {renderInlineMarkdown(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function HtmlPreviewCard({ spec }: { spec: PreviewSpec }) {
  const [activeView, setActiveView] = useState<"preview" | "source">("preview");
  const previewHtml = buildPreviewSrcDoc(spec.data.html, spec.kind);

  function openPreviewWindow() {
    const wrapperHtml = buildPreviewWindowHtml(previewHtml, spec.title);
    const url = URL.createObjectURL(new Blob([wrapperHtml], { type: "text/html;charset=utf-8" }));
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      URL.revokeObjectURL(url);
      return;
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <section className="max-w-full overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)]">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--line)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Code2 className="size-4 shrink-0 text-[var(--blue)]" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{spec.title}</div>
            <div className="font-mono text-[11px] uppercase text-[var(--muted)]">
              {spec.schema.type} · {spec.renderer}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden font-mono text-[11px] text-[var(--muted)] sm:block">
            {spec.data.lines} lines · {formatBytes(spec.data.bytes)}
          </div>
          <div className="flex rounded-md border border-[var(--line)] bg-[var(--surface)] p-0.5">
            {(["preview", "source"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setActiveView(view)}
                className={`px-2 py-1 text-xs font-medium ${
                  activeView === view ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {view === "preview" ? "Preview" : "Source"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={openPreviewWindow}
            className="inline-flex size-8 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            aria-label="Open HTML preview in new window"
            title="Open HTML preview in new window"
          >
            <ExternalLink className="size-4" />
          </button>
        </div>
      </div>
      <div className="p-3">
        {activeView === "preview" ? (
          <iframe
            title={spec.title}
            sandbox=""
            srcDoc={previewHtml}
            className="w-full max-w-full overflow-hidden rounded-md border border-[var(--line)] bg-white"
            style={{ height: spec.schema.maxInlineHeight }}
          />
        ) : (
          <pre
            className="w-full max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--line)] bg-[var(--surface)] p-3 text-xs leading-5"
            style={{ height: spec.schema.maxInlineHeight }}
          >
            <code>{spec.data.html}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

function previewSpecFromBlock(block: MarkdownBlock): PreviewSpec | null {
  if (block.type === "code" && isHtmlLanguage(block.language) && block.text.trim()) {
    return createHtmlPreviewSpec(block.text, "html.document");
  }
  if (block.type === "code" && looksLikeHtml(block.text)) {
    return createHtmlPreviewSpec(block.text, inferHtmlKind(block.text));
  }
  if (block.type === "paragraph" && looksLikeHtml(block.text)) {
    return createHtmlPreviewSpec(block.text, inferHtmlKind(block.text));
  }
  return null;
}

function createHtmlPreviewSpec(html: string, kind: PreviewSchemaKind): PreviewSpec {
  const normalizedHtml = html.trim();
  return {
    kind,
    title: kind === "html.document" ? "HTML Document Preview" : "HTML Fragment Preview",
    renderer: "sandboxed-iframe",
    schema: {
      type: kind,
      contentField: "html",
      maxInlineHeight: 224,
    },
    data: {
      html: normalizedHtml,
      bytes: new TextEncoder().encode(normalizedHtml).length,
      lines: normalizedHtml.split("\n").length,
    },
  };
}

function isHtmlLanguage(language?: string) {
  return language === "html" || language === "htm";
}

function inferHtmlKind(value: string): PreviewSchemaKind {
  return /<!doctype\s+html|<html[\s>]/i.test(value) ? "html.document" : "html.fragment";
}

function looksLikeHtml(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 12) {
    return false;
  }
  if (/<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<\/(?:html|body|head|style)>/i.test(trimmed)) {
    return true;
  }
  return /<([a-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>/i.test(trimmed) || /<(?:img|br|hr|input|meta|link)(?:\s[^>]*)?\/?>/i.test(trimmed);
}

function buildPreviewSrcDoc(html: string, kind: PreviewSchemaKind) {
  if (kind === "html.document") {
    return html;
  }
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><style>html,body{margin:0;max-width:100%;overflow:auto;font-family:ui-sans-serif,system-ui,sans-serif;}*{box-sizing:border-box;max-width:100%;}pre,code{white-space:pre-wrap;overflow-wrap:anywhere;}table{border-collapse:collapse;max-width:100%;}img,svg,canvas,video{max-width:100%;height:auto;}</style></head><body>${html}</body></html>`;
}

function buildPreviewWindowHtml(html: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtmlText(title)}</title><style>html,body{margin:0;height:100%;background:#f8fafc;}iframe{display:block;width:100%;height:100%;border:0;background:white;}</style></head><body><iframe title="${escapeHtmlAttribute(title)}" sandbox="" srcdoc="${escapeHtmlAttribute(html)}"></iframe></body></html>`;
}

function escapeHtmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string) {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
}

function truncateHash(value: string) {
  return value.length > 16 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function StatusPill({ status }: { status: string }) {
  const running = status === "running" || status === "submitting";
  const failed = status === "failed";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs ${
        running
          ? "bg-[var(--blue-soft)] text-[var(--blue)]"
          : failed
            ? "bg-[var(--warning-soft)] text-[var(--warning)]"
            : "bg-[var(--surface-2)] text-[var(--muted)]"
      }`}
    >
      {running ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
      {status}
    </span>
  );
}

function EmptyPanel({ title }: { title: string }) {
  return (
    <div className="mx-auto mt-20 max-w-xl rounded-lg border border-[var(--line)] bg-[var(--surface)] p-8 text-center">
      <Sparkles className="mx-auto size-8 text-[var(--accent)]" />
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
    </div>
  );
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === "html") {
    return <Code2 className="size-4 text-[var(--blue)]" />;
  }
  return <FileText className="size-4 text-[var(--accent)]" />;
}

function withFromSeq(streamUrl: string, fromSeq: number) {
  const separator = streamUrl.includes("?") ? "&" : "?";
  return `${streamUrl}${separator}from_seq=${fromSeq}`;
}

function activityItemsByRunFromEvents(events: RunEventEnvelope[]) {
  const itemsByRun = events.reduce<RuntimeActivityByRun>((itemsByRun, event) => {
    const item = activityItemFromEvent(event);
    if (!item) {
      return itemsByRun;
    }
    const runItems = itemsByRun[event.run_id] ?? [];
    const index = runItems.findIndex((candidate) => candidate.id === item.id);
    const nextRunItems = [...runItems];
    if (index === -1) {
      nextRunItems.push(item);
    } else {
      nextRunItems[index] = mergeRuntimeActivityItem(nextRunItems[index], item);
    }
    return { ...itemsByRun, [event.run_id]: nextRunItems };
  }, {});
  for (const [runId, items] of Object.entries(itemsByRun)) {
    itemsByRun[runId] = settleSwarmPlanItems(items);
  }
  return itemsByRun;
}

function mergeRuntimeActivityItem(current: RuntimeActivityItem, next: RuntimeActivityItem): RuntimeActivityItem {
  return {
    ...current,
    ...next,
    detail: next.detail ?? current.detail,
    details: mergeActivityDetails(current.details, next.details),
    preview: next.preview ?? current.preview,
  };
}

function settleSwarmPlanItems(items: RuntimeActivityItem[]) {
  const hasSwarmTerminalStep = items.some(
    (item) =>
      item.id.startsWith("swarm:swarm.reduce:") ||
      item.id.startsWith("swarm:swarm.merge:") ||
      item.id.startsWith("swarm:swarm.verify:") ||
      item.id.startsWith("swarm:swarm.review:"),
  );
  if (!hasSwarmTerminalStep) {
    return items;
  }
  return items.map((item) => (item.id.startsWith("swarm:swarm.plan:") ? { ...item, status: "completed" as const } : item));
}

function mergeActivityDetails(
  current: RuntimeActivityItem["details"] = [],
  next: RuntimeActivityItem["details"] = [],
) {
  const merged = new Map<string, { label: string; value: string }>();
  for (const detail of [...current, ...next]) {
    if (detail.value) {
      merged.set(detail.label, detail);
    }
  }
  return Array.from(merged.values());
}

function activityItemFromEvent(event: RunEventEnvelope): RuntimeActivityItem | null {
  const payload = asPayload(event.payload);
  if (event.type === "skill.selected") {
    const skillName = String(payload.skill_name ?? payload.skill_id ?? "skill");
    return {
      id: `skill:${skillName}`,
      kind: "skill",
      title: `Skill selected: ${skillName}`,
      status: "completed",
      detail: String(payload.reason ?? "Matched current request."),
      details: [
        { label: "skill", value: skillName },
        { label: "reason", value: String(payload.reason ?? "Matched current request.") },
      ],
    };
  }
  if (event.type.startsWith("tool.call.")) {
    const toolCallId = String(payload.tool_call_id ?? event.trace?.span_id ?? "tool");
    const toolName = String(payload.tool_name ?? event.producer.name ?? "tool");
    const preview = Array.isArray(payload.output_preview)
      ? (payload.output_preview as Array<{ title?: string; url?: string }>)
      : undefined;
    return {
      id: `tool:${toolCallId}`,
      kind: "tool",
      title: `Tool call: ${toolName}`,
      status: event.type === "tool.call.completed" || event.type === "tool.call.output" ? "completed" : "running",
      detail: String(payload.output_summary ?? payload.input_summary ?? "Calling external tool."),
      details: compactDetails([
        ["tool", toolName],
        ["event", event.type],
        ["input", payload.input_summary],
        ["output", payload.output_summary],
        ["mode", payload.execution_mode],
        ["payload", payload.payload_uri],
        ["risk", payload.risk_level],
        ["approval", payload.requires_approval === undefined ? undefined : String(payload.requires_approval)],
        ["status", payload.status],
        ["time", event.timestamp],
        ["trace", event.trace?.span_id],
      ]),
      preview,
    };
  }
  if (event.type.startsWith("model.call.")) {
    const modelCallId = String(payload.model_call_id ?? event.trace?.span_id ?? "model");
    const modelName = String(payload.model ?? payload.model_profile ?? event.producer.name ?? "orchestrator");
    return {
      id: `model:${modelCallId}`,
      kind: "model",
      title: `Model call: ${modelName}`,
      status: event.type === "model.call.completed" ? "completed" : "running",
      detail:
        event.type === "model.call.completed"
          ? `Completed. ${String(payload.output_summary ?? "").slice(0, 160)}`
          : `Context messages: ${String(payload.model_message_count ?? "?")}, max tokens: ${String(
              payload.max_output_tokens ?? "?",
            )}`,
      details: compactDetails([
        ["model", modelName],
        ["event", event.type],
        ["context messages", payload.model_message_count],
        ["max tokens", payload.max_output_tokens],
        ["trace", event.trace?.span_id],
      ]),
    };
  }
  if (event.type.startsWith("artifact.")) {
    const artifactSpanId = String(event.trace?.span_id ?? payload.artifact_id ?? payload.artifact_version_id ?? "artifact");
    const artifactId = typeof payload.artifact_id === "string" ? payload.artifact_id : null;
    const artifactTitle = String(payload.title ?? event.producer.name ?? payload.type ?? "created");
    return {
      id: `artifact:${artifactSpanId}`,
      kind: "artifact",
      title: `Artifact: ${artifactTitle}`,
      status: event.type === "artifact.preview.ready" || event.type === "artifact.created" ? "completed" : "running",
      detail: artifactId ? `Artifact ID: ${artifactId}` : `Creating ${String(payload.type ?? "artifact")} artifact.`,
      details: compactDetails([
        ["event", event.type],
        ["type", payload.type ?? payload.preview_type],
        ["artifact id", artifactId],
        ["version", payload.artifact_version_id],
        ["mime", payload.mime_type],
        ["storage", payload.storage_uri],
        ["preview", payload.preview_uri],
        ["trace", event.trace?.span_id],
      ]),
    };
  }
  if (
    event.type === "swarm.plan" ||
    event.type === "swarm.reduce" ||
    event.type === "swarm.merge" ||
    event.type === "swarm.verify" ||
    event.type === "swarm.review"
  ) {
    const branchCount = String(payload.branch_count ?? payload.requested_branch_count ?? "?");
    const completed = String(payload.completed_branch_count ?? "0");
    const failed = String(payload.failed_branch_count ?? "0");
    return {
      id: `swarm:${event.type}:${event.trace?.span_id ?? event.seq}`,
      kind: "system",
      title: event.type,
      status:
        event.type === "swarm.plan"
          ? "running"
          : payload.status === "failed"
            ? "failed"
            : "completed",
      detail: String(payload.summary ?? payload.reason ?? `Branches: ${branchCount}`),
      details: compactDetails([
        ["event", event.type],
        ["status", payload.status],
        ["strategy", payload.strategy],
        ["plan source", payload.plan_source],
        ["reducer", payload.reducer_mode],
        ["review mode", payload.review_mode],
        ["confidence", payload.confidence],
        ["findings", payload.finding_count],
        ["branches", branchCount],
        ["completed", completed],
        ["failed", failed],
        ["artifacts", Array.isArray(payload.artifact_ids) ? payload.artifact_ids.length : undefined],
        ["observations", Array.isArray(payload.branch_observation_ids) ? payload.branch_observation_ids.length : undefined],
        ["checks", Array.isArray(payload.checks) ? payload.checks.length : undefined],
        ["trace", event.trace?.span_id],
      ]),
    };
  }
  if (event.type === "run.cancel.requested" || event.type === "sandbox.cancel.requested" || event.type === "swarm.cancelled") {
    const subject =
      event.type === "sandbox.cancel.requested"
        ? String(payload.sandbox_session_id ?? event.producer.id ?? "sandbox")
        : event.type === "swarm.cancelled"
          ? "swarm"
          : "run";
    return {
      id: `cancel:${event.type}:${subject}`,
      kind: "system",
      title: event.type === "swarm.cancelled" ? "Swarm cancelled" : `Cancel requested: ${subject}`,
      status: "completed",
      detail: String(payload.summary ?? payload.reason ?? "Cancellation requested."),
      details: compactDetails([
        ["event", event.type],
        ["reason", payload.reason],
        ["status", payload.status],
        ["previous", payload.previous_status],
        ["sandbox count", payload.sandbox_cancel_count],
        ["trace", event.trace?.span_id],
      ]),
    };
  }
  return null;
}

function compactDetails(entries: Array<[string, unknown]>): Array<{ label: string; value: string }> {
  return entries
    .filter((entry): entry is [string, NonNullable<unknown>] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}

function buildConversationTurns(messages: UiMessage[]) {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        key: message.runId ?? message.id,
        runId: message.runId,
        user: message,
      });
      continue;
    }

    if (message.role === "assistant") {
      const matchingIndex = findOpenTurnIndex(turns, message.runId);
      if (matchingIndex >= 0) {
        const turn = turns[matchingIndex];
        turns[matchingIndex] = {
          ...turn,
          key: turn.runId ?? message.runId ?? turn.key,
          runId: turn.runId ?? message.runId,
          assistant: message,
        };
      } else {
        turns.push({
          key: message.runId ?? message.id,
          runId: message.runId,
          assistant: message,
        });
      }
    }
  }
  return turns;
}

function findOpenTurnIndex(turns: ConversationTurn[], runId: string | null) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.assistant) {
      continue;
    }
    if (runId && turn.runId && turn.runId !== runId) {
      continue;
    }
    return index;
  }
  return -1;
}

function buildSuggestedPromptsFromMessages(messages: UiMessage[]) {
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const latestUser = latestAssistant
    ? [...messages].reverse().find((message) => message.role === "user" && message.runId === latestAssistant.runId)
    : [...messages].reverse().find((message) => message.role === "user");
  if (!latestAssistant) {
    return [];
  }
  const context = buildSuggestionContext({
    user: latestUser,
    assistant: latestAssistant,
    messages,
  });
  if (!context.normalizedAssistant) {
    return [];
  }

  const previousPromptSet = collectPreviousSuggestedPrompts(messages, latestAssistant?.id);
  const candidates = buildSuggestionCandidates(context);
  const extractedPrompts = extractRecommendedPromptsFromAssistant(context.assistantText).filter(
    (prompt) =>
      shouldUseAssistantSuggestedPrompt(prompt, context) &&
      !previousPromptSet.has(normalizePromptFingerprint(prompt)),
  );
  const combined = uniquePrompts([...candidates.primary, ...extractedPrompts]).filter(
    (prompt) => !previousPromptSet.has(normalizePromptFingerprint(prompt)),
  );

  return fillSuggestedPrompts(combined, candidates.fallback, previousPromptSet);
}

function buildSuggestionContext({
  user,
  assistant,
  messages,
}: {
  user?: UiMessage;
  assistant: UiMessage;
  messages: UiMessage[];
}): SuggestionContext {
  const assistantText = messageText(assistant);
  const userText = user ? messageText(user) : "";
  const recentContext = messages.slice(-6).map(messageText).join("\n");
  return {
    userText,
    assistantText,
    normalizedUser: userText.toLowerCase(),
    normalizedAssistant: assistantText.toLowerCase(),
    recentContext,
    topic: inferPromptTopic(userText, assistantText, recentContext),
  };
}

function buildSuggestionCandidates(context: SuggestionContext): SuggestionCandidateSet {
  if (isOffTopicOrEmptyResearch(context)) {
    return {
      primary: [
        `换一组关键词重新搜索 ${context.topic} 最新信息`,
        `扩大到官方站点、GitHub、社媒和技术博客继续检索 ${context.topic}`,
        `生成 ${context.topic} 下一轮查询词组合并立即执行`,
        `排除本轮无关来源后重新检索 ${context.topic}`,
        `用英文关键词搜索 ${context.topic} release、news 和 changelog`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (/压缩|摘要|管理层|executive|brief/.test(context.normalizedUser)) {
    return {
      primary: [
        `把 ${context.topic} 摘要扩展成可执行决策清单`,
        `补充 ${context.topic} 摘要缺失的市场和竞品背景`,
        `生成 ${context.topic} 一页式 HTML Brief`,
        `继续搜索 ${context.topic} 摘要中未覆盖的新进展`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (/预览|检查|artifact|产物/.test(context.normalizedUser)) {
    return {
      primary: [
        `打开并检查 ${context.topic} artifact 的正文和版式`,
        `根据当前结果重生成 ${context.topic} HTML 报告`,
        `继续检索 ${context.topic} 的遗漏信息后更新 artifact`,
        `把 ${context.topic} artifact 转成管理层摘要`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (/html|报告|artifact|产物|可视化/.test(context.normalizedUser)) {
    return {
      primary: [
        `继续搜索 ${context.topic} 的最新信息并更新报告`,
        `扩展 ${context.topic} 报告的时间线和关键事件`,
        `为 ${context.topic} 生成更完整的 HTML 报告`,
        `把 ${context.topic} 报告压缩成管理层摘要`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (/官方|github|release|changelog|文档|docs|论文|社媒|技术博客|扩大/.test(context.normalizedUser)) {
    return {
      primary: [
        `继续扩大 ${context.topic} 到 GitHub、论文和技术博客`,
        `搜索 ${context.topic} 官方发布和 changelog 时间线`,
        `检索 ${context.topic} 社媒和社区讨论中的最新反馈`,
        `对比 ${context.topic} 官方信息与第三方报道差异`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (isExplicitSourceAuditRequest(context.normalizedUser)) {
    return {
      primary: [
        `核验 ${context.topic} 关键结论的原始出处和发布日期`,
        `搜索 ${context.topic} 官方发布、GitHub 和文档交叉验证`,
        `列出 ${context.topic} 仍缺证据的结论并继续检索`,
        `把 ${context.topic} 的可靠结论和待核验结论分开整理`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  if (isResearchLikeContext(context)) {
    return {
      primary: [
        `继续检索 ${context.topic} 最近 30 天新增信息`,
        `搜索 ${context.topic} 官方发布、GitHub 和 changelog`,
        `扩大到社媒、技术博客和社区讨论继续搜索 ${context.topic}`,
        `对比 ${context.topic} 与同类项目的最新进展`,
        `把 ${context.topic} 的关键信息整理成时间线`,
        `检索 ${context.topic} 的版本变化、路线图和争议点`,
      ],
      fallback: buildGeneralResearchPrompts(context.topic),
    };
  }

  return {
    primary: [],
    fallback: [
      `继续深入分析 ${context.topic}`,
      `把 ${context.topic} 整理成行动计划`,
      `生成 ${context.topic} 的 Markdown 摘要`,
      `检索 ${context.topic} 的最新进展`,
    ],
  };
}

function collectPreviousSuggestedPrompts(messages: UiMessage[], latestAssistantId?: string) {
  const prompts = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.id === latestAssistantId) {
      continue;
    }
    const previousMessages = messages.slice(0, index + 1);
    const pairedUser = findUserForAssistant(messages, message, index);
    const context = buildSuggestionContext({
      user: pairedUser,
      assistant: message,
      messages: previousMessages,
    });
    const candidates = buildSuggestionCandidates(context);
    for (const prompt of [...candidates.primary, ...candidates.fallback]) {
      prompts.add(normalizePromptFingerprint(prompt));
    }
    for (const prompt of extractRecommendedPromptsFromAssistant(messageText(message))) {
      prompts.add(normalizePromptFingerprint(prompt));
    }
    for (const prompt of buildLegacyTemplateHints(messageText(message))) {
      prompts.add(normalizePromptFingerprint(prompt));
    }
  }
  return prompts;
}

function findUserForAssistant(messages: UiMessage[], assistant: UiMessage, assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    if (assistant.runId && message.runId && assistant.runId !== message.runId) {
      continue;
    }
    return message;
  }
  return undefined;
}

function buildLegacyTemplateHints(text: string) {
  const topic = inferPromptTopic("", text, text);
  const lower = text.toLowerCase();
  if (/artifact|报告|html|markdown|可视化/.test(lower)) {
    return [
      `预览并检查 ${topic} 的 HTML artifact`,
      `继续搜索 ${topic} 的遗漏信息后更新报告`,
      `把 ${topic} 报告压缩成管理层摘要`,
      `打开并检查 ${topic} 的 artifact 内容`,
      `把 ${topic} 报告改成管理层摘要`,
      `为 ${topic} 生成下一轮查询清单`,
    ];
  }
  return [];
}

function fillSuggestedPrompts(base: string[], fallback: string[], previousPromptSet: Set<string>) {
  const prompts = [...base];
  for (const prompt of fallback) {
    if (prompts.length >= 3) {
      break;
    }
    if (!previousPromptSet.has(normalizePromptFingerprint(prompt))) {
      prompts.push(prompt);
    }
  }
  if (prompts.length < 3) {
    for (const prompt of fallback) {
      if (prompts.length >= 3) {
        break;
      }
      prompts.push(prompt);
    }
  }
  return uniquePrompts(prompts).slice(0, 3);
}

function buildGeneralResearchPrompts(topic: string) {
  return [
    `继续检索 ${topic} 的最新进展`,
    `搜索 ${topic} 官方发布和社区讨论`,
    `把 ${topic} 的关键信息整理成时间线`,
    `对比 ${topic} 与相关项目的最新变化`,
    `生成 ${topic} 下一轮搜索词并执行`,
  ];
}

function isResearchLikeContext(context: SuggestionContext) {
  return /搜索|联网|检索|查询|新闻|最新|调研|进展|source|news|latest|recent|research|github|论文|社媒|技术博客/.test(
    `${context.normalizedUser}\n${context.normalizedAssistant}`,
  );
}

function isOffTopicOrEmptyResearch(context: SuggestionContext) {
  return /无关|不相关|无法支撑|off-topic|not relevant|0 条命中|0 sources|没有直接相关/.test(
    context.normalizedAssistant,
  );
}

function isExplicitSourceAuditRequest(normalizedUser: string) {
  return /(?:核验|校验|验证|确认|审计|标注).{0,12}(?:来源|出处|日期|可信度)|(?:来源|出处|日期|可信度).{0,12}(?:核验|校验|验证|确认|审计|标注)|一手来源|原始出处|site:/.test(
    normalizedUser,
  );
}

function shouldUseAssistantSuggestedPrompt(prompt: string, context: SuggestionContext) {
  if (isSourceAuditPrompt(prompt) && !isExplicitSourceAuditRequest(context.normalizedUser)) {
    return false;
  }
  return isActionableSuggestedPrompt(prompt);
}

function isSourceAuditPrompt(prompt: string) {
  return /一手|二手|缺日期|可信度|来源日期|来源覆盖率|证据矩阵|待核验|v1\s*基线|v2\s*一手来源版/.test(
    prompt,
  );
}

function extractRecommendedPromptsFromAssistant(text: string) {
  const lines = text.split("\n");
  const prompts: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(#{1,4}\s*)?(推荐|建议|下一步|后续|Recommended|Next)/i.test(trimmed)) {
      collecting = true;
      continue;
    }
    if (collecting && /^#{1,4}\s+/.test(trimmed)) {
      break;
    }
    if (!collecting) {
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)、])\s*(.+)$/.exec(trimmed);
    if (bullet?.[1]) {
      const prompt = normalizeSuggestedPrompt(bullet[1]);
      if (prompt) {
        prompts.push(prompt);
      }
    } else if (trimmed && !/^[-=]{3,}$/.test(trimmed)) {
      const prompt = normalizeSuggestedPrompt(trimmed);
      if (prompt && isActionableSuggestedPrompt(prompt)) {
        prompts.push(prompt);
      }
    }
    if (prompts.length >= 3) {
      break;
    }
  }
  return uniquePrompts(prompts);
}

function normalizeSuggestedPrompt(prompt: string) {
  const normalized = prompt
    .replace(/\*\*/g, "")
    .replace(/（.*?）/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[。；;]\s*$/, "")
    .trim();
  if (normalized.length < 6 || normalized.length > 80) {
    return null;
  }
  if (/^(如果|若|请告诉我|是否需要)/.test(normalized)) {
    return null;
  }
  return normalized;
}

function isActionableSuggestedPrompt(prompt: string) {
  return /^(立即|继续|只用|用|先|把|补齐|生成|输出|检索|搜索|重跑|发布|导出|对比|扩大|换一组|排除|列出|核验)/.test(
    prompt,
  );
}

function normalizePromptFingerprint(prompt: string) {
  return prompt
    .replace(/\s+/g, "")
    .replace(/[，。！？、:：；;,.!?'"“”‘’`*]/g, "")
    .toLowerCase();
}

function messageText(message: UiMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function inferPromptTopic(userText: string, assistantText: string, recentContext: string) {
  const combined = `${userText}\n${assistantText}\n${recentContext}`;
  const known = [
    "Hermes Agent",
    "英伟达",
    "NVIDIA",
    "DataSwarm",
    "OpenClaw",
    "opencode",
    "oh-my-opencode",
    "deepseek-tui",
  ];
  const matchedFromUser = known.find((item) => userText.toLowerCase().includes(item.toLowerCase()));
  if (matchedFromUser) {
    return matchedFromUser;
  }
  const chineseTopic = inferChineseTopic(userText);
  if (chineseTopic) {
    return chineseTopic;
  }
  const userQuoted = /["“](.{2,48}?)[”"]/.exec(userText);
  if (userQuoted?.[1]) {
    return normalizePromptTopic(userQuoted[1]);
  }
  const userEnglishTopic = /([A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+){0,3})/.exec(userText);
  if (userEnglishTopic?.[1]) {
    return normalizePromptTopic(userEnglishTopic[1]);
  }
  const matched = known.find((item) => combined.toLowerCase().includes(item.toLowerCase()));
  if (matched) {
    return matched;
  }
  const contextTopic = inferContextTopic(recentContext);
  if (contextTopic) {
    return contextTopic;
  }
  const quoted = /["“](.{2,48}?)[”"]/.exec(combined);
  if (quoted?.[1]) {
    return normalizePromptTopic(quoted[1]);
  }
  const englishTopic = /([A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+){0,3})/.exec(combined);
  if (englishTopic?.[1]) {
    const topic = normalizePromptTopic(englishTopic[1]);
    if (!isNonTopicToken(topic)) {
      return topic;
    }
  }
  return "当前主题";
}

function inferChineseTopic(userText: string) {
  const patterns = [
    /检索下?\s*([\u4e00-\u9fa5A-Za-z0-9\s-]{2,32}?)(?:相关|的|最新|新闻|，|,|。|$)/,
    /(?:调研|分析|查询|介绍|围绕|关于)\s*([\u4e00-\u9fa5A-Za-z0-9\s-]{2,32}?)(?:相关|的|最新|新闻|，|,|。|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(userText);
    if (match?.[1]) {
      return normalizePromptTopic(match[1]);
    }
  }
  return null;
}

function inferContextTopic(context: string) {
  const patterns = [
    /针对本次\s*([\u4e00-\u9fa5A-Za-z0-9\s-]{2,32}?)(?:新闻|报告|调研|验证)/,
    /([\u4e00-\u9fa5A-Za-z0-9\s-]{2,32}?)(?:新闻|报告|调研)(?:的|—|-|\s)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(context);
    if (match?.[1]) {
      const topic = normalizePromptTopic(match[1]);
      if (!isNonTopicToken(topic)) {
        return topic;
      }
    }
  }
  return null;
}

function normalizePromptTopic(topic: string) {
  return topic
    .replace(/^(下|一下|一次)\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[，。！？、].*$/, "")
    .trim();
}

function isNonTopicToken(topic: string) {
  return /^(Tavily|HTML|Markdown|Artifact|DataSwarm Analysis Report|Tool Call|Trace)$/i.test(topic);
}

function uniquePrompts(prompts: string[]) {
  return Array.from(new Set(prompts));
}

function logUi(event: string, payload: Record<string, unknown> = {}) {
  console.info("[DataSwarm:UI]", event, {
    ts: new Date().toISOString(),
    ...payload,
  });
  if (event === "events.message.part.delta") {
    return;
  }
  const body = JSON.stringify({ level: "info", event, payload });
  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon("/api/logs", blob)) {
      return;
    }
  }
  void fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function parseEvent(event: Event): RunEventEnvelope {
  return JSON.parse((event as MessageEvent).data) as RunEventEnvelope;
}

function summarizeRunEvent(event: RunEventEnvelope) {
  return {
    runId: event.run_id,
    conversationId: event.conversation_id,
    eventId: event.id,
    eventType: event.type,
    seq: event.seq,
    producerKind: event.producer.kind,
    traceId: event.trace?.trace_id,
    spanId: event.trace?.span_id,
  };
}

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; text: string; language?: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "horizontal-rule" };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const language = line.trim().replace(/^```/, "").trim().toLowerCase() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", text: codeLines.join("\n"), language });
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      index += 1;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: "horizontal-rule" });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]) && !isTableSeparator(lines[index])) {
        rows.push(normalizeTableRow(splitTableRow(lines[index]), headers.length));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*[-*_]{3,}\s*$/.test(lines[index]) &&
      !isMarkdownTableStart(lines, index) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}

function isMarkdownTableStart(lines: string[], index: number) {
  return (
    index + 1 < lines.length &&
    /^\s*\|.*\|\s*$/.test(lines[index]) &&
    isTableSeparator(lines[index + 1])
  );
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeTableRow(row: string[], length: number) {
  if (row.length >= length) {
    return row.slice(0, length);
  }
  return [...row, ...Array.from({ length: length - row.length }, () => "")];
}

function renderInlineMarkdown(text: string) {
  const elements: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      elements.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      elements.push(
        <code key={key} className="break-all rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const label = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      elements.push(
        <a
          key={key}
          href={sanitizeMarkdownHref(href)}
          target="_blank"
          rel="noreferrer"
          className="break-words text-[var(--accent)] underline underline-offset-2"
        >
          {label}
        </a>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      elements.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    elements.push(text.slice(lastIndex));
  }

  return elements;
}

function sanitizeMarkdownHref(href: string) {
  if (/^(https?:|mailto:)/i.test(href)) {
    return href;
  }
  return "#";
}

function partsToUiParts(parts: unknown[], visibleArtifacts: ArtifactRecord[] = []): UiMessagePart[] {
  const visibleArtifactIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
  return parts
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        return { type: "text" as const, text: String((part as { text?: string }).text ?? "") };
      }
      if (typeof part === "object" && part !== null && "artifact_id" in part) {
        return {
          type: "artifact_preview" as const,
          artifactId: String((part as { artifact_id?: string }).artifact_id ?? ""),
        };
      }
      return null;
    })
    .filter(Boolean)
    .filter((part) => part?.type !== "artifact_preview" || (part.artifactId && visibleArtifactIds.has(part.artifactId))) as UiMessagePart[];
}

function appendTextDelta(parts: UiMessagePart[], delta: string): UiMessagePart[] {
  const next = [...parts];
  const textIndex = next.findIndex((part) => part.type === "text");
  if (textIndex === -1) {
    return [{ type: "text", text: delta }, ...next];
  }
  const textPart = next[textIndex];
  if (textPart.type === "text") {
    next[textIndex] = { ...textPart, text: `${textPart.text}${delta}` };
  }
  return next;
}

function asPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function cleanMockCopy(text: string) {
  return text
    .replace(/^DataSwarm mock Orchestrator is running on .+\n+/m, "")
    .replaceAll("M1 confirms persisted run events, SSE streaming, assistant messages, and minimal trace spans.", "")
    .replace(/^I received:/gm, "Request:")
    .replace(/\n*请告诉我[^\n]*(?:\n|$)/g, "\n\n可使用下方推荐问题继续执行下一轮任务。\n")
    .replace(/\n*如果你想[^\n]*(?:\n|$)/g, "\n\n可使用下方推荐问题继续执行下一轮任务。\n")
    .trim();
}
