import Link from "next/link";
import { listAllModelProfiles } from "@/server/repositories/model-profiles";
import { getSystemSnapshot } from "@/server/repositories/system";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const [models, snapshot] = await Promise.all([listAllModelProfiles(), getSystemSnapshot()]);

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-5 text-[var(--foreground)] sm:px-6">
      <div className="mx-auto grid max-w-7xl gap-4">
        <header className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">DataSwarm Control Plane</p>
            <h1 className="mt-1 text-xl font-semibold">Settings</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              Manage model access, sandbox readiness, local data retention, and operational state outside the active chat flow.
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Back to workspace
          </Link>
        </header>
        <SettingsClient initialModels={models} initialSnapshot={snapshot} />
      </div>
    </main>
  );
}
