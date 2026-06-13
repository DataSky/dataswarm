import { NextResponse } from "next/server";
import { executeSandboxToolProxyCall } from "@/server/runtime/sandbox-tool-proxy";
import { errorPayload, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        proxySessionToken?: string;
        runId?: string;
        branchId?: string;
        sandboxSessionId?: string;
        actionId?: string;
        toolName?: string;
        input?: Record<string, unknown>;
      }
    | null;

  if (
    !body?.proxySessionToken ||
    !body.runId ||
    !body.branchId ||
    !body.sandboxSessionId ||
    !body.actionId ||
    !body.toolName ||
    typeof body.input !== "object" ||
    body.input === null ||
    Array.isArray(body.input)
  ) {
    return NextResponse.json(
      {
        status: "failed",
        error: {
          code: "invalid_sandbox_tool_proxy_request",
          message: "proxySessionToken, runId, branchId, sandboxSessionId, actionId, toolName, and input are required.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await executeSandboxToolProxyCall({
      proxySessionToken: body.proxySessionToken,
      runId: body.runId,
      branchId: body.branchId,
      sandboxSessionId: body.sandboxSessionId,
      actionId: body.actionId,
      toolName: body.toolName,
      input: body.input,
    });
    return NextResponse.json(result);
  } catch (error) {
    logServer("warn", "api.sandbox_tool_proxy.failed", {
      runId: body.runId,
      branchId: body.branchId,
      sandboxSessionId: body.sandboxSessionId,
      toolName: body.toolName,
      ...errorPayload(error),
    });
    return NextResponse.json(
      {
        status: "failed",
        error: {
          code: "sandbox_tool_proxy_failed",
          message: error instanceof Error ? error.message : "Sandbox tool proxy call failed.",
        },
      },
      { status: 403 },
    );
  }
}
