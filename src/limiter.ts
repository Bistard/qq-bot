export interface IRateLimiter {
  allow(key: string): boolean
  remainingMs(key: string): number
}

export class RateLimiter implements IRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(private limit: number, private windowMs: number) {}

  allow(key: string): boolean {
    if (!this.limit || this.limit <= 0) return true
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { count: 0, resetAt: now + this.windowMs }
    if (now > bucket.resetAt) {
      bucket.count = 0
      bucket.resetAt = now + this.windowMs
    }
    if (bucket.count >= this.limit) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.count += 1
    this.buckets.set(key, bucket)
    return true
  }

  remainingMs(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return 0
    return Math.max(bucket.resetAt - Date.now(), 0)
  }
}
