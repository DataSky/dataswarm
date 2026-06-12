import type { ModelProfile } from "../repositories/model-profiles";
import type { ModelProvider } from "../models/provider";
import type { SwarmPlan } from "./swarm";
import type { SwarmReductionResult } from "./swarm-reducer";
import type { SwarmVerificationResult } from "./swarm-verifier";

export type SwarmReviewMode = "disabled" | "mock" | "model";

export type SwarmReviewFinding = {
  severity: "info" | "warning" | "critical";
  detail: string;
  evidenceRefs: string[];
};

export type SwarmReviewResult = {
  status: "skipped" | "completed" | "failed";
  reviewMode: SwarmReviewMode;
  modelProfile?: string;
  summary: string;
  confidence: number;
  findings: SwarmReviewFinding[];
  recommendations: string[];
  requiredFollowUp: boolean;
  rawText?: string;
};

export type SwarmReviewInput = {
  plan: SwarmPlan;
  reduction: SwarmReductionResult;
  verification: SwarmVerificationResult;
  completedBranches: number;
  failedBranches: number;
  artifactIds: string[];
  branchObservationIds: string[];
  observations: string[];
  provider?: ModelProvider;
  profile?: ModelProfile;
};

export async function reviewSwarmResult(input: SwarmReviewInput): Promise<SwarmReviewResult> {
  const reviewMode = getSwarmReviewMode();
  if (reviewMode === "disabled") {
    return {
      status: "skipped",
      reviewMode,
      summary: "Optional model-assisted swarm review is disabled.",
      confidence: 0,
      findings: [],
      recommendations: [],
      requiredFollowUp: false,
    };
  }

  if (reviewMode === "mock") {
    return buildMockReview(input);
  }

  if (!input.provider || !input.profile) {
    return {
      status: "failed",
      reviewMode,
      summary: "Model-assisted swarm review was requested, but no model provider/profile was available.",
      confidence: 0,
      findings: [
        {
          severity: "critical",
          detail: "Missing model provider/profile for DATASWARM_SWARM_REVIEW_MODE=model.",
          evidenceRefs: [],
        },
      ],
      recommendations: ["Pass the parent Orchestrator model provider/profile into executeSwarm before enabling model review."],
      requiredFollowUp: true,
    };
  }

  return runModelReview(input, input.provider, input.profile);
}

export function getSwarmReviewMode(): SwarmReviewMode {
  const raw = (process.env.DATASWARM_SWARM_REVIEW_MODE ?? "disabled").trim().toLowerCase();
  if (raw === "mock" || raw === "model") {
    return raw;
  }
  return "disabled";
}

function buildMockReview(input: SwarmReviewInput): SwarmReviewResult {
  const findings: SwarmReviewFinding[] = [];
  if (input.verification.status !== "passed") {
    findings.push({
      severity: input.verification.status === "failed" ? "critical" : "warning",
      detail: `Deterministic verifier status is ${input.verification.status}.`,
      evidenceRefs: input.branchObservationIds,
    });
  }
  if (input.reduction.conflictSignals.length > 0) {
    findings.push({
      severity: "warning",
      detail: `Reducer detected ${input.reduction.conflictSignals.length} conflict/source-mismatch signal(s).`,
      evidenceRefs: input.branchObservationIds,
    });
  }
  if (input.failedBranches > 0) {
    findings.push({
      severity: "warning",
      detail: `${input.failedBranches} branch(es) failed and should remain isolated from unsupported final claims.`,
      evidenceRefs: input.branchObservationIds,
    });
  }

  return {
    status: "completed",
    reviewMode: "mock",
    summary: `Mock swarm review completed over ${input.branchObservationIds.length} branch observation(s).`,
    confidence: input.verification.status === "passed" ? 0.72 : 0.46,
    findings,
    recommendations:
      findings.length > 0
        ? ["Keep deterministic verifier findings visible in the final synthesis.", "Re-run or narrow failed/conflicting branches before high-stakes use."]
        : ["Use the deterministic reducer/verifier output as the final synthesis evidence base."],
    requiredFollowUp: findings.some((finding) => finding.severity === "critical"),
  };
}

