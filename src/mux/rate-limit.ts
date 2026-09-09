const defaultSchedule = (
  delayMs: number,
  callback: () => void,
): (() => void) => {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
};

export const publisherToSubscriberBurstBytes = 64 * 1024;

export type ScheduleRateLimit = (
  delayMs: number,
  callback: () => void,
) => () => void;

export interface RateLimitTicket {
  promise: Promise<void>;
  cancel: () => void;
}

export interface PublisherToSubscriberRateLimiter {
  tryConsume: (bytes: number) => boolean;
  wait: (bytes: number) => RateLimitTicket;
}

export interface TokenBucketRateLimiterOptions {
  now?: () => number;
  rateBps: number;
  schedule?: ScheduleRateLimit;
}

/**
 * A FIFO token bucket used by all channels for one published service.
 *
 * Callers retain ownership of the payload while a ticket is pending. The
 * queue therefore contains at most the writes currently blocked by stream
 * backpressure; it does not read ahead from a source or create an
 * application-level payload buffer.
 */
export class TokenBucketRateLimiter
  implements PublisherToSubscriberRateLimiter
{
  private readonly now: () => number;
  private readonly rateBps: number;
  private readonly schedule: ScheduleRateLimit;
  private tokens = publisherToSubscriberBurstBytes;
  private lastRefillAt: number;
  private readonly waiters: Waiter[] = [];
  private cancelPump?: () => void;

  constructor(options: TokenBucketRateLimiterOptions) {
    if (!Number.isSafeInteger(options.rateBps) || options.rateBps <= 0) {
      throw new Error("rateBps must be a positive safe integer");
    }
    this.rateBps = options.rateBps;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.lastRefillAt = this.now();
  }

  wait(bytes: number): RateLimitTicket {
    validateBytes(bytes);

    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: Waiter = {
      bytes,
      reject: (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
      resolve: () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      },
    };
    this.waiters.push(waiter);
    this.pump();

    return {
      promise,
      cancel: () => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        waiter.reject(new Error("Rate-limit wait cancelled"));
        this.pump();
      },
    };
  }

  tryConsume(bytes: number): boolean {
    validateBytes(bytes);
    this.refill();
    // A queued stream write owns the next available tokens. UDP must not
    // jump ahead of that FIFO or turn a shared service budget unfair.
    if (this.waiters.length > 0 || this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }

  private pump(): void {
    this.cancelPump?.();
    this.cancelPump = undefined;
    this.refill();

    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (this.tokens < waiter.bytes) {
        const needed = waiter.bytes - this.tokens;
        const delayMs = Math.max(1, (needed * 1_000) / this.rateBps);
        this.cancelPump = this.schedule(delayMs, () => this.pump());
        return;
      }
      this.waiters.shift();
      this.tokens -= waiter.bytes;
      waiter.resolve();
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    this.tokens = Math.min(
      publisherToSubscriberBurstBytes,
      this.tokens + (elapsedMs * this.rateBps) / 1_000,
    );
  }
}

interface Waiter {
  bytes: number;
  reject: (error: Error) => void;
  resolve: () => void;
}

function validateBytes(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > publisherToSubscriberBurstBytes
  ) {
    throw new Error(
      `bytes must be an integer from 1 through ${publisherToSubscriberBurstBytes}`,
    );
  }
}
