export const DESKTOP_BULK_DOWNLOAD_REQUESTS_PER_MINUTE = 30;
export const DESKTOP_BULK_DOWNLOAD_CONCURRENCY = 3;

export class DesktopRequestRateLimiter {
  constructor({
    requestsPerMinute = DESKTOP_BULK_DOWNLOAD_REQUESTS_PER_MINUTE,
    concurrency = DESKTOP_BULK_DOWNLOAD_CONCURRENCY,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer)
  } = {}) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 600) {
      throw new TypeError("requestsPerMinute must be an integer between 1 and 600");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new TypeError("concurrency must be an integer between 1 and 16");
    }
    this.intervalMs = Math.ceil(60_000 / requestsPerMinute);
    this.concurrency = concurrency;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queue = [];
    this.active = 0;
    this.nextStartAt = 0;
    this.timer = null;
    this.disposed = false;
  }

  schedule(task) {
    if (typeof task !== "function") return Promise.reject(new TypeError("rate-limited task must be a function"));
    if (this.disposed) return Promise.reject(new Error("rate limiter is disposed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.disposed || this.timer !== null || this.active >= this.concurrency || this.queue.length === 0) return;
    const delay = Math.max(0, this.nextStartAt - this.now());
    if (delay > 0) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.pump();
      }, delay);
      return;
    }
    const job = this.queue.shift();
    this.active += 1;
    this.nextStartAt = Math.max(this.nextStartAt, this.now()) + this.intervalMs;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
    this.pump();
  }

  dispose(message = "rate limiter is disposed") {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const error = new Error(message);
    for (const job of this.queue.splice(0)) job.reject(error);
  }
}

export function createDesktopBulkDownloadRateLimiter(options = {}) {
  return new DesktopRequestRateLimiter({
    requestsPerMinute: DESKTOP_BULK_DOWNLOAD_REQUESTS_PER_MINUTE,
    concurrency: DESKTOP_BULK_DOWNLOAD_CONCURRENCY,
    ...options
  });
}
