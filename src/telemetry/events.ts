import type { ArtifactStore } from "../artifacts/store.js";
import type { FailureClass } from "../domain/failure.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export type TelemetryEventType =
  | "run_start"
  | "task_start"
  | "task_complete"
  | "gate_start"
  | "gate_complete"
  | "retry"
  | "escalation"
  | "budget_consumed"
  | "run_finish";

export interface TelemetryEvent {
  trace_id: string;
  run_id: string;
  timestamp: string;
  event_type: TelemetryEventType;
  task_id?: string;
  gate_id?: string;
  attempt?: number;
  duration_ms?: number;
  failure_class?: FailureClass;
  status?: string;
  metrics?: Record<string, number>;
}

export class TelemetryLogger {
  constructor(private readonly store: ArtifactStore) {}

  logEvent(event: TelemetryEvent): void {
    const runDir = this.store.getRunDir(event.run_id);
    const eventsPath = path.join(runDir, "events.jsonl");
    let content = "";
    if (existsSync(eventsPath)) {
      content = readFileSync(eventsPath, "utf8");
    }
    content += JSON.stringify(event) + "\n";

    this.store.saveArtifact({
      id: "art_events",
      runId: event.run_id,
      kind: "events",
      relativePath: "events.jsonl",
      content: content,
      mimeType: "application/x-ndjson",
    });
  }
}
