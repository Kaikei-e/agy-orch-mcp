/**
 * Cancellation management for batch execution.
 *
 * Creates a hierarchical AbortController structure:
 * - A root controller for the entire batch run (enforces wall-time deadline)
 * - Per-task/per-gate child controllers that abort when their parent does
 *   but can also be individually cancelled
 */

export class CancellationManager {
  private readonly rootController: AbortController;
  private readonly children = new Map<string, AbortController>();
  private wallTimeTimer: ReturnType<typeof setTimeout> | undefined;
  private _wallTimeExceeded = false;

  constructor(wallTimeMs: number, parentSignal?: AbortSignal) {
    this.rootController = new AbortController();

    // Propagate parent signal
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.rootController.abort(parentSignal.reason);
      } else {
        const onAbort = () =>
          this.rootController.abort(parentSignal.reason ?? "parent cancelled");
        parentSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Wall-time deadline
    if (wallTimeMs > 0 && wallTimeMs < Infinity) {
      this.wallTimeTimer = setTimeout(() => {
        this._wallTimeExceeded = true;
        this.rootController.abort("wall-time deadline exceeded");
      }, wallTimeMs);
      // Prevent timer from keeping the process alive
      if (
        typeof this.wallTimeTimer === "object" &&
        "unref" in this.wallTimeTimer
      ) {
        this.wallTimeTimer.unref();
      }
    }
  }

  get signal(): AbortSignal {
    return this.rootController.signal;
  }

  get isAborted(): boolean {
    return this.rootController.signal.aborted;
  }

  get wallTimeExceeded(): boolean {
    return this._wallTimeExceeded;
  }

  /** Create a child AbortController for a specific task or gate. */
  createChild(id: string): AbortController {
    const child = new AbortController();
    this.children.set(id, child);

    // Propagate root abort to child
    if (this.rootController.signal.aborted) {
      child.abort(this.rootController.signal.reason);
    } else {
      const onAbort = () =>
        child.abort(this.rootController.signal.reason ?? "run cancelled");
      this.rootController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    }

    return child;
  }

  /** Cancel a specific child by ID. */
  cancelChild(id: string, reason?: string): void {
    const child = this.children.get(id);
    if (child && !child.signal.aborted) {
      child.abort(reason ?? "task cancelled");
    }
  }

  /** Cancel all children and the root. */
  cancelAll(reason?: string): void {
    for (const [, child] of this.children) {
      if (!child.signal.aborted) {
        child.abort(reason ?? "run cancelled");
      }
    }
    if (!this.rootController.signal.aborted) {
      this.rootController.abort(reason ?? "run cancelled");
    }
  }

  /** Abort the entire batch run. Alias for cancelAll. */
  abort(reason?: string): void {
    this.cancelAll(reason);
  }

  /** Clean up timers. Should be called when the run completes. */
  dispose(): void {
    if (this.wallTimeTimer !== undefined) {
      clearTimeout(this.wallTimeTimer);
      this.wallTimeTimer = undefined;
    }
  }
}
