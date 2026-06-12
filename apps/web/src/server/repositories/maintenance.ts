import { rm } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../storage/db";
import { dataDir } from "../storage/paths";

export type ClearConversationDataResult = {
  deletedRows: Record<string, number>;
  deletedPaths: string[];
};

const conversationScopedTables = [
  "self_improvement_candidates",
  "eval_results",
  "observations",
  "agent_actions",
  "tool_calls",
  "approvals",
  "trace_spans",
  "run_events",
  "run_steps",
  "context_bundles",
  "sandbox_sessions",
  "agent_sessions",
  "artifact_versions",
  "artifacts",
  "messages",
  "tasks",
  "runs",
  "uploads",
  "conversations",
];

export async function clearConversationData(input: { deleteLocalFiles?: boolean }): Promise<ClearConversationDataResult> {
  const db = await getDb();
  const deletedRows: Record<string, number> = {};

  db.exec("BEGIN;");
  try {
    const logResult = db
      .prepare("DELETE FROM app_logs WHERE conversation_id IS NOT NULL OR run_id IS NOT NULL")
      .run();
    deletedRows.app_logs = logResult.changes;

    for (const table of conversationScopedTables) {
      const result = db.prepare(`DELETE FROM ${table}`).run();
      deletedRows[table] = result.changes;
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  const deletedPaths: string[] = [];
  if (input.deleteLocalFiles) {
    for (const dirname of ["artifacts", "uploads"]) {
      const target = path.join(/* turbopackIgnore: true */ dataDir, dirname);
      await rm(target, { recursive: true, force: true });
      deletedPaths.push(target);
    }
  }

  return { deletedRows, deletedPaths };
}
