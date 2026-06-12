import { getDb } from "../storage/db";
import { dataDir } from "../storage/paths";
import { getE2bSandboxReadiness } from "../runtime/sandbox-provider";

type CountRow = { count: number };

export async function getSystemSnapshot() {
  const db = await getDb();
  const tableNames = [
    "conversations",
    "messages",
    "tasks",
    "runs",
    "run_events",
    "trace_spans",
    "artifacts",
    "skills",
    "tools",
    "model_profiles",
  ];

  const counts = Object.fromEntries(
    tableNames.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as CountRow;
      return [table, row.count];
    }),
  );

  return {
    dataDir,
    counts,
    sandbox: {
      e2b: getE2bSandboxReadiness(),
    },
  };
}
