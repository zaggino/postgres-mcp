import { randomUUID } from 'node:crypto';

interface RunningCall {
  controller: AbortController;
  database: string;
  startedAt: number;
  tool: string;
}

export interface RunningCallInfo {
  call_id: string;
  database: string;
  elapsed_seconds: number;
  tool: string;
}

/** The database-tool calls of one MCP session that have started and not yet settled. */
export class RunningCalls {
  private readonly calls = new Map<string, RunningCall>();

  /** Register a call. The returned signal aborts on the caller's signal or on `cancel(id)`; run `done` when the call settles. */
  start(tool: string, database: string, signal: AbortSignal): { done: () => void; id: string; signal: AbortSignal } {
    const controller = new AbortController();
    let id = randomUUID().slice(0, 8);
    while (this.calls.has(id)) {
      id = randomUUID().slice(0, 8);
    }
    this.calls.set(id, { controller, database, startedAt: Date.now(), tool });
    return {
      id,
      signal: AbortSignal.any([signal, controller.signal]),
      done: () => {
        this.calls.delete(id);
      },
    };
  }

  /** Running calls in start order. */
  list(): RunningCallInfo[] {
    const now = Date.now();
    return [...this.calls].map(([id, call]) => ({
      call_id: id,
      tool: call.tool,
      database: call.database,
      elapsed_seconds: Math.floor((now - call.startedAt) / 1000),
    }));
  }

  /** Abort a running call; returns whether the id was running. */
  cancel(id: string): boolean {
    const call = this.calls.get(id);
    if (!call) {
      return false;
    }
    call.controller.abort();
    return true;
  }
}
