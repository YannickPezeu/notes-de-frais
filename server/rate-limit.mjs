// Fenêtre fixe par clé, en mémoire : suffisant pour un seul pod.
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) {
      b = { start: now, count: 0 };
      this.buckets.set(key, b);
      if (this.buckets.size > 10_000) this.prune(now);
    }
    if (b.count >= this.limit) return false;
    b.count++;
    return true;
  }

  prune(now) {
    for (const [k, b] of this.buckets) if (now - b.start >= this.windowMs) this.buckets.delete(k);
  }
}
