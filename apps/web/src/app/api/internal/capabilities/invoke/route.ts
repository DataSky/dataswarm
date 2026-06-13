import { NextResponse } from "next/server";
import { invokeSandboxCapability } from "@/server/runtime/capabilities";
import { verifySandboxToolProxyToken } from "@/server/runtime/sandbox-tool-proxy";
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
        capabilityName?: string;
        toolName?: string;
        input?: Record<string, unknown>;
      }
    | null;

  const capabilityName = body?.capabilityName ?? body?.toolName;
  if (
    !body?.proxySessionToken ||
    !body.runId ||
    !body.branchId ||
    !body.sandboxSessionId ||
    !body.actionId ||
    !capabilityName ||
    typeof body.input !== "object" ||
    body.input === null ||
    Array.isArray(body.input)
  ) {
    return NextResponse.json(
      {
        status: "failed",
        error: {
          code: "invalid_capability_invoke_request",
          message: "proxySessionToken, runId, branchId, sandboxSessionId, actionId, capabilityName/toolName, and input are required.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const claims = verifySandboxToolProxyToken(body.proxySessionToken);
    if (claims.runId !== body.runId || claims.branchId !== body.branchId || claims.sandboxSessionId !== body.sandboxSessionId) {
      throw new Error("Capability invoke token claims do not match request.");
    }
    const result = await invokeSandboxCapability({
      claims,
      actionId: body.actionId,
      capabilityName,
      capabilityInput: body.input,
      legacyEventPrefix: "sandbox.tool_proxy.call",
    });
    return NextResponse.json(result);
  } catch (error) {
    logServer("warn", "api.capability_invoke.failed", {
      runId: body.runId,
      branchId: body.branchId,
      sandboxSessionId: body.sandboxSessionId,
      capabilityName,
      ...errorPayload(error),
    });
    return NextResponse.json(
      {
        status: "failed",
        error: {
          code: "capability_invoke_failed",
          message: error instanceof Error ? error.message : "Capability invocation failed.",
        },
      },
      { status: 403 },
    );
  }
}
