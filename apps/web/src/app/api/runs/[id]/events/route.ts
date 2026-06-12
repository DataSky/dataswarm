import { getEventSeqById, listRunEventsAfter } from "@/server/repositories/events";
import { createRequestId, logServer } from "@/server/observability/logger";
import { encodeSse, subscribeToRunEvents } from "@/server/runtime/event-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: runId } = await context.params;
  const requestId = createRequestId("req_sse");
  const url = new URL(request.url);
  const fromSeqParam = url.searchParams.get("from_seq");
  const lastEventId = request.headers.get("last-event-id");
  let fromSeq = fromSeqParam ? Number.parseInt(fromSeqParam, 10) : 0;
  if (!Number.isFinite(fromSeq)) {
    fromSeq = 0;
  }
  if (lastEventId) {
    fromSeq = await getEventSeqById(runId, lastEventId);
  }
  logServer("info", "api.events.connect", { requestId, runId, fromSeq, lastEventId });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const sentEventIds = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Awaited<ReturnType<typeof listRunEventsAfter>>[number]) => {
        if (sentEventIds.has(event.id)) {
          logServer("debug", "api.events.send.dedupe", { requestId, runId, eventId: event.id, eventType: event.type, seq: event.seq });
          return;
        }
        sentEventIds.add(event.id);
        logServer("debug", "api.events.send", { requestId, runId, eventId: event.id, eventType: event.type, seq: event.seq });
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      unsubscribe = subscribeToRunEvents(runId, send);

      const historical = await listRunEventsAfter(runId, fromSeq);
      logServer("info", "api.events.historical.loaded", {
        requestId,
        runId,
        fromSeq,
        historicalCount: historical.length,
      });
      for (const event of historical) {
        send(event);
      }

      heartbeat = setInterval(() => {
        controller.enqueue(
          encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`),
        );
      }, 15000);
    },
    cancel() {
      logServer("info", "api.events.disconnect", { requestId, runId, sentCount: sentEventIds.size });
      unsubscribe?.();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
