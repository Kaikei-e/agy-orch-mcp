import type { TaskSpecV1 } from "../domain/ir.js";
import type { FailureClass } from "../domain/failure.js";
import type { WorkerTier } from "../domain/execution.js";
import { type Config as BridgeConfig, type Config } from "../config.js";

export type RoutingActionKind =
  "retry_same_tier" | "escalate_reasoning" | "handoff_host" | "fail_stop";

export interface RoutingDecision {
  action: RoutingActionKind;
  targetTier?: WorkerTier;
  reason: string;
  needsHost: boolean;
}

export interface RoutingContext {
  failureClass: FailureClass;
  currentTier: WorkerTier;
  attemptCount?: number;
  currentFingerprint?: string;
  previousFingerprint?: string;
  repeatedFingerprintCount?: number;
  isSemanticFailureExplicit?: boolean;
}

export interface ModelResolutionResult {
  model?: string;
  effort?: "low" | "medium" | "high";
  isExplicit: boolean;
  limitationNotice?: string;
}

/**
 * Pure helper to determine routing action based on failure classification and fingerprint history.
 * Scheduler owns budget enforcement, so this helper evaluates policy rules without looping.
 */
export function decideRoutingAction(context: RoutingContext): RoutingDecision {
  const { failureClass, currentTier } = context;

  // Immediate fail-stop on policy denial or security violation
  if (
    failureClass === "POLICY_DENIED" ||
    failureClass === "SECURITY_VIOLATION"
  ) {
    return {
      action: "fail_stop",
      needsHost: true,
      reason:
        "Policy denial or security violation detected; fail-closed immediately.",
    };
  }

  // Host handoff required for architectural decisions, ambiguity, scope violations, patch conflicts, budget exhaustion
  if (failureClass === "REQUIREMENT_AMBIGUITY") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason: "Requirement ambiguity detected; host clarification required.",
    };
  }

  if (failureClass === "ARCHITECTURE_DECISION") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason: "Architecture decision required; host guidance needed.",
    };
  }

  if (failureClass === "SCOPE_VIOLATION") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason:
        "Scope violation: edits occurred outside owned boundaries. Discard patch and hand off to host.",
    };
  }

  if (failureClass === "PATCH_CONFLICT") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason:
        "Patch conflict detected during integration; hand off to host to resolve dependency/concurrency conflict.",
    };
  }

  if (failureClass === "BUDGET_EXHAUSTED") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason: "Budget exhausted; hand off to host.",
    };
  }

  if (failureClass === "INTERNAL_ERROR") {
    return {
      action: "fail_stop",
      needsHost: true,
      reason:
        "Internal runtime error encountered; halt and preserve artifacts.",
    };
  }

  // Gate timeout: hand off to host per draft spec
  if (failureClass === "GATE_TIMEOUT") {
    return {
      action: "handoff_host",
      needsHost: true,
      reason: "Gate execution timed out; hand off to host.",
    };
  }

  // Transient infra and Rate limit: retry at same tier (never escalate to reasoning)
  if (failureClass === "TRANSIENT_INFRA" || failureClass === "RATE_LIMIT") {
    return {
      action: "retry_same_tier",
      targetTier: currentTier,
      needsHost: false,
      reason: `${failureClass} failure; retry at same tier within budget without escalating.`,
    };
  }

  // Worker timeout: retry at same tier within budget
  if (failureClass === "WORKER_TIMEOUT") {
    return {
      action: "retry_same_tier",
      targetTier: currentTier,
      needsHost: false,
      reason: "Worker timeout; retry at same tier within budget.",
    };
  }

  // Semantic failure: escalate to reasoning tier once.
  // If already at reasoning tier, hand off to host.
  if (failureClass === "SEMANTIC_FAILURE") {
    if (currentTier === "reasoning") {
      return {
        action: "handoff_host",
        needsHost: true,
        reason:
          "Semantic failure persisted after reasoning worker attempt; hand off to host.",
      };
    }
    return {
      action: "escalate_reasoning",
      targetTier: "reasoning",
      needsHost: false,
      reason:
        "Semantic failure allows immediate 1-time escalation to reasoning tier.",
    };
  }

  // Deterministic test failure:
  // Initial repair is fast tier.
  // Escalate to reasoning ONLY when the same coarse fingerprint repeats consecutively.
  if (failureClass === "DETERMINISTIC_TEST_FAILURE") {
    const isRepeatedCoarse =
      (context.previousFingerprint !== undefined &&
        context.previousFingerprint !== "" &&
        context.currentFingerprint !== undefined &&
        context.previousFingerprint === context.currentFingerprint) ||
      (context.repeatedFingerprintCount !== undefined &&
        context.repeatedFingerprintCount >= 1);

    if (isRepeatedCoarse) {
      if (currentTier === "reasoning") {
        return {
          action: "handoff_host",
          needsHost: true,
          reason:
            "Deterministic test failure repeated on reasoning tier; hand off to host.",
        };
      }
      return {
        action: "escalate_reasoning",
        targetTier: "reasoning",
        needsHost: false,
        reason:
          "Deterministic test failure repeated with identical coarse fingerprint; escalate to reasoning tier.",
      };
    }

    // Not repeated: retry same tier
    return {
      action: "retry_same_tier",
      targetTier: currentTier,
      needsHost: false,
      reason: "Deterministic test failure; retry at same tier.",
    };
  }

  // Fallback for unclassified
  return {
    action: "handoff_host",
    needsHost: true,
    reason: `Unhandled failure class "${failureClass}"; handing off to host.`,
  };
}