async function runModelReview(input: SwarmReviewInput, provider: ModelProvider, profile: ModelProfile): Promise<SwarmReviewResult> {
  const messages = [
    {
      role: "system" as const,
      content:
        "You are DataSwarm's swarm review layer. Review deterministic reducer and verifier outputs. Do not add new facts. Return strict JSON only.",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          required_schema: {
            summary: "string",
            confidence: "number 0..1",
            findings: [{ severity: "info|warning|critical", detail: "string", evidenceRefs: ["obs_or_artifact_id"] }],
            recommendations: ["string"],
            requiredFollowUp: "boolean",
          },
          plan: {
            strategy: input.plan.strategy,
            planSource: input.plan.planSource,
            branchCount: input.plan.branches.length,
            branches: input.plan.branches.map((branch) => ({
              id: branch.id,
              title: branch.title,
              instruction: branch.instruction,
              modelProfile: branch.modelProfile,
            })),
          },
          reduction: input.reduction,
          verification: input.verification,
          evidence: {
            completedBranches: input.completedBranches,
            failedBranches: input.failedBranches,
            artifactIds: input.artifactIds,
            branchObservationIds: input.branchObservationIds,
            observationSummaries: input.observations,
          },
        },
        null,
        2,
      ),
    },
  ];

  let rawText = "";
  try {
    for await (const chunk of provider.streamChat({
      profile,
      messages,
      purpose: "swarm_model_review",
      maxOutputTokens: Number(process.env.DATASWARM_SWARM_REVIEW_MAX_TOKENS ?? 2048),
    })) {
      if (chunk.type === "text-delta") {
        rawText += chunk.text;
      }
    }
    return normalizeModelReview(rawText, profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      reviewMode: "model",
      modelProfile: profile.model,
      summary: `Model-assisted swarm review failed: ${message}`,
      confidence: 0,
      findings: [{ severity: "critical", detail: message, evidenceRefs: [] }],
      recommendations: ["Keep deterministic reducer/verifier output as the source of truth and retry review after model transport is healthy."],
      requiredFollowUp: true,
      rawText,
    };
  }
}

function normalizeModelReview(rawText: string, profile: ModelProfile): SwarmReviewResult {
  const parsed = parseJsonObject(rawText);
  if (!parsed) {
    return {
      status: "failed",
      reviewMode: "model",
      modelProfile: profile.model,
      summary: "Model-assisted swarm review returned non-JSON output.",
      confidence: 0,
      findings: [{ severity: "critical", detail: "Reviewer output could not be parsed as JSON.", evidenceRefs: [] }],
      recommendations: ["Inspect raw reviewer output and tighten the reviewer prompt/schema."],
      requiredFollowUp: true,
      rawText,
    };
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((item) => normalizeFinding(item)).filter((item): item is SwarmReviewFinding => Boolean(item))
    : [];
  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.map((item) => String(item).trim()).filter(Boolean).slice(0, 6)
    : [];
  const confidence = clampNumber(Number(parsed.confidence), 0, 1);
  return {
    status: "completed",
    reviewMode: "model",
    modelProfile: profile.model,
    summary: String(parsed.summary ?? "Model-assisted swarm review completed.").slice(0, 1200),
    confidence,
    findings,
    recommendations,
    requiredFollowUp: Boolean(parsed.requiredFollowUp),
    rawText,
  };
}

function normalizeFinding(value: unknown): SwarmReviewFinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const severity = record.severity === "critical" || record.severity === "warning" ? record.severity : "info";
  const detail = String(record.detail ?? "").trim();
  if (!detail) {
    return null;
  }
  return {
    severity,
    detail: detail.slice(0, 800),
    evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.map(String).filter(Boolean).slice(0, 12) : [],
  };
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  const candidate = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(min, Math.min(max, value));
}
