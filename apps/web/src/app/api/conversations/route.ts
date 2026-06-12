import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/server/repositories/conversations";

export const runtime = "nodejs";

export async function GET() {
  const conversations = await listConversations();
  return NextResponse.json({ conversations });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    defaultModel?: string;
  };

  const conversation = await createConversation({
    title: body.title,
    defaultModel: body.defaultModel,
  });

  return NextResponse.json({ conversation }, { status: 201 });
}