/**
 * Pure helper checking if the context justifies escalating to reasoning tier.
 */
export function shouldEscalateToReasoning(context: RoutingContext): boolean {
  return decideRoutingAction(context).action === "escalate_reasoning";
}

/**
 * Resolves model and effort for a given tier according to BridgeConfig and task spec overrides.
 * Honestly reports limitations if BridgeConfig lacks tier-specific model mappings.
 */
export function resolveWorkerModel(
  tier: WorkerTier,
  config: BridgeConfig | Config,
  explicitTaskModel?: string,
): ModelResolutionResult {
  const effort: "low" | "medium" | "high" =
    tier === "reasoning" ? "high" : "low";

  if (explicitTaskModel && explicitTaskModel.trim()) {
    return {
      model: explicitTaskModel.trim(),
      effort,
      isExplicit: true,
    };
  }

  // Check optional tier model fields via local cast if extended config is present
  const extendedConfig = config as BridgeConfig & {
    tierModels?: Record<WorkerTier, string>;
    fastModel?: string;
    reasoningModel?: string;
  };

  const configuredTierModel =
    extendedConfig.tierModels?.[tier] ??
    (tier === "fast"
      ? extendedConfig.fastModel
      : extendedConfig.reasoningModel);

  if (configuredTierModel && configuredTierModel.trim()) {
    return {
      model: configuredTierModel.trim(),
      effort,
      isExplicit: false,
    };
  }

  if (config.defaultModel && config.defaultModel.trim()) {
    return {
      model: config.defaultModel.trim(),
      effort,
      isExplicit: false,
      limitationNotice:
        tier === "reasoning"
          ? "BridgeConfig has no reasoningModel configured; falling back to defaultModel with high effort."
          : undefined,
    };
  }

  return {
    model: undefined,
    effort,
    isExplicit: false,
    limitationNotice:
      "BridgeConfig has no defaultModel or tier-specific model configured; relying on agy CLI default model.",
  };
}

/**
 * Extracts initial worker tier from task specification (defaults to 'fast').
 */
export function selectInitialWorkerTier(task: TaskSpecV1): WorkerTier {
  return task.worker?.tier ?? "fast";
}

// --- Legacy routing compatibility helpers ---
export interface TierConfig {
  model?: string;
  effort?: string;
}

export interface ModelRoutingConfig {
  tiers: {
    fast: TierConfig;
    reasoning: TierConfig;
  };
}

export const DEFAULT_ROUTING: ModelRoutingConfig = {
  tiers: {
    fast: {},
    reasoning: {},
  },
};

export function resolveModel(
  tier: "fast" | "reasoning",
  routing: ModelRoutingConfig = DEFAULT_ROUTING,
  taskModelOverride?: string,
): string | undefined {
  if (taskModelOverride) return taskModelOverride;
  return routing.tiers[tier]?.model;
}

export function canEscalateToReasoning(routing: ModelRoutingConfig): boolean {
  return routing.tiers.reasoning.model !== undefined;
}
