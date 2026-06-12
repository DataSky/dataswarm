import { NextResponse } from "next/server";
import { appendObservedLog } from "@/server/repositories/logs";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = createRequestId("req_log");
  const body = (await request.json().catch(() => ({}))) as {
    level?: "debug" | "info" | "warn" | "error";
    event?: string;
    payload?: Record<string, unknown>;
  };

  if (!body.event) {
    return NextResponse.json({ error: "Log event is required" }, { status: 400 });
  }

  await appendObservedLog({
    source: "ui",
    level: body.level ?? "info",
    event: body.event,
    payload: {
      requestId,
      ...(body.payload ?? {}),
    },
  });

  logServer("info", "api.logs.accepted", {
    requestId,
    source: "ui",
    event: body.event,
    conversationId: body.payload?.conversationId,
    runId: body.payload?.runId,
  });

  return NextResponse.json({ ok: true });
}
