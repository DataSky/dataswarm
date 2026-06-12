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
  if (!artifact?.previewUri) {
    return NextResponse.json({ error: "Artifact preview not found" }, { status: 404 });
  }

  const content = await readFile(resolveLocalUri(artifact.previewUri));
  return new Response(content, {
    headers: {
      "Content-Type": artifact.mimeType?.startsWith("image/") ? artifact.mimeType : "text/html; charset=utf-8",
    },
  });
}
