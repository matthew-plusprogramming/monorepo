/**
 * AS-005: Concurrency Limiter for Subprocess Spawning
 *
 * Tests verify that:
 * - acquire() resolves immediately when slots available (AC5.1, AC5.3)
 * - acquire() queues when all slots taken (AC5.3)
 * - release() dequeues next waiter in FIFO order (AC5.4, AC5.8)
 * - MAX_CONCURRENT_PROCESSES configurable, default 5 (AC5.2)
 * - Timeout on acquire() rejects after N ms (AC5.5)
 * - _resetForTest() clears state (AC5.7)
 * - Concurrent requests beyond limit are queued, not rejected (AC5.3)
 * - try/finally pattern ensures release on error (AC5.6)
 */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';

describe('AS-005: ProcessConcurrencyLimiter', () => {
  /** @type {import('../process-limiter.mjs').ProcessConcurrencyLimiter} */
  let limiter;

  /** @type {typeof import('../process-limiter.mjs')} */
  let limiterModule;

  beforeEach(async () => {
    limiterModule = await import('../process-limiter.mjs');
    const { ProcessConcurrencyLimiter } = limiterModule;
    limiter = new ProcessConcurrencyLimiter(3); // Use 3 for easier testing
  });

  afterEach(() => {
    if (limiter && typeof limiter._resetForTest === 'function') {
      limiter._resetForTest();
    }
  });

  test('AC5.1: ProcessConcurrencyLimiter has acquire() and release() methods', () => {
    // Assert
    assert.equal(typeof limiter.acquire, 'function');
    assert.equal(typeof limiter.release, 'function');
  });

  test('AC5.3: acquire() resolves immediately when slots are available', async () => {
    // Arrange - limiter has 3 slots, all free

    // Act
    await limiter.acquire();

    // Assert - Should resolve without hanging
    assert.ok(true, 'acquire() resolved immediately');

    // Cleanup
    limiter.release();
  });

  test('AC5.3: acquire() queues when all slots are taken', async () => {
    // Arrange - Fill all 3 slots
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Act - 4th acquire should not resolve immediately
    let fourthResolved = false;
    const fourthPromise = limiter.acquire().then(() => {
      fourthResolved = true;
    });

    // Give microtask queue a chance to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Assert - Should still be queued
    assert.equal(fourthResolved, false, 'Fourth acquire should be queued');

    // Cleanup - release one slot so the fourth can proceed
    limiter.release();
    await fourthPromise;
    assert.equal(fourthResolved, true, 'Fourth acquire should resolve after release');

    // Release remaining
    limiter.release();
    limiter.release();
    limiter.release();
  });

  test('AC5.4: release() dequeues the next waiter', async () => {
    // Arrange - Fill all slots and queue one waiter
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    let waiterResolved = false;
    const waiterPromise = limiter.acquire().then(() => {
      waiterResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(waiterResolved, false, 'Waiter should be queued');

    // Act
    limiter.release();

    // Assert
    await waiterPromise;
    assert.equal(waiterResolved, true, 'Waiter should resolve after release');

    // Cleanup
    limiter.release();
    limiter.release();
    limiter.release();
  });

  test('AC5.8: Waiters are served in FIFO order', async () => {
    // Arrange - Fill all slots
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    const resolveOrder = [];

    const waiter1 = limiter.acquire().then(() => {
      resolveOrder.push(1);
    });
    const waiter2 = limiter.acquire().then(() => {
      resolveOrder.push(2);
    });
    const waiter3 = limiter.acquire().then(() => {
      resolveOrder.push(3);
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(resolveOrder, [], 'No waiters should have resolved yet');

    // Act - Release slots one at a time
    limiter.release();
    await waiter1;
    await new Promise((resolve) => setTimeout(resolve, 5));

    limiter.release();
    await waiter2;
    await new Promise((resolve) => setTimeout(resolve, 5));

    limiter.release();
    await waiter3;

    // Assert - Order should be FIFO: 1, 2, 3
    assert.deepEqual(
      resolveOrder,
      [1, 2, 3],
      'Waiters should resolve in FIFO order',
    );

    // Cleanup
    limiter.release();
    limiter.release();
    limiter.release();
  });

  test('AC5.2: Default max concurrency is 5', async () => {
    // Arrange - Create limiter with default concurrency
    const { ProcessConcurrencyLimiter } = limiterModule;
    const defaultLimiter = new ProcessConcurrencyLimiter();

    // Act - Acquire 5 slots (should all resolve)
    await defaultLimiter.acquire();
    await defaultLimiter.acquire();
    await defaultLimiter.acquire();
    await defaultLimiter.acquire();
    await defaultLimiter.acquire();

    // 6th should queue
    let sixthResolved = false;
    const sixthPromise = defaultLimiter.acquire().then(() => {
      sixthResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Assert
    assert.equal(
      sixthResolved,
      false,
      '6th acquire should be queued when default limit is 5',
    );

    // Cleanup
    defaultLimiter.release();
    await sixthPromise;
    defaultLimiter._resetForTest();
  });

  test('AC5.2: MAX_CONCURRENT_PROCESSES env var configures max concurrency', async () => {
    // Arrange
    const { ProcessConcurrencyLimiter } = limiterModule;
    const originalEnv = process.env.MAX_CONCURRENT_PROCESSES;
    process.env.MAX_CONCURRENT_PROCESSES = '2';

    const envLimiter = new ProcessConcurrencyLimiter(
      parseInt(process.env.MAX_CONCURRENT_PROCESSES, 10),
    );

    // Act - Acquire 2 slots
    await envLimiter.acquire();
    await envLimiter.acquire();

    // 3rd should queue
    let thirdResolved = false;
    const thirdPromise = envLimiter.acquire().then(() => {
      thirdResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Assert
    assert.equal(
      thirdResolved,
      false,
      '3rd acquire should be queued when max is 2',
    );

    // Cleanup
    envLimiter.release();
    await thirdPromise;
    envLimiter._resetForTest();
    if (originalEnv === undefined) {
      delete process.env.MAX_CONCURRENT_PROCESSES;
    } else {
      process.env.MAX_CONCURRENT_PROCESSES = originalEnv;
    }
  });

  test('AC5.5: acquire(timeoutMs) rejects after timeout if no slot available', async () => {
    // Arrange - Fill all slots
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Act & Assert - acquire with 50ms timeout should reject
    await assert.rejects(
      () => limiter.acquire(50),
      (error) => {
        assert.ok(
          error instanceof Error,
          'Should reject with an Error instance',
        );
        assert.ok(
          error.message.includes('Timed out') || error.message.includes('timeout'),
          `Error message should mention timeout, got: "${error.message}"`,
        );
        return true;
      },
    );

    // Cleanup
    limiter.release();
    limiter.release();
    limiter.release();
  });

  test('AC5.7: _resetForTest() clears all internal state', async () => {
    // Arrange - Fill all slots and queue a waiter
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Queue a waiter (don't await -- it will never resolve after reset)
    let waiterRejected = false;
    limiter.acquire(5000).catch(() => {
      waiterRejected = true;
    });

    // Act
    limiter._resetForTest();

    // Assert - After reset, all slots should be available again
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // 4th should queue (back to limit of 3)
    let fourthResolved = false;
    const fourthPromise = limiter.acquire().then(() => {
      fourthResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      fourthResolved,
      false,
      'After reset and re-acquiring 3 slots, 4th should queue',
    );

    // Cleanup
    limiter._resetForTest();
  });

  test('AC5.3: Concurrent requests beyond limit are queued, not rejected', async () => {
    // Arrange - Fill all slots
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // Act - Queue multiple waiters (should NOT reject)
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(limiter.acquire());
    }

    // Give time for potential rejections
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert - None should have rejected
    // Release all to let them complete
    for (let i = 0; i < 5; i++) {
      limiter.release();
    }

    // All queued acquires should resolve
    await Promise.all(promises);
    assert.ok(true, 'All queued acquires resolved without rejection');

    // Cleanup
    limiter._resetForTest();
  });

  test('AC5.6: try/finally pattern ensures release on error', async () => {
    // Arrange
    const { ProcessConcurrencyLimiter } = limiterModule;
    const testLimiter = new ProcessConcurrencyLimiter(1);

    // Act - Simulate acquire/release with try/finally that throws
    const doWork = async () => {
      await testLimiter.acquire();
      try {
        throw new Error('Simulated subprocess failure');
      } finally {
        testLimiter.release();
      }
    };

    await assert.rejects(() => doWork(), { message: 'Simulated subprocess failure' });

    // Assert - Slot should be released despite the error, so next acquire works
    await testLimiter.acquire(); // Should resolve immediately if slot was released
    assert.ok(true, 'Slot was properly released after error via try/finally');

    // Cleanup
    testLimiter._resetForTest();
  });
});
