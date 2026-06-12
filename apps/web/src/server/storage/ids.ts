import { randomUUID } from "node:crypto";

export function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso() {
  return new Date().toISOString();
}
