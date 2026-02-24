/**
 * Process Concurrency Limiter (AS-005)
 *
 * Bounds concurrent subprocess spawning with acquire()/release() semaphore methods.
 * Waiters are queued in FIFO order. A timeout parameter on acquire() prevents deadlocks.
 */

/**
 * AC5.1: ProcessConcurrencyLimiter class with acquire(), release(), _resetForTest() methods.
 * AC5.2: Default max concurrency is 5, configurable via MAX_CONCURRENT_PROCESSES env var.
 */
export class ProcessConcurrencyLimiter {
  /** @type {number} */
  #active = 0;

  /** @type {number} */
  #maxConcurrency;

  /** @type {Array<{ resolve: () => void; reject: (e: Error) => void }>} */
  #queue = [];

  /**
   * @param {number} [maxConcurrency] - Maximum concurrent processes. Defaults to
   *   MAX_CONCURRENT_PROCESSES env var or 5.
   */
  constructor(maxConcurrency) {
    this.#maxConcurrency =
      maxConcurrency ??
      parseInt(process.env.MAX_CONCURRENT_PROCESSES ?? '5', 10);

    if (isNaN(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      this.#maxConcurrency = 5;
    }
  }

  /**
   * AC5.3: Acquires a slot. Returns a Promise that resolves when a slot is available.
   * AC5.5: If timeoutMs is provided, rejects after that duration if no slot is available.
   * AC5.8: Waiters are queued in FIFO order.
   *
   * @param {number} [timeoutMs] - Optional timeout in milliseconds
   * @returns {Promise<void>}
   */
  async acquire(timeoutMs) {
    if (this.#active < this.#maxConcurrency) {
      this.#active++;
      return;
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.#queue.push(entry);

      if (timeoutMs !== undefined && timeoutMs > 0) {
        const timer = setTimeout(() => {
          const idx = this.#queue.indexOf(entry);
          if (idx !== -1) {
            this.#queue.splice(idx, 1);
            reject(
              new Error(
                `Timed out waiting for process slot after ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);

        // Store original resolve to clear timer on success
        const originalResolve = entry.resolve;
        entry.resolve = () => {
          clearTimeout(timer);
          originalResolve();
        };
      }
    });
  }

  /**
   * AC5.4: Frees a slot and dequeues the next waiter in FIFO order.
   */
  release() {
    const next = this.#queue.shift(); // FIFO ordering (AC5.8)
    if (next) {
      next.resolve();
    } else {
      this.#active = Math.max(0, this.#active - 1);
    }
  }

  /**
   * AC5.7: Clears internal state for test isolation.
   */
  _resetForTest() {
    this.#active = 0;
    for (const entry of this.#queue) {
      entry.reject(new Error('Reset'));
    }
    this.#queue = [];
  }

  /**
   * Returns current active count (for testing/debugging).
   * @returns {number}
   */
  get activeCount() {
    return this.#active;
  }

  /**
   * Returns current queue length (for testing/debugging).
   * @returns {number}
   */
  get queueLength() {
    return this.#queue.length;
  }
}

// Default singleton instance
export const processLimiter = new ProcessConcurrencyLimiter();
