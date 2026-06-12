import { makeId } from "../storage/ids";
import { appendObservedLog } from "../repositories/logs";

type LogLevel = "debug" | "info" | "warn" | "error";

const previewLimit = 160;

export function createRequestId(prefix = "req") {
  return makeId(prefix);
}

export function logServer(level: LogLevel, event: string, payload: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method(`[DataSwarm:server] ${JSON.stringify(line)}`);
  if (level !== "debug") {
    void appendObservedLog({ source: "server", level, event, payload }).catch(() => undefined);
  }
}

export function textPreview(value: string | null | undefined) {
  if (!value) {
    return { textLength: 0, textPreview: "" };
  }
  return {
    textLength: value.length,
    textPreview: redact(value).slice(0, previewLimit),
  };
}

export function errorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: redact(error.message),
      errorStack: error.stack ? redact(error.stack).split("\n").slice(0, 4).join("\n") : undefined,
    };
  }
  return { errorMessage: redact(String(error)) };
}

function redact(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/e2b_[a-f0-9]{40}/gi, "[REDACTED_SECRET]")
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]");
}
