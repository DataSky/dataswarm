import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_EVENT_PROTOCOL_E2E_PORT ?? 3237);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke event protocol e2e";
const secretProbe = {
  e2b: "FAKE_SECRET_DO_NOT_USE_E2B_EVENT_PROTOCOL",
  tavily: "FAKE_SECRET_DO_NOT_USE_TAVILY_EVENT_PROTOCOL",
  openai: "FAKE_SECRET_DO_NOT_USE_OPENAI_EVENT_PROTOCOL",
};
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_EVENT_PROTOCOL_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_AGENT_MAX_STEPS: "3",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForHealth(output);

  const conversation = await postJson("/api/conversations", {
    title: smokeTitle,
    defaultModel: "dmx:claude-opus-4-8",
  });
  const conversationId = conversation?.conversation?.id;
  expect("conversation created", typeof conversationId === "string", JSON.stringify(conversation));

  const accepted = await postJson(`/api/conversations/${conversationId}/messages`, {
    text: `搜索互联网，查询 DataSwarm event protocol replay redaction ${secretProbe.e2b} ${secretProbe.tavily} ${secretProbe.openai}`,
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("event protocol smoke message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let eventRows;
  try {
    eventRows = db
      .prepare(
        `SELECT id, seq, event_type, payload_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY seq ASC`,
      )
      .all(runId);
    const events = eventRows.map((row) => unwrapEventPayload(row.payload_json));
    expect("run events persisted", events.length > 8, `${events.length} event(s)`);
    expect(
      "event ids are unique in persisted run stream",
      new Set(eventRows.map((row) => row.id)).size === eventRows.length,
      JSON.stringify(eventRows.map((row) => row.id)),
    );
    expect(
      "event rows match envelope identity and type",
      eventRows.every((row, index) => {
        const event = events[index];
        return row.id === event.id && row.seq === event.seq && row.event_type === event.type && event.run_id === runId;
      }),
      JSON.stringify(eventRows.slice(0, 4)),
    );
    expect(
      "seq is monotonic and gapless per run",
      events.every((event, index) => event.seq === index + 1),
      JSON.stringify(events.map((event) => event.seq)),
    );

    const terminalIndex = events.findIndex((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type));
    expect("terminal run event exists", terminalIndex >= 0, JSON.stringify(events.map((event) => event.type)));
    const activeAfterTerminal = events.slice(terminalIndex + 1).filter((event) => isActiveRuntimeEvent(event.type));
    expect(
      "terminal run event is not followed by active runtime events",
      terminalIndex >= 0 && activeAfterTerminal.length === 0,
      JSON.stringify(activeAfterTerminal),
    );

    const payloadText = eventRows.map((row) => row.payload_json).join("\n");
    expect(
      "event payloads redact secret-like strings",
      !payloadText.includes(secretProbe.e2b) &&
        !payloadText.includes(secretProbe.tavily) &&
        !payloadText.includes(secretProbe.openai) &&
        payloadText.includes("[REDACTED_SECRET]"),
      payloadText.slice(0, 2000),
    );

    const replaySeq = Math.max(1, Math.floor(events.length / 2));
    const fromSeqEvents = await readSseEvents(`${baseUrl}/api/runs/${runId}/events?from_seq=${replaySeq}`, {
      stopType: "run.completed",
    });
    expect(
      "SSE from_seq replays only later events",
      fromSeqEvents.length > 0 &&
        fromSeqEvents[0].seq === replaySeq + 1 &&
        fromSeqEvents.every((event) => event.seq > replaySeq),
      JSON.stringify(fromSeqEvents.map((event) => event.seq)),
    );

    const lastEventId = events[replaySeq - 1]?.id;
    const lastEventReplay = await readSseEvents(`${baseUrl}/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": lastEventId },
      stopType: "run.completed",
    });
    expect(
      "SSE Last-Event-ID replays from the matching sequence",
      lastEventReplay.length === fromSeqEvents.length &&
        lastEventReplay.map((event) => event.id).join(",") === fromSeqEvents.map((event) => event.id).join(","),
      JSON.stringify({
        lastEventId,
        lastEventReplay: lastEventReplay.map((event) => event.seq),
        fromSeqReplay: fromSeqEvents.map((event) => event.seq),
      }),
    );

    const fullReplay = await readSseEvents(`${baseUrl}/api/runs/${runId}/events?from_seq=0`, {
      stopType: "run.completed",
    });
    expect(
      "SSE stream does not duplicate event ids during replay",
      fullReplay.length === new Set(fullReplay.map((event) => event.id)).size,
      JSON.stringify(fullReplay.map((event) => event.id)),
    );
  } finally {
    db.close();
  }

  const eventsRepository = read("apps/web/src/server/repositories/events.ts");
  const eventBus = read("apps/web/src/server/runtime/event-bus.ts");
  const eventsRoute = read("apps/web/src/app/api/runs/[id]/events/route.ts");
  const conversationUi = read("apps/web/src/app/ui/conversation-workspace.tsx");
  const runTracePage = read("apps/web/src/app/runs/[id]/page.tsx");
  const approvalStatus = read("IMPLEMENTATION_STATUS.md");

  expect(
    "events are persisted before SSE subscriber flush",
    /const event = await appendRunEvent/.test(eventBus) && /subscriber\(event\)/.test(eventBus),
    "publishRunEvent should append before notifying subscribers.",
  );
  expect(
    "events route supports from_seq and Last-Event-ID replay",
    /from_seq/.test(eventsRoute) && /last-event-id/i.test(eventsRoute) && /getEventSeqById/.test(eventsRoute),
    "SSE route should support both replay forms.",
  );
  expect(
    "event repository redacts secret-like values",
    /replace\(\s*\/sk-/.test(eventsRepository) &&
      /replace\(\s*\/e2b_/.test(eventsRepository) &&
      /replace\(\s*\/tvly-/.test(eventsRepository),
    "Repository should redact known secret token shapes before persistence.",
  );
  expect(
    "client detects missing seq and reconnects from latest applied seq",
    /events\.seq_gap/.test(conversationUi) &&
      /connectRunStream\(streamUrl, runId, latestSeq\)/.test(conversationUi) &&
      /latestSeqByRunRef/.test(conversationUi),
    "Frontend should recover from stream gaps through from_seq replay.",
  );
  expect(
    "client tracks non-rendered lifecycle events before applying seq gap recovery",
    /const STREAM_EVENT_TYPES/.test(conversationUi) &&
      [
        "run.created",
        "run.started",
        "message.part.started",
        "action.proposed",
        "action.validated",
        "observation.created",
        "eval.started",
        "self_improvement.analysis.queued",
        "message.part.completed",
        "run.completed",
      ].every((eventType) => conversationUi.includes(`"${eventType}"`)),
    "Frontend must listen to protocol events that do not render cards; otherwise named SSE events are dropped and false seq gaps cause reconnect loops.",
  );
  expect(
    "duplicate events are merged by UI state reducers",
    /seenEventIds/.test(conversationUi) &&
      /upsertRuntimeItem/.test(conversationUi) &&
      /mergeRuntimeActivityItem/.test(conversationUi),
    "Duplicate runtime cards should be merged, not appended.",
  );
  expect(
    "tool artifact swarm and approval events have structured UI surfaces",
    /tool\.call\.completed/.test(conversationUi) &&
      /artifact\.preview\.ready/.test(conversationUi) &&
      /swarm\.review/.test(conversationUi) &&
      /Panel title="Swarm Tree"/.test(runTracePage) &&
      /Approval lifecycle smoke passed/.test(approvalStatus),
    "Protocol UI surfaces should be covered by runtime cards, artifact panels, swarm tree, and approval lifecycle smoke.",
  );
} finally {
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
  cleanupSmokeRows();
}

finish();

async function runProductionBuild() {
  const output = [];
  const child = spawn("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  expect("production build refreshed", exitCode === 0, output.join("\n").slice(-3000));
  if (exitCode !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("event protocol server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("event protocol server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForRun(runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId);
      if (run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled") {
        return run;
      }
      await delay(500);
    }
    return db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId);
  } finally {
    db.close();
  }
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, text };
  }
}

async function readSseEvents(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const events = [];
  let response;
  try {
    response = await fetch(url, {
      headers: options.headers ?? {},
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      return events;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitIndex;
      while ((splitIndex = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        const event = parseSseBlock(block);
        if (!event) {
          continue;
        }
        events.push(event);
        if (options.stopType && event.type === options.stopType) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
  return events;
}

function parseSseBlock(block) {
  const dataLine = block
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(dataLine.slice("data: ".length));
    return parsed?.schema_version ? parsed : null;
  } catch {
    return null;
  }
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function unwrapEventPayload(value) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isActiveRuntimeEvent(type) {
  return [
    "run.created",
    "message.part.delta",
    "tool.call.started",
    "model.call.started",
    "artifact.create.started",
    "swarm.branch.started",
    "swarm.plan",
    "swarm.reduce",
    "swarm.merge",
    "swarm.verify",
    "swarm.review",
  ].includes(type);
}

function cleanupSmokeRows() {
  if (!existsSync(dbPath)) {
    return;
  }
  const db = new DatabaseSync(dbPath);
  try {
    const conversations = db
      .prepare("SELECT id FROM conversations WHERE title = ?")
      .all(smokeTitle)
      .map((row) => row.id);
    if (conversations.length === 0) {
      return;
    }
    const placeholders = conversations.map(() => "?").join(",");
    const runs = db
      .prepare(`SELECT id FROM runs WHERE conversation_id IN (${placeholders})`)
      .all(...conversations)
      .map((row) => row.id);
    runDelete(db, "DELETE FROM self_improvement_candidates WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM eval_results WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM observations WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM agent_actions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM tool_calls WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM trace_spans WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM run_events WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM artifacts WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM messages WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM agent_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM sandbox_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM context_bundles WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM tasks WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM runs WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM conversations WHERE id IN", conversations);
    expect("smoke rows cleaned", true, `${conversations.length} conversation(s) removed`);
  } finally {
    db.close();
  }
}

function runDelete(db, prefix, ids) {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`${prefix} (${placeholders})`).run(...ids);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nEvent protocol e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nEvent protocol e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
