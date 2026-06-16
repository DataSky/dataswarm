import { NextResponse } from "next/server";
import { getSandboxCapabilityPlaneHealth } from "@/server/runtime/sandbox-tool-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = getSandboxCapabilityPlaneHealth();
    return NextResponse.json(health, { status: health.status === "ready" ? 200 : 503 });
  } catch (error) {
    return NextResponse.json(
      {
        status: "failed",
        runtimeProfile: process.env.DATASWARM_RUNTIME_PROFILE || "unspecified",
        hardFailures: ["sandbox_health_runtime_guard_failed"],
        error: {
          code: "sandbox_health_runtime_guard_failed",
          message: error instanceof Error ? error.message : "Sandbox capability plane health check failed.",
        },
      },
      { status: 503 },
    );
  }
}
