"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleOff, Database, Server, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ModelProfile } from "@/server/repositories/model-profiles";

type SystemSnapshot = {
  dataDir: string;
  counts: Record<string, number>;
  sandbox: {
    e2b: {
      status: string;
      providerSelected: boolean;
      apiKeyConfigured: boolean;
      template: string;
      templateVerified: boolean;
      liveSmokeVerified: boolean;
      readyForLiveSmoke: boolean;
      readyForOrchestrator: boolean;
      missingEnv: string[];
      readinessReasons: string[];
      nextSteps: string[];
    };
  };
};

export function SettingsClient({
  initialModels,
  initialSnapshot,
}: {
  initialModels: ModelProfile[];
  initialSnapshot: SystemSnapshot;
}) {
  const [models, setModels] = useState(initialModels);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [confirmation, setConfirmation] = useState("");
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<string | null>(null);

  async function refreshSnapshot() {
    const response = await fetch("/api/system/snapshot", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    setSnapshot((await response.json()) as SystemSnapshot);
  }

  async function updateModel(model: ModelProfile, input: Partial<ModelProfile>) {
    const response = await fetch(`/api/model-profiles/${encodeURIComponent(model.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: input.displayName,
        role: input.role,
        enabled: input.enabled,
      }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { model?: ModelProfile };
    if (payload.model) {
      setModels((current) => current.map((item) => (item.id === payload.model?.id ? payload.model : item)));
    }
  }

  async function clearData() {
    const response = await fetch("/api/system/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "clear_conversation_data",
        confirmation,
        deleteLocalFiles,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      result?: { deletedRows?: Record<string, number>; deletedPaths?: string[] };
    };
    if (!response.ok || !payload.ok) {
      setMaintenanceResult(payload.error ?? "Maintenance action failed");
      return;
    }
    const deletedTotal = Object.values(payload.result?.deletedRows ?? {}).reduce((sum, value) => sum + value, 0);
    setMaintenanceResult(`Cleared ${deletedTotal} rows. ${payload.result?.deletedPaths?.length ?? 0} local paths removed.`);
    setConfirmation("");
    await refreshSnapshot();
  }

  const e2b = snapshot.sandbox.e2b;
  const enabledModelCount = models.filter((model) => model.enabled).length;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start">
      <aside className="grid gap-3 lg:sticky lg:top-5">
        <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
          <div className="text-sm font-semibold">Control Summary</div>
          <div className="mt-3 grid gap-2">
            <CompactMetric label="Enabled models" value={`${enabledModelCount}/${models.length}`} tone="neutral" />
            <CompactMetric label="E2B status" value={e2b.status} tone={e2b.readyForOrchestrator ? "success" : "warning"} />
            <CompactMetric label="Conversations" value={String(snapshot.counts.conversations ?? 0)} tone="neutral" />
            <CompactMetric label="Artifacts" value={String(snapshot.counts.artifacts ?? 0)} tone="neutral" />
          </div>
        </div>
        <nav className="grid gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 text-sm">
          <a className="rounded-md px-2 py-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]" href="#models">
            Models
          </a>
          <a className="rounded-md px-2 py-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]" href="#e2b">
            E2B
          </a>
          <a className="rounded-md px-2 py-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]" href="#data">
            Local data
          </a>
          <a className="rounded-md px-2 py-1.5 text-red-700 hover:bg-red-50" href="#danger">
            Danger zone
          </a>
        </nav>
      </aside>

      <div className="grid min-w-0 gap-4">
        <section id="models" className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <SectionHeader
            icon={<SlidersHorizontal className="size-4" />}
            title="Model Access"
            detail={`${enabledModelCount} enabled · ${models.length} configured`}
          />
          <div className="overflow-hidden rounded-lg border border-[var(--line)]">
            <div className="hidden grid-cols-[minmax(220px,1fr)_130px_110px] gap-3 border-b border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold uppercase text-[var(--muted)] md:grid">
              <div>Model</div>
              <div>Role</div>
              <div>Status</div>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {models.map((model) => (
                <ModelProfileRow key={model.id} model={model} onUpdate={updateModel} />
              ))}
            </div>
          </div>
        </section>

        <section id="e2b" className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <SectionHeader
            icon={<Server className="size-4" />}
            title="E2B Sandbox Readiness"
            detail={e2b.readyForOrchestrator ? "ready for orchestrator" : "not ready for orchestrator"}
          />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <StatusMetric label="Status" value={e2b.status} ok={e2b.readyForOrchestrator} />
            <StatusMetric label="Provider" value={e2b.providerSelected ? "e2b" : "mock/local"} ok={e2b.providerSelected} />
            <StatusMetric label="API Key" value={e2b.apiKeyConfigured ? "configured" : "missing"} ok={e2b.apiKeyConfigured} />
            <StatusMetric label="Template" value={e2b.templateVerified ? "verified" : "unverified"} ok={e2b.templateVerified} />
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <InfoList title="Readiness reasons" items={e2b.readinessReasons} />
            <InfoList title="Next steps" items={e2b.nextSteps.slice(0, 5)} />
          </div>
          <button
            type="button"
            className="w-fit rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
            onClick={() => void refreshSnapshot()}
          >
            Refresh sandbox status
          </button>
        </section>

        <section id="data" className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <SectionHeader icon={<Database className="size-4" />} title="Local Data Snapshot" detail={snapshot.dataDir} />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {Object.entries(snapshot.counts).map(([table, count]) => (
              <div key={table} className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
                <div className="font-mono text-base font-semibold">{count}</div>
                <div className="truncate text-[11px] uppercase text-[var(--muted)]">{table}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="danger" className="grid gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
          <SectionHeader icon={<AlertTriangle className="size-4" />} title="Danger Zone" detail="destructive local maintenance" />
          <p className="max-w-3xl text-sm leading-6">
            Clear conversation-scoped data from SQLite. This removes conversations, messages, runs, events, traces, artifacts, uploads,
            and related logs while keeping projects, skills, tools, and model profiles.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteLocalFiles}
              onChange={(event) => setDeleteLocalFiles(event.target.checked)}
            />
            Also remove local artifact/upload files
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="min-w-0 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-[var(--foreground)] sm:w-72"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder='Type "CLEAR DATA" to enable'
            />
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={confirmation !== "CLEAR DATA"}
              onClick={() => void clearData()}
            >
              <Trash2 className="size-4" />
              Clear conversation data
            </button>
          </div>
          {maintenanceResult ? <div className="rounded-lg bg-white/70 px-3 py-2 text-sm">{maintenanceResult}</div> : null}
        </section>
      </div>
    </div>
  );
}

function ModelProfileRow({
  model,
  onUpdate,
}: {
  model: ModelProfile;
  onUpdate: (model: ModelProfile, input: Partial<ModelProfile>) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(model.displayName);
  return (
    <div className="grid gap-2 bg-white px-3 py-2.5 md:grid-cols-[minmax(220px,1fr)_130px_110px] md:items-center">
      <div className="min-w-0">
        <input
          className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-medium hover:border-[var(--line)] hover:bg-[var(--surface-2)] focus:border-[var(--accent-muted)] focus:bg-white"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          onBlur={() => void onUpdate(model, { displayName })}
        />
        <div className="truncate font-mono text-[11px] text-[var(--muted)]">
          {model.id} · {model.provider}:{model.model}
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--muted)]">
          {model.apiKeyEnv ?? "no api env"} · {model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : "ctx n/a"}
        </div>
      </div>
      <select
        className="h-9 rounded-md border border-[var(--line)] bg-white px-2 text-sm"
        value={model.role}
        onChange={(event) => void onUpdate(model, { role: event.target.value })}
      >
        <option value="orchestrator">orchestrator</option>
        <option value="sandbox">sandbox</option>
        <option value="utility">utility</option>
      </select>
      <button
        type="button"
        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium ${
          model.enabled
            ? "border-[var(--accent-muted)] bg-[var(--accent-soft)] text-[var(--accent)]"
            : "border-[var(--line)] bg-white text-[var(--muted)]"
        }`}
        onClick={() => void onUpdate(model, { enabled: !model.enabled })}
      >
        {model.enabled ? <CheckCircle2 className="size-4" /> : <CircleOff className="size-4" />}
        {model.enabled ? "Enabled" : "Disabled"}
      </button>
    </div>
  );
}

function CompactMetric({ label, value, tone }: { label: string; value: string; tone: "neutral" | "success" | "warning" }) {
  const color =
    tone === "success" ? "text-[var(--success)]" : tone === "warning" ? "text-[var(--warning)]" : "text-[var(--foreground)]";
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
      <div className={`truncate font-mono text-sm font-semibold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase text-[var(--muted)]">{label}</div>
    </div>
  );
}

function SectionHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-[var(--accent)]">{icon}</span>
        {title}
      </div>
      {detail ? <div className="truncate font-mono text-xs text-[var(--muted)]">{detail}</div> : null}
    </div>
  );
}

function StatusMetric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
      <div className={`text-sm font-semibold ${ok ? "text-[var(--success)]" : "text-[var(--warning)]"}`}>{value}</div>
      <div className="mt-1 text-xs uppercase text-[var(--muted)]">{label}</div>
    </div>
  );
}

function InfoList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
      <div className="text-sm font-semibold">{title}</div>
      <ul className="mt-2 list-disc space-y-1 overflow-hidden pl-4 text-xs leading-5 text-[var(--muted)]">
        {items.length === 0 ? <li>None</li> : items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
