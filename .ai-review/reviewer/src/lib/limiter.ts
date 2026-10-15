/**
 * Runs model calls with a concurrency cap, a minimum gap between starts (free-tier
 * requests-per-minute limits) and a hard total budget (free-tier requests-per-day limits).
 */
export class CallBudget {
  private active = 0;
  private lastStart = 0;
  private queue: (() => void)[] = [];
  used = 0;

  constructor(
    readonly max: number,
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  remaining() {
    return this.max - this.used;
  }

  /** Give back calls reserved but not used (a tool loop that finished early). */
  refund(n: number) {
    this.used = Math.max(0, this.used - Math.max(0, n));
  }

  /** Reserve n calls up front; returns false if the budget cannot cover them. */
  reserve(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async acquire() {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + this.minIntervalMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
