export interface RunMetricsTracker {
  startTime: number;
  workerCalls: number;
  retries: number;
  escalations: number;
  rawOutputBytes: number;
  digestTokensEstimated: number;
}

export function createMetricsTracker(): RunMetricsTracker {
  return {
    startTime: Date.now(),
    workerCalls: 0,
    retries: 0,
    escalations: 0,
    rawOutputBytes: 0,
    digestTokensEstimated: 0,
  };
}

export function finalizeMetrics(
  tracker: RunMetricsTracker,
  digestTokensEstimated = 0,
) {
  return {
    duration_ms: Date.now() - tracker.startTime,
    worker_calls: tracker.workerCalls,
    retries: tracker.retries,
    escalations: tracker.escalations,
    raw_output_bytes: tracker.rawOutputBytes,
    digest_tokens_estimated: digestTokensEstimated,
  };
}
