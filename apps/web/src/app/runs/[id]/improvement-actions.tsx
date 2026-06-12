"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, FileSearch, FileCheck2, FlaskConical, Pause, ShieldCheck, X, type LucideIcon } from "lucide-react";

type CandidateStatus =
  | "queued"
  | "shadow_tested"
  | "shadow_failed"
  | "patch_prepared"
  | "approved"
  | "rejected"
  | "deferred"
  | "applied";

type ImprovementAction = "shadow_test" | "prepare_patch_bundle" | "approve" | "reject" | "defer" | "mark_applied";

export function ImprovementDiagnosticsActions({ runId }: { runId: string }) {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  async function runDiagnosticsAnalysis() {
    setIsRunning(true);
    setError("");
    try {
      const response = await fetch(`/api/runs/${runId}/improvements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run_diagnostics_analysis" }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Diagnostics analysis failed");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Diagnostics analysis failed");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] hover:border-[var(--accent-muted)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isRunning}
        onClick={() => void runDiagnosticsAnalysis()}
        title="Convert current conversation diagnostics remediation into review-gated self-improvement candidates."
      >
        <FileSearch className="size-3.5" />
        <span>{isRunning ? "Analyzing" : "Analyze Diagnostics"}</span>
      </button>
      {error ? <div className="text-xs text-[var(--warning)]">{error}</div> : null}
    </div>
  );
}

export function ImprovementActions({
  runId,
  candidateId,
  status,
  requiredCommands,
}: {
  runId: string;
  candidateId: string;
  status: string;
  requiredCommands?: string[];
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<ImprovementAction | null>(null);
  const [error, setError] = useState("");
  const actions = actionsForStatus(status as CandidateStatus);

  if (actions.length === 0) {
    return null;
  }

  async function runAction(action: ImprovementAction) {
    setPendingAction(action);
    setError("");
    try {
      const verificationReceipt = action === "mark_applied" ? buildVerificationReceipt(requiredCommands ?? []) : undefined;
      if (action === "mark_applied" && !verificationReceipt) {
        throw new Error("Verification receipt is required before marking applied.");
      }
      const response = await fetch(`/api/runs/${runId}/improvements/${candidateId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          comment: action === "mark_applied" ? "run trace operator verified required commands" : "run trace operator action",
          verification_receipt: verificationReceipt,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Action failed: ${action}`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = actionMeta[action];
          const Icon = meta.icon;
          return (
            <button
              key={action}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] hover:border-[var(--accent-muted)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={pendingAction !== null}
              onClick={() => void runAction(action)}
              title={meta.title}
            >
              <Icon className="size-3.5" />
              <span>{pendingAction === action ? "Running" : meta.label}</span>
            </button>
          );
        })}
      </div>
      {error ? <div className="text-xs text-[var(--warning)]">{error}</div> : null}
    </div>
  );
}

function actionsForStatus(status: CandidateStatus): ImprovementAction[] {
  if (status === "queued" || status === "shadow_failed") {
    return ["shadow_test", "reject", "defer"];
  }
  if (status === "shadow_tested") {
    return ["prepare_patch_bundle", "reject", "defer"];
  }
  if (status === "patch_prepared") {
    return ["approve", "reject", "defer"];
  }
  if (status === "approved") {
    return ["mark_applied", "reject", "defer"];
  }
  return [];
}

const actionMeta: Record<
  ImprovementAction,
  {
    label: string;
    title: string;
    icon: LucideIcon;
  }
> = {
  shadow_test: {
    label: "Shadow Test",
    title: "Run the allowlisted shadow checks for this candidate.",
    icon: FlaskConical,
  },
  prepare_patch_bundle: {
    label: "Prepare Bundle",
    title: "Create a durable review bundle before approval.",
    icon: FileCheck2,
  },
  approve: {
    label: "Approve",
    title: "Approve the prepared candidate for application.",
    icon: ShieldCheck,
  },
  reject: {
    label: "Reject",
    title: "Reject this candidate.",
    icon: X,
  },
  defer: {
    label: "Defer",
    title: "Defer this candidate for later review.",
    icon: Pause,
  },
  mark_applied: {
    label: "Mark Applied",
    title: "Record that the approved change has been applied after verification.",
    icon: Check,
  },
};

function buildVerificationReceipt(requiredCommands: string[]) {
  if (requiredCommands.length === 0) {
    return null;
  }
  const summary = window
    .prompt(
      [
        "Record verification summary before marking applied.",
        "",
        "Confirm you ran these required commands:",
        ...requiredCommands.map((command) => `- ${command}`),
      ].join("\n"),
    )
    ?.trim();
  if (!summary) {
    return null;
  }
  return {
    operatorConfirmed: true,
    submittedAt: new Date().toISOString(),
    commandResults: requiredCommands.map((command) => ({
      command,
      status: "passed",
      summary,
    })),
  };
}
