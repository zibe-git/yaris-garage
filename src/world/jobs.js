// Time-sliced work: generators that yield often, resumed each frame until the frame's budget is spent, so building
// terrain, road and forest never blocks the main thread for long (no long tasks → good INP on phones).
export class Jobs {
  constructor() {
    this.queue = [];
  }

  add(gen, priority = 0) {
    const job = { gen, priority, done: false };
    this.queue.push(job);
    return job;
  }

  get pending() {
    return this.queue.length;
  }

  /** Advance jobs (lowest priority value first) for at most `ms` milliseconds. */
  run(ms) {
    if (!this.queue.length) return;
    const end = performance.now() + ms;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.queue.length && performance.now() < end) {
      const job = this.queue[0];
      if (job.cancelled || job.gen.next().done) {
        job.done = true;
        this.queue.shift();
      }
    }
  }

  /** Run until everything queued is done, yielding to the event loop every `slice` ms (loading screens). */
  async drain(slice = 12, onProgress) {
    const total = this.queue.length || 1;
    while (this.queue.length) {
      this.run(slice);
      onProgress?.(1 - this.queue.length / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  clear() {
    for (const j of this.queue) j.cancelled = true;
    this.queue.length = 0;
  }
}
