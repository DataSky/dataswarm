import { appendRunEvent, type RunEventEnvelope } from "../repositories/events";
import { logServer } from "../observability/logger";

type Subscriber = (event: RunEventEnvelope) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export async function publishRunEvent(input: Parameters<typeof appendRunEvent>[0]) {
  const event = await appendRunEvent(input);
  const runSubscribers = subscribers.get(input.runId);
  logServer("debug", "event_bus.publish", {
    runId: input.runId,
    eventId: event.id,
    eventType: event.type,
    seq: event.seq,
    subscriberCount: runSubscribers?.size ?? 0,
    producerKind: event.producer.kind,
  });
  if (runSubscribers) {
    for (const subscriber of runSubscribers) {
      subscriber(event);
    }
  }
  return event;
}

export function subscribeToRunEvents(runId: string, subscriber: Subscriber) {
  let runSubscribers = subscribers.get(runId);
  if (!runSubscribers) {
    runSubscribers = new Set();
    subscribers.set(runId, runSubscribers);
  }
  runSubscribers.add(subscriber);
  logServer("info", "event_bus.subscribe", { runId, subscriberCount: runSubscribers.size });

  return () => {
    const current = subscribers.get(runId);
    if (!current) {
      return;
    }
    current.delete(subscriber);
    logServer("info", "event_bus.unsubscribe", { runId, subscriberCount: current.size });
    if (current.size === 0) {
      subscribers.delete(runId);
    }
  };
}

export function encodeSse(event: RunEventEnvelope) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
