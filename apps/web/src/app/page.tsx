import { listArtifacts } from "@/server/repositories/artifacts";
import { getConversation, listConversations } from "@/server/repositories/conversations";
import { listRunEventsForConversation } from "@/server/repositories/events";
import { listModelProfiles } from "@/server/repositories/model-profiles";
import { listProjects } from "@/server/repositories/projects";
import { getLatestRunForConversation } from "@/server/repositories/runs";
import { listAllSkills } from "@/server/repositories/skills";
import { ConversationWorkspace } from "./ui/conversation-workspace";
import { WorkspaceSidebar } from "./ui/workspace-sidebar";

type HomeProps = {
  searchParams: Promise<{
    conversationId?: string;
  }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const [conversations, models, skills, projects] = await Promise.all([
    listConversations(),
    listModelProfiles(),
    listAllSkills(),
    listProjects(),
  ]);
  const selectedId = params.conversationId ?? conversations[0]?.id;
  const [selected, artifacts, latestRun] = selectedId
    ? await Promise.all([
        getConversation(selectedId),
        listArtifacts(selectedId),
        getLatestRunForConversation(selectedId),
      ])
    : [null, [], null];
  const runEvents = selectedId ? await listRunEventsForConversation(selectedId) : [];

  return (
    <main className="grid h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)] lg:grid-cols-[272px_minmax(0,1fr)]">
      <WorkspaceSidebar
        conversations={conversations}
        skills={skills}
        models={models}
        projects={projects}
        selectedId={selectedId}
      />

      <ConversationWorkspace
        key={selected?.id ?? "empty"}
        selected={selected}
        models={models}
        initialRunId={latestRun?.id ?? null}
        initialArtifacts={artifacts}
        initialRunEvents={runEvents}
      />
    </main>
  );
}
