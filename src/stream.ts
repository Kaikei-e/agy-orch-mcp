import type { CommandRecord } from "./run-result.js";

const MAX_RECORDS = 200;
const MAX_TAIL_LINES = 20;
const MAX_TAIL_CHARS = 1_200;
const MAX_ERROR_CHARS = 500;

const EXIT_CODE = /Command exited with code (-?\d+)\./;
const BACKGROUND_TASK =
  /Tool is running as a background task with task id:\s*([^\n]+)/;
const FULL_OUTPUT_PATH =
  /full output in a file at file:\/\/([^\s]+?)\.?(?=\s|$)/;
const DENIED_ERROR =
  /permission check failed|Permission denied for|denied by pre-tool hook/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeCommandLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      return value;
    }
  }
  return value;
}

function extractOutputTail(output: string): string | undefined {
  const marker = "Command output:\n";
  const index = output.indexOf(marker);
  if (index < 0) return undefined;
  const cleaned = output.slice(index + marker.length).replace(/\n+$/, "");
  if (!cleaned) return undefined;
  const lines = cleaned.split("\n").slice(-MAX_TAIL_LINES).join("\n");
  return lines.length > MAX_TAIL_CHARS ? lines.slice(-MAX_TAIL_CHARS) : lines;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  return typeof obj?.message === "string" ? obj.message : undefined;
}

function hasCommandDenial(deniedActions: unknown): boolean {
  if (!Array.isArray(deniedActions)) return false;
  for (const item of deniedActions) {
    const entry = asRecord(item);
    if (
      entry &&
      (entry.action === "command" || entry.display_name === "RunCommand")
    ) {
      return true;
    }
  }
  return false;
}

export class StreamLedger {
  private readonly records = new Map<number, CommandRecord>();
  private readonly provisionalDenied = new Set<number>();
  private readonly stepTokens = new Map<number, number>();
  private unindexedStepTokens = 0;
  private hasStepTokens = false;
  private resultTokens: number | undefined;
  private resultFinishedReason: string | undefined;

  push(event: unknown): void {
    const obj = asRecord(event);
    if (!obj) return;

    if (obj.event === "step_update") {
      const su = asRecord(obj.step_update);
      if (!su) return;
      this.handleStepUpdate(su);
      return;
    }

    if (
      obj.event === "result" ||
      (obj.event === undefined && typeof obj.status === "string")
    ) {
      const res = asRecord(obj.result) ?? obj;
      this.handleResult(res);
    }
  }

  commands(): CommandRecord[] {
    return [...this.records.values()]
      .sort((a, b) => a.step_index - b.step_index)
      .map((rec) => ({ ...rec }));
  }

  deniedCommands(): string[] {
    const seen = new Set<string>();
    for (const rec of this.commands()) {
      if (rec.status === "denied" && rec.command) {
        seen.add(rec.command);
      }
    }
    return [...seen];
  }

  turnTokens(): number | undefined {
    if (this.resultTokens !== undefined) return this.resultTokens;
    if (!this.hasStepTokens) return undefined;
    let sum = this.unindexedStepTokens;
    for (const tokens of this.stepTokens.values()) {
      sum += tokens;
    }
    return sum;
  }

  finishedReason(): string | undefined {
    return this.resultFinishedReason;
  }

