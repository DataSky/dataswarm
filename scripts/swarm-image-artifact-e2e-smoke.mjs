import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SWARM_IMAGE_E2E_PORT ?? 3237);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke swarm image artifact e2e";
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  cleanupSmokeRows();

  if (process.env.DATASWARM_SWARM_IMAGE_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_AGENT_MAX_STEPS: "4",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_SWARM_REVIEW_MODE: "mock",
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
    text: "使用沙箱绘制一个 f=sin(x) 的图片返回给我",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("sandbox plot message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const imageArtifacts = db
      .prepare(
        `SELECT a.id, a.title, a.type, a.mime_type, a.status, a.storage_uri, a.preview_uri, a.metadata_json,
                av.size_bytes, av.content_hash
         FROM artifacts a
         LEFT JOIN artifact_versions av ON av.id = a.current_version_id
         WHERE a.conversation_id = ? AND a.run_id = ? AND a.type = 'image'
         ORDER BY a.created_at ASC`,
      )
      .all(conversationId, runId);
    expect(
      "sandbox plot created one canonical image artifact",
      imageArtifacts.length === 1 &&
        imageArtifacts.every(
          (artifact) =>
            artifact.status === "preview_ready" &&
            typeof artifact.id === "string" &&
            typeof artifact.content_hash === "string" &&
            Number(artifact.size_bytes) > 100 &&
            String(artifact.mime_type).startsWith("image/") &&
            typeof artifact.storage_uri === "string" &&
            artifact.storage_uri === artifact.preview_uri,
        ),
      JSON.stringify(imageArtifacts),
    );

    const imageArtifactIds = imageArtifacts.map((artifact) => artifact.id);
    const imageContentHashes = new Set(imageArtifacts.map((artifact) => artifact.content_hash));
    expect(
      "sandbox plot image artifacts are content-hash deduped",
      imageArtifacts.length === imageContentHashes.size,
      JSON.stringify(imageArtifacts.map((artifact) => ({ id: artifact.id, content_hash: artifact.content_hash, title: artifact.title }))),
    );
    const artifactCreatedEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'artifact.created'
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json));
    const imageCreatedEvents = artifactCreatedEvents.filter((payload) => imageArtifactIds.includes(payload.artifact_id));
    expect(
      "image artifact.created events persisted",
      imageArtifactIds.length > 0 &&
        imageCreatedEvents.length === imageArtifactIds.length &&
        imageCreatedEvents.every((payload) => payload.type === "image" && String(payload.mime_type).startsWith("image/")),
      JSON.stringify(imageCreatedEvents),
    );

    const imagePreviewEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'artifact.preview.ready'
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json))
      .filter((payload) => imageArtifactIds.includes(payload.artifact_id));
    expect(
      "image artifact preview events use image mode",
      imageArtifactIds.length > 0 &&
        imagePreviewEvents.length === imageArtifactIds.length &&
        imagePreviewEvents.every((payload) => payload.preview_type === "image" && typeof payload.preview_uri === "string"),
      JSON.stringify(imagePreviewEvents),
    );

    const assistantMessage = db
      .prepare(
        `SELECT parts_json
         FROM messages
         WHERE conversation_id = ? AND run_id = ? AND role = 'assistant'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(conversationId, runId);
    const messageParts = parseJson(assistantMessage?.parts_json, []);
    const messageArtifactIds = messageParts
      .filter((part) => part?.type === "artifact_preview")
      .map((part) => part.artifact_id);
    expect(
      "assistant message includes image artifact preview part",
      imageArtifactIds.some((id) => messageArtifactIds.includes(id)),
      JSON.stringify({ imageArtifactIds, messageArtifactIds, messageParts }),
    );

    const branchObservations = db
      .prepare(
        `SELECT id, metadata_json
         FROM observations
         WHERE run_id = ? AND source_type = 'agent' AND source_name LIKE 'swarm.branch.%'
         ORDER BY created_at ASC`,
      )
      .all(runId)
      .map((row) => ({ id: row.id, metadata: parseJson(row.metadata_json, {}) }));
    const branchObservationMetadata = branchObservations.map((item) => item.metadata);
    expect(
      "branch observations record image artifact ids",
      branchObservationMetadata.length >= 1 &&
        branchObservationMetadata.every(
          (metadata) =>
            Array.isArray(metadata.image_artifact_ids) &&
            metadata.image_artifact_ids.some((id) => imageArtifactIds.includes(id)),
        ) &&
        branchObservationMetadata.some(
          (metadata) =>
            Array.isArray(metadata.image_artifact_ids) &&
            metadata.image_artifact_ids.some((id) => imageArtifactIds.includes(id)),
        ),
      JSON.stringify(
        branchObservationMetadata.map((metadata) => ({
          branch_id: metadata.branch_id,
          artifact_ids: metadata.artifact_ids,
          image_artifact_ids: metadata.image_artifact_ids,
          image_artifact_count: metadata.quality_signals?.imageArtifactCount,
          branch_artifacts: metadata.branch_artifacts,
        })),
      ),
    );
    expect(
      "all branches reference the canonical image artifact",
      branchObservationMetadata.every(
        (metadata) =>
          Array.isArray(metadata.image_artifact_ids) &&
          metadata.image_artifact_ids.length === 1 &&
          metadata.image_artifact_ids[0] === imageArtifactIds[0],
      ),
      JSON.stringify(
        branchObservationMetadata.map((metadata) => ({
          branch_id: metadata.branch_id,
          artifact_ids: metadata.artifact_ids,
          image_artifact_ids: metadata.image_artifact_ids,
          image_artifact_count: metadata.quality_signals?.imageArtifactCount,
          branch_artifacts: metadata.branch_artifacts,
        })),
      ),
    );
    const imageArtifactMetadata = parseJson(imageArtifacts[0]?.metadata_json, {});
    const branchIds = Array.isArray(imageArtifactMetadata.branchIds) ? imageArtifactMetadata.branchIds : [];
    const sourceObservationIds = Array.isArray(imageArtifactMetadata.sourceObservationIds)
      ? imageArtifactMetadata.sourceObservationIds
      : [];
    expect(
      "canonical image artifact records branch provenance",
      branchIds.length === branchObservationMetadata.length &&
        branchObservationMetadata.every((metadata) => branchIds.includes(metadata.branch_id)),
      JSON.stringify({ branchIds, branchObservationMetadata: branchObservationMetadata.map((metadata) => metadata.branch_id) }),
    );
    expect(
      "canonical image artifact records source observations",
      sourceObservationIds.length === branchObservations.length &&
        branchObservations.every((observation) => sourceObservationIds.includes(observation.id)),
      JSON.stringify({ sourceObservationIds, branchObservationIds: branchObservations.map((observation) => observation.id) }),
    );

    const verifyPayload = latestEventPayload(db, runId, "swarm.verify");
    expect(
      "swarm verifier passes requested image artifact check",
      Array.isArray(verifyPayload.checks) &&
        verifyPayload.checks.some((check) => check.id === "requested_image_artifact_present" && check.status === "passed"),
      JSON.stringify(verifyPayload),
    );

    const artifactsResponse = await fetch(`${baseUrl}/api/conversations/${conversationId}/artifacts`).then((response) => response.json());
    const apiImageArtifacts = Array.isArray(artifactsResponse?.artifacts)
      ? artifactsResponse.artifacts.filter((artifact) => imageArtifactIds.includes(artifact.id))
      : [];
    expect(
      "conversation artifacts API returns image artifacts",
      imageArtifactIds.length > 0 &&
        apiImageArtifacts.length === imageArtifactIds.length &&
        apiImageArtifacts.every(
          (artifact) =>
            artifact.type === "image" &&
            artifact.status === "preview_ready" &&
            artifact.artifactKind === "image" &&
            artifact.previewMode === "image",
        ),
      JSON.stringify(artifactsResponse),
    );
    expect(
      "conversation artifacts API exposes artifact provenance",
      apiImageArtifacts.every(
        (artifact) =>
          Array.isArray(artifact.branchIds) &&
          artifact.branchIds.length === branchObservationMetadata.length &&
          Array.isArray(artifact.sourceObservationIds) &&
          artifact.sourceObservationIds.length === branchObservations.length,
      ),
      JSON.stringify(apiImageArtifacts),
    );
    expect(
      "conversation artifacts API exposes artifact quality signals",
      apiImageArtifacts.every(
        (artifact) =>
          artifact.qualitySignals?.hasContentHash === true &&
          artifact.qualitySignals?.previewReady === true &&
          artifact.qualitySignals?.provenanceComplete === true &&
          artifact.qualitySignals?.sourceObservationCount === branchObservations.length &&
          artifact.qualitySignals?.branchCount === branchObservationMetadata.length,
      ),
      JSON.stringify(apiImageArtifacts.map((artifact) => artifact.qualitySignals)),
    );

    const previewResponse = await fetch(`${baseUrl}/api/artifacts/${imageArtifactIds[0]}/preview`);
    const previewBytes = Buffer.from(await previewResponse.arrayBuffer());
    expect(
      "image artifact preview endpoint returns image bytes",
      previewResponse.ok &&
        previewResponse.headers.get("content-type")?.startsWith("image/") &&
        previewBytes.byteLength > 100,
      JSON.stringify({
        status: previewResponse.status,
        contentType: previewResponse.headers.get("content-type"),
        bytes: previewBytes.byteLength,
      }),
    );
  } finally {
    db.close();
  }
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
      expect("mock production server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("mock production server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForRun(runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deadline = Date.now() + 75_000;
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
  return response.json();
}

function latestEventPayload(db, runId, type) {
  const row = db
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq DESC
       LIMIT 1`,
    )
    .get(runId, type);
  return unwrapEventPayload(row?.payload_json);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function unwrapEventPayload(value) {
  const parsed = parseJson(value, {});
  if (parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object") {
    return parsed.payload;
  }
  return parsed;
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
    const runs = selectIds(db, "SELECT id FROM runs WHERE conversation_id IN", conversations);
    const tasks = selectIds(db, "SELECT id FROM tasks WHERE conversation_id IN", conversations);
    const artifacts = selectIds(db, "SELECT id FROM artifacts WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM self_improvement_candidates WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM messages WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM tasks WHERE id IN", tasks);
    runDelete(db, "DELETE FROM artifact_versions WHERE artifact_id IN", artifacts);
    runDelete(db, "DELETE FROM artifacts WHERE id IN", artifacts);
    runDelete(db, "DELETE FROM eval_results WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM observations WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM agent_actions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM tool_calls WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM approvals WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM skill_usages WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM sandbox_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM context_bundles WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM trace_spans WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM agent_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM run_steps WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM run_events WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM runs WHERE id IN", runs);
    runDelete(db, "DELETE FROM app_logs WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM conversations WHERE id IN", conversations);
  } finally {
    db.close();
  }
}

function selectIds(db, prefix, ids) {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`${prefix} (${placeholders})`)
    .all(...ids)
    .map((row) => row.id);
}

function runDelete(db, prefix, ids) {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`${prefix} (${placeholders})`).run(...ids);
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nSwarm image artifact e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm image artifact e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
