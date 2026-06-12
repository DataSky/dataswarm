"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { ModelProfile } from "@/server/repositories/model-profiles";

export function NewConversationForm({
  models,
  compact = false,
}: {
  models: ModelProfile[];
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const orchestratorModels = models.filter((model) => model.role === "orchestrator");

  async function createConversation() {
    setPending(true);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "New DataSwarm Conversation",
          defaultModel: orchestratorModels[0]?.id ?? "dmx:gpt-5.5-1m",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create conversation");
      }

      const payload = (await response.json()) as {
        conversation?: { id: string };
      };

      if (payload.conversation?.id) {
        window.location.href = `/?conversationId=${payload.conversation.id}`;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={createConversation}
      disabled={pending}
      className={
        compact
          ? "inline-flex size-9 items-center justify-center border border-[var(--sidebar-line)] bg-[var(--accent)] text-white disabled:opacity-60"
          : "inline-flex items-center gap-2 border border-[var(--line)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      }
      aria-label="New conversation"
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      {compact ? null : "New Conversation"}
    </button>
  );
}
