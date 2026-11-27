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
  #next = 0;

  /** Run `fn` as a registered call. Its signal aborts on the caller's signal or on `cancel(id)`; the entry is removed when `fn` settles. */
  async track<T>(
    tool: string,
    database: string,
    signal: AbortSignal,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    this.#next += 1;
    const id = String(this.#next);
    this.calls.set(id, { controller, database, startedAt: Date.now(), tool });
    try {
      return await fn(AbortSignal.any([signal, controller.signal]));
    } finally {
      this.calls.delete(id);
    }
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
