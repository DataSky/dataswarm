import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.DATASWARM_DATA_DIR ?? "data",
);

const localRoots = {
  uploads: path.join(dataDir, "uploads"),
  artifacts: path.join(dataDir, "artifacts"),
  traces: path.join(dataDir, "traces"),
  "sandbox-bundles": path.join(dataDir, "sandbox-bundles"),
  "self-improvement": path.join(dataDir, "self-improvement"),
  "emergency-events": path.join(dataDir, "emergency-events"),
} as const;

export type LocalStoreKind = keyof typeof localRoots;

export function getSqlitePath() {
  return path.join(dataDir, "dataswarm.sqlite");
}

export async function ensureDataDirs() {
  await mkdir(dataDir, { recursive: true });
  await Promise.all(
    Object.values(localRoots).map((directory) => mkdir(directory, { recursive: true })),
  );
}

export function localUri(kind: LocalStoreKind, ...segments: string[]) {
  return `local://${[kind, ...segments].join("/")}`;
}

export function resolveLocalUri(uri: string) {
  const prefix = "local://";
  if (!uri.startsWith(prefix)) {
    throw new Error(`Unsupported storage URI: ${uri}`);
  }

  const [kind, ...segments] = uri.slice(prefix.length).split("/");
  if (!kind || !(kind in localRoots)) {
    throw new Error(`Unknown local storage kind: ${kind}`);
  }

  const resolved = path.join(localRoots[kind as LocalStoreKind], ...segments);
  const root = localRoots[kind as LocalStoreKind];
  if (!resolved.startsWith(root)) {
    throw new Error(`Refusing to resolve unsafe local URI: ${uri}`);
  }

  return resolved;
}

export function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

export async function atomicWriteText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}
