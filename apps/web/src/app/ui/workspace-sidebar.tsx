"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Check,
  FolderKanban,
  MessageSquare,
  Pencil,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { ConversationSummary } from "@/server/repositories/conversations";
import type { ModelProfile } from "@/server/repositories/model-profiles";
import type { ProjectRecord } from "@/server/repositories/projects";
import type { SkillRecord } from "@/server/repositories/skills";
import { NewConversationForm } from "./new-conversation-form";

type SidebarView = "conversations" | "skills" | "projects";
type SkillInstallDraft = {
  name: string;
  version: string;
  purpose: string;
  requiredTools: string;
  preferredCapabilities: string;
  qualityChecks: string;
  activationGuidance: string;
  tags: string;
  skillMarkdown: string;
};

export function WorkspaceSidebar({
  conversations,
  skills,
  models,
  projects,
  selectedId,
}: {
  conversations: ConversationSummary[];
  skills: SkillRecord[];
  models: ModelProfile[];
  projects: ProjectRecord[];
  selectedId?: string;
}) {
  const [view, setView] = useState<SidebarView>("conversations");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillRegistry, setSkillRegistry] = useState(skills);
  const [conversationList, setConversationList] = useState(conversations);
  const [projectList, setProjectList] = useState(projects);
  const enabledSkills = useMemo(() => skillRegistry.filter((skill) => skill.status === "enabled"), [skillRegistry]);
  const currentProject = projectList[0];

  async function renameConversation(conversation: ConversationSummary, title: string) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { conversation?: ConversationSummary };
    if (payload.conversation) {
      setConversationList((current) =>
        current.map((item) => (item.id === payload.conversation?.id ? payload.conversation : item)),
      );
    }
  }

  async function removeConversation(conversation: ConversationSummary) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return;
    }
    setConversationList((current) => current.filter((item) => item.id !== conversation.id));
    if (conversation.id === selectedId) {
      window.location.href = "/";
    }
  }

  async function saveProject(project: ProjectRecord, input: Partial<ProjectRecord>) {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        localRoot: input.localRoot,
        defaultModel: input.defaultModel,
      }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { project?: ProjectRecord };
    if (payload.project) {
      setProjectList((current) => current.map((item) => (item.id === payload.project?.id ? payload.project : item)));
    }
  }

  async function updateSkillStatus(skill: SkillRecord, status: "enabled" | "disabled") {
    const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { skill?: SkillRecord };
    if (payload.skill) {
      setSkillRegistry((current) => current.map((item) => (item.id === payload.skill?.id ? payload.skill : item)));
    }
  }

  async function installSkill(draft: SkillInstallDraft) {
    const response = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "install",
        status: "enabled",
        manifest: {
          schemaVersion: "dataswarm.skill.v1",
          name: draft.name,
          version: draft.version || "0.1.0",
          purpose: draft.purpose,
          activationGuidance: lines(draft.activationGuidance),
          requiredTools: csv(draft.requiredTools),
          preferredCapabilities: csv(draft.preferredCapabilities),
          inputContract: {},
          outputContract: { type: "skill_guided_response" },
          qualityChecks: lines(draft.qualityChecks),
          riskLevel: "low",
          tags: csv(draft.tags),
        },
        skillMarkdown: draft.skillMarkdown,
      }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { skill?: SkillRecord };
    if (payload.skill) {
      const installedSkill = payload.skill;
      setSkillRegistry((current) => {
        const index = current.findIndex((item) => item.id === installedSkill.id || item.name === installedSkill.name);
        if (index === -1) {
          return [...current, installedSkill].sort((a, b) => a.name.localeCompare(b.name));
        }
        const next = [...current];
        next[index] = installedSkill;
        return next;
      });
      setSkillsOpen(true);
    }
  }

  return (
    <aside className="hidden h-screen min-h-0 flex-col border-r border-[var(--sidebar-line)] bg-[var(--sidebar)] text-[var(--sidebar-foreground)] shadow-sm lg:flex">
      <div className="flex h-16 items-center justify-between border-b border-[var(--sidebar-line)] px-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Boxes className="size-4 text-[var(--accent)]" />
            DataSwarm
          </div>
          <div className="mt-0.5 truncate text-xs text-[var(--sidebar-muted)]">
            {currentProject?.name ?? "Default Project"}
          </div>
        </div>
        <NewConversationForm models={models} compact />
      </div>

      <nav className="grid gap-1 border-b border-[var(--sidebar-line)] p-3 text-sm">
        <NavButton active={view === "conversations"} onClick={() => setView("conversations")}>
          <MessageSquare className="size-4" />
          Conversations
        </NavButton>
        <NavButton active={view === "skills"} onClick={() => setView("skills")}>
          <Sparkles className="size-4" />
          Skills
        </NavButton>
        <NavButton active={view === "projects"} onClick={() => setView("projects")}>
          <FolderKanban className="size-4" />
          Projects
        </NavButton>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {view === "conversations" ? (
          <ConversationList
            conversations={conversationList}
            selectedId={selectedId}
            onRename={renameConversation}
            onDelete={removeConversation}
          />
        ) : null}
        {view === "skills" ? (
          <SkillsPanel
            skills={skillRegistry}
            skillsOpen={skillsOpen}
            onToggle={() => setSkillsOpen((open) => !open)}
            onStatusChange={updateSkillStatus}
            onInstallSkill={installSkill}
          />
        ) : null}
        {view === "projects" ? (
          <ProjectsPanel
            projects={projectList}
            models={models}
            skillCount={enabledSkills.length}
            onSaveProject={saveProject}
          />
        ) : null}
      </div>

      <div className="grid gap-2 border-t border-[var(--sidebar-line)] p-3">
        <Link
          href="/settings"
          target="_blank"
          className="flex w-full items-center gap-2 rounded-lg border border-[var(--sidebar-line)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--sidebar-foreground)] hover:border-[var(--accent-muted)] hover:text-[var(--accent)]"
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-[var(--sidebar-line)] bg-[var(--sidebar-soft)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)]"
          onClick={() => setSkillsOpen((open) => !open)}
          aria-expanded={skillsOpen}
        >
          <span>Installed Skills</span>
          {skillsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        {skillsOpen ? (
          <div className="mt-2 grid gap-1">
            {enabledSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} compact onStatusChange={updateSkillStatus} />
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left transition ${
        active
          ? "bg-[var(--sidebar-active)] font-medium text-[var(--accent)]"
          : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-foreground)]"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ConversationList({
  conversations,
  selectedId,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  onRename: (conversation: ConversationSummary, title: string) => Promise<void>;
  onDelete: (conversation: ConversationSummary) => Promise<void>;
}) {
  if (conversations.length === 0) {
    return <div className="px-2 py-8 text-sm text-[var(--sidebar-muted)]">No conversations yet.</div>;
  }

  return (
    <div className="space-y-1">
      {conversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          selected={conversation.id === selectedId}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  onRename,
  onDelete,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onRename: (conversation: ConversationSummary, title: string) => Promise<void>;
  onDelete: (conversation: ConversationSummary) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim()) {
      return;
    }
    setBusy(true);
    await onRename(conversation, title);
    setBusy(false);
    setEditing(false);
  }

  async function remove() {
    setBusy(true);
    await onDelete(conversation);
    setBusy(false);
  }

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm transition ${
        selected
          ? "border-[var(--accent-muted)] bg-[var(--sidebar-active)] text-[var(--sidebar-foreground)]"
          : "border-transparent text-[var(--sidebar-muted)] hover:border-[var(--sidebar-line)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-foreground)]"
      }`}
    >
      {editing ? (
        <div className="grid gap-2">
          <input
            className="min-w-0 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1 text-sm text-[var(--foreground)]"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Escape") {
                setTitle(conversation.title);
                setEditing(false);
              }
            }}
            autoFocus
          />
          <div className="flex gap-1">
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center border border-[var(--accent-muted)] bg-[var(--accent-soft)] text-[var(--accent)]"
              onClick={() => void save()}
              disabled={busy}
              aria-label="Save conversation title"
            >
              <Check className="size-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center border border-[var(--sidebar-line)] bg-white text-[var(--sidebar-muted)]"
              onClick={() => {
                setTitle(conversation.title);
                setEditing(false);
              }}
              aria-label="Cancel rename"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <Link href={`/?conversationId=${conversation.id}`} className="min-w-0 flex-1">
              <span className="block truncate font-medium">{conversation.title}</span>
              <span className="block truncate font-mono text-[11px] opacity-70">{conversation.defaultModel}</span>
            </Link>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center border border-transparent text-[var(--sidebar-muted)] hover:border-[var(--sidebar-line)] hover:bg-white hover:text-[var(--foreground)]"
                onClick={() => setEditing(true)}
                aria-label="Rename conversation"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center border border-transparent text-[var(--sidebar-muted)] hover:border-[var(--line)] hover:bg-white hover:text-[var(--danger)]"
                onClick={() => setConfirmingDelete((value) => !value)}
                aria-label="Delete conversation"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="mt-1 flex items-center gap-2 font-mono text-[10px] opacity-70">
            <span>{conversation.messageCount} msg</span>
            <span>{conversation.artifactCount} art</span>
          </div>
          {confirmingDelete ? (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
              <span>Soft delete?</span>
              <button type="button" className="font-semibold" onClick={() => void remove()} disabled={busy}>
                Delete
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function SkillsPanel({
  skills,
  skillsOpen,
  onToggle,
  onStatusChange,
  onInstallSkill,
}: {
  skills: SkillRecord[];
  skillsOpen: boolean;
  onToggle: () => void;
  onStatusChange: (skill: SkillRecord, status: "enabled" | "disabled") => void;
  onInstallSkill: (draft: SkillInstallDraft) => Promise<void>;
}) {
  const enabledCount = skills.filter((skill) => skill.status === "enabled").length;
  const [installOpen, setInstallOpen] = useState(false);
  const [draft, setDraft] = useState<SkillInstallDraft>({
    name: "",
    version: "0.1.0",
    purpose: "",
    requiredTools: "",
    preferredCapabilities: "",
    qualityChecks: "",
    activationGuidance: "",
    tags: "",
    skillMarkdown: "",
  });
  const canInstall = draft.name.trim().length > 0 && draft.purpose.trim().length > 0;
  async function submitInstall() {
    if (!canInstall) {
      return;
    }
    await onInstallSkill(draft);
    setDraft({
      name: "",
      version: "0.1.0",
      purpose: "",
      requiredTools: "",
      preferredCapabilities: "",
      qualityChecks: "",
      activationGuidance: "",
      tags: "",
      skillMarkdown: "",
    });
    setInstallOpen(false);
  }
  return (
    <section className="grid gap-3">
      <div className="rounded-lg border border-[var(--sidebar-line)] bg-[var(--surface)] p-3">
        <div className="text-sm font-semibold">Skills Registry</div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <Metric label="Enabled" value={enabledCount} />
          <Metric label="Total" value={skills.length} />
        </div>
      </div>
      <button
        type="button"
        className="flex items-center justify-between rounded-lg border border-[var(--sidebar-line)] bg-[var(--sidebar-soft)] px-3 py-2 text-sm"
        onClick={onToggle}
        aria-expanded={skillsOpen}
      >
        <span>{enabledCount} enabled skills</span>
        {skillsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>
      <button
        type="button"
        className="rounded-lg border border-[var(--accent-muted)] bg-[var(--accent-soft)] px-3 py-2 text-left text-sm font-medium text-[var(--accent)]"
        onClick={() => setInstallOpen((open) => !open)}
        aria-expanded={installOpen}
      >
        Install / Update Skill
      </button>
      {installOpen ? (
        <div className="grid gap-2 rounded-lg border border-[var(--sidebar-line)] bg-[var(--surface)] p-3 text-xs">
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="skill-name"
          />
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.version}
            onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))}
            placeholder="0.1.0"
          />
          <textarea
            className="min-h-16 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.purpose}
            onChange={(event) => setDraft((current) => ({ ...current, purpose: event.target.value }))}
            placeholder="Purpose"
          />
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.requiredTools}
            onChange={(event) => setDraft((current) => ({ ...current, requiredTools: event.target.value }))}
            placeholder="required tools, comma separated"
          />
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.preferredCapabilities}
            onChange={(event) => setDraft((current) => ({ ...current, preferredCapabilities: event.target.value }))}
            placeholder="capabilities, comma separated"
          />
          <textarea
            className="min-h-16 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.activationGuidance}
            onChange={(event) => setDraft((current) => ({ ...current, activationGuidance: event.target.value }))}
            placeholder="Activation guidance, one per line"
          />
          <textarea
            className="min-h-16 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.qualityChecks}
            onChange={(event) => setDraft((current) => ({ ...current, qualityChecks: event.target.value }))}
            placeholder="Quality checks, one per line"
          />
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.tags}
            onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
            placeholder="tags, comma separated"
          />
          <textarea
            className="min-h-24 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5 font-mono"
            value={draft.skillMarkdown}
            onChange={(event) => setDraft((current) => ({ ...current, skillMarkdown: event.target.value }))}
            placeholder="Optional SKILL.md content"
          />
          <button
            type="button"
            disabled={!canInstall}
            className="rounded-md border border-[var(--accent-muted)] bg-[var(--accent)] px-2 py-1.5 text-left font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              void submitInstall();
            }}
          >
            Save Skill
          </button>
        </div>
      ) : null}
      {skillsOpen ? (
        <div className="grid gap-2">
          {skills.map((skill) => (
            <SkillCard key={skill.id} skill={skill} onStatusChange={onStatusChange} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--sidebar-line)] bg-[var(--sidebar-soft)] px-3 py-6 text-center text-xs text-[var(--sidebar-muted)]">
          Installed skills are collapsed by default.
        </div>
      )}
    </section>
  );
}

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function SkillCard({
  skill,
  compact = false,
  onStatusChange,
}: {
  skill: SkillRecord;
  compact?: boolean;
  onStatusChange: (skill: SkillRecord, status: "enabled" | "disabled") => void;
}) {
  const [open, setOpen] = useState(false);
  const enabled = skill.status === "enabled";
  const manifest = skill.manifest;
  return (
    <div className="rounded-lg border border-[var(--sidebar-line)] bg-[var(--surface)] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs font-semibold"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {skill.name}
        </button>
        {enabled ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" />
        ) : (
          <CircleOff className="mt-0.5 size-3.5 shrink-0 text-[var(--sidebar-muted)]" />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-[var(--sidebar-muted)]">
        <span>{skill.version}</span>
        {!compact ? <span>{skill.status}</span> : null}
      </div>
      {!compact ? (
        <>
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--sidebar-muted)]">{skill.path}</div>
          {open ? (
            <div className="mt-3 grid gap-2 border-t border-[var(--sidebar-line)] pt-2 text-[11px] leading-5 text-[var(--sidebar-muted)]">
              {manifest?.purpose ? <div>{manifest.purpose}</div> : null}
              <SkillMeta icon={<Wrench className="size-3" />} label="Tools" values={manifest?.requiredTools ?? []} />
              <SkillMeta label="Capabilities" values={manifest?.preferredCapabilities ?? []} />
              <SkillMeta label="Checks" values={(manifest?.qualityChecks ?? []).slice(0, 3)} />
              <button
                type="button"
                className="mt-1 rounded-md border border-[var(--sidebar-line)] bg-[var(--sidebar-soft)] px-2 py-1 text-left text-[11px] font-medium text-[var(--sidebar-foreground)] hover:border-[var(--accent-muted)] hover:text-[var(--accent)]"
                onClick={() => onStatusChange(skill, enabled ? "disabled" : "enabled")}
              >
                {enabled ? "Disable skill" : "Enable skill"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SkillMeta({ icon, label, values }: { icon?: ReactNode; label: string; values: string[] }) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 font-semibold text-[var(--sidebar-foreground)]">
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <span key={value} className="rounded border border-[var(--sidebar-line)] bg-[var(--sidebar-soft)] px-1.5 py-0.5">
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function ProjectsPanel({
  projects,
  models,
  skillCount,
  onSaveProject,
}: {
  projects: ProjectRecord[];
  models: ModelProfile[];
  skillCount: number;
  onSaveProject: (project: ProjectRecord, input: Partial<ProjectRecord>) => Promise<void>;
}) {
  return (
    <section className="grid gap-3">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          models={models}
          skillCount={skillCount}
          onSaveProject={onSaveProject}
        />
      ))}
      <div className="rounded-lg border border-[var(--sidebar-line)] bg-[var(--surface)] p-3">
        <div className="text-sm font-semibold">Project Scope</div>
        <p className="mt-2 text-xs leading-5 text-[var(--sidebar-muted)]">
          Project metadata now drives the sidebar and default model policy. Tool policy, storage backend, and tenant fields are still planned.
        </p>
      </div>
    </section>
  );
}

function ProjectCard({
  project,
  models,
  skillCount,
  onSaveProject,
}: {
  project: ProjectRecord;
  models: ModelProfile[];
  skillCount: number;
  onSaveProject: (project: ProjectRecord, input: Partial<ProjectRecord>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    name: project.name,
    description: project.description ?? "",
    localRoot: project.localRoot ?? "",
    defaultModel: project.defaultModel ?? models[0]?.id ?? "",
  });

  async function save() {
    setBusy(true);
    await onSaveProject(project, draft);
    setBusy(false);
    setEditing(false);
  }

  return (
    <div className="rounded-lg border border-[var(--accent-muted)] bg-[var(--accent-soft)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--accent)]">{project.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--sidebar-muted)]">{project.id}</div>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center border border-[var(--accent-muted)] bg-white/70 text-[var(--accent)]"
          onClick={() => setEditing((value) => !value)}
          aria-label="Edit project"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Metric label="Conversations" value={project.conversationCount} />
        <Metric label="Artifacts" value={project.artifactCount} />
        <Metric label="Skills" value={skillCount} />
      </div>
      {editing ? (
        <div className="mt-3 grid gap-2 border-t border-[var(--accent-muted)] pt-3 text-xs">
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
          <textarea
            className="min-h-16 rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.description}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            placeholder="Project description"
          />
          <input
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5 font-mono"
            value={draft.localRoot}
            onChange={(event) => setDraft((current) => ({ ...current, localRoot: event.target.value }))}
            placeholder="Local root"
          />
          <select
            className="rounded-md border border-[var(--sidebar-line)] bg-white px-2 py-1.5"
            value={draft.defaultModel}
            onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-[var(--accent-muted)] bg-[var(--accent)] px-2 py-1.5 font-medium text-white disabled:opacity-50"
            onClick={() => void save()}
            disabled={busy || !draft.name.trim()}
          >
            <Save className="size-3.5" />
            Save Project
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-1 border-t border-[var(--accent-muted)] pt-2 text-xs leading-5 text-[var(--sidebar-muted)]">
          <div className="line-clamp-2">{project.description ?? "No description"}</div>
          <div className="truncate font-mono">{project.defaultModel ?? "No default model"}</div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-white/70 px-2 py-2">
      <div className="font-mono text-base font-semibold">{value}</div>
      <div className="text-[10px] uppercase text-[var(--sidebar-muted)]">{label}</div>
    </div>
  );
}