  private handleStepUpdate(su: Record<string, unknown>): void {
    if (su.step_type === "agent_response") {
      const usage = asRecord(su.usage);
      const total = usage?.total_tokens;
      if (typeof total === "number" && Number.isFinite(total)) {
        this.hasStepTokens = true;
        if (
          typeof su.step_index === "number" &&
          Number.isFinite(su.step_index)
        ) {
          this.stepTokens.set(su.step_index, total);
        } else {
          this.unindexedStepTokens += total;
        }
      }
      return;
    }

    const toolInfo = asRecord(su.tool_info);
    const toolName =
      typeof su.tool_name === "string"
        ? su.tool_name
        : typeof toolInfo?.name === "string"
          ? toolInfo.name
          : undefined;
    if (toolName !== "run_command") return;

    const stepIndex = su.step_index;
    if (typeof stepIndex !== "number" || !Number.isFinite(stepIndex)) return;

    const params = asRecord(toolInfo?.parameters) ?? asRecord(toolInfo?.args);
    const existing = this.records.get(stepIndex);
    const command = decodeCommandLine(params?.CommandLine) ?? existing?.command;
    if (command === undefined) return;

    const duration =
      typeof su.duration_seconds === "number" &&
      Number.isFinite(su.duration_seconds)
        ? su.duration_seconds
        : existing?.duration_seconds;

    const state = su.state;
    if (state === "ACTIVE") {
      this.provisionalDenied.delete(stepIndex);
      this.setRecord(stepIndex, {
        step_index: stepIndex,
        command,
        status: "running",
        exit_code: null,
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
      });
      return;
    }

    if (state !== "DONE" && state !== "ERROR") return;

    this.provisionalDenied.delete(stepIndex);
    const rawOutput =
      typeof toolInfo?.output === "string" ? toolInfo.output : undefined;
    const rawError = extractErrorMessage(toolInfo?.error);

    if (rawOutput !== undefined && rawOutput.length > 0) {
      const output = rawOutput.replace(/\r/g, "");
      const bgMatch = BACKGROUND_TASK.exec(output);
      if (bgMatch?.[1]) {
        this.setRecord(stepIndex, {
          step_index: stepIndex,
          command,
          status: "background",
          exit_code: null,
          background_task_id: bgMatch[1].trim(),
          ...(duration !== undefined ? { duration_seconds: duration } : {}),
        });
        return;
      }

      const codeMatch = EXIT_CODE.exec(output);
      const exitCode =
        codeMatch?.[1] !== undefined ? Number.parseInt(codeMatch[1], 10) : null;
      const status = exitCode === 0 ? "completed" : "failed";
      const outputTail = extractOutputTail(output);
      const pathMatch = FULL_OUTPUT_PATH.exec(output);
      const fullOutputPath = pathMatch?.[1];

      this.setRecord(stepIndex, {
        step_index: stepIndex,
        command,
        status,
        exit_code: exitCode,
        ...(outputTail !== undefined ? { output_tail: outputTail } : {}),
        ...(fullOutputPath !== undefined
          ? { full_output_path: fullOutputPath }
          : {}),
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
      });
      return;
    }

    if (rawError !== undefined && rawError.length > 0) {
      const status = DENIED_ERROR.test(rawError) ? "denied" : "failed";
      this.setRecord(stepIndex, {
        step_index: stepIndex,
        command,
        status,
        exit_code: null,
        error: rawError.slice(0, MAX_ERROR_CHARS),
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
      });
      return;
    }

    this.provisionalDenied.add(stepIndex);
    this.setRecord(stepIndex, {
      step_index: stepIndex,
      command,
      status: "denied",
      exit_code: null,
      ...(duration !== undefined ? { duration_seconds: duration } : {}),
    });
  }

  private handleResult(res: Record<string, unknown>): void {
    const usage = asRecord(res.usage);
    const total = usage?.total_tokens;
    if (typeof total === "number" && Number.isFinite(total)) {
      this.resultTokens = total;
    }
    if (
      typeof res.finished_reason === "string" &&
      res.finished_reason.length > 0
    ) {
      this.resultFinishedReason = res.finished_reason;
    }

    if (!hasCommandDenial(res.denied_actions)) {
      for (const stepIndex of this.provisionalDenied) {
        const rec = this.records.get(stepIndex);
        if (rec && rec.status === "denied") {
          rec.status = "failed";
          rec.error = "no output recorded";
        }
      }
    }
    this.provisionalDenied.clear();
  }

  private setRecord(stepIndex: number, record: CommandRecord): void {
    this.records.set(stepIndex, record);
    while (this.records.size > MAX_RECORDS) {
      let oldestKey: number | undefined;
      for (const key of this.records.keys()) {
        if (oldestKey === undefined || key < oldestKey) {
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.records.delete(oldestKey);
      this.provisionalDenied.delete(oldestKey);
    }
  }
}
