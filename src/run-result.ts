export interface CommandRecord {
  step_index: number;
  command: string;
  status: "completed" | "failed" | "denied" | "background" | "running";
  exit_code: number | null;
  output_tail?: string;
  error?: string;
  full_output_path?: string;
  background_task_id?: string;
  duration_seconds?: number;
}

export interface RunResult {
  ok: boolean;
  status: string;
  response: string;
  exitCode: number | null;
  error?: string;
  conversationId?: string;
  deniedActions?: unknown[];
  deniedCommands?: string[];
  usage?: Record<string, unknown>;
  durationSec?: number;
  stderr?: string;
  rawStdout?: string;
  runId?: string;
  traceId?: string;
  verifiedOutputs?: CommandRecord[];
  partialResponse?: string;
  preflightWarnings?: string[];
  queueWaitSeconds?: number;
  handoff?: unknown;
  handoffError?: string;
  context?: {
    turns: number;
    cumulative_total_tokens: number;
    turn_total_tokens?: number;
    rotate_threshold_tokens?: number;
    rotate_recommended: boolean;
    advice?: string;
  };
  responseArtifact?: { id: string; path: string };
  recoveryPointer?: {
    run_id: string;
    manifest_artifact_id: string;
    digest_artifact_id: string;
  };
  artifacts?: Array<{
    id: string;
    kind: string;
    byte_size: number;
    sha256: string;
  }>;
}
