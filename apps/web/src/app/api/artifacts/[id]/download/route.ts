import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getArtifact } from "@/server/repositories/artifacts";
import { resolveLocalUri } from "@/server/storage/paths";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const artifact = await getArtifact(id);
  if (!artifact?.storageUri) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const content = await readFile(resolveLocalUri(artifact.storageUri));
  return new Response(content, {
    headers: {
      "Content-Type": artifact.mimeType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${artifact.title.replaceAll('"', "")}"`,
    },
  });
}
