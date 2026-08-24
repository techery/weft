/** FIFO counting semaphore. The global limiter lives inside every step, so promises
 * and thunks schedule identically; per-provider limiters stack on top of it. */
export class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError(`invalid capacity: ${capacity}`);
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.available > 0) {
      this.available--;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.available--;
        resolve(this.releaser());
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(grant);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  async with<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available++;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

/** Run tasks with a concurrency cap, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  // NaN would coerce to ZERO workers and return an empty-but-successful result;
  // a non-finite limit runs serially instead — slow beats silently incomplete.
  const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
