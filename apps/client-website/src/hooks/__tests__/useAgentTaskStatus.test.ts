/**
 * useAgentTaskStatus Hook Tests
 *
 * Tests for the client-side WebSocket hook for real-time agent status (AS-007).
 * Covers AC7.2, AC7.5, AC7.6, AC7.7.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentTaskStatus } from '../useAgentTaskStatus';

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  // Flag to prevent auto-connection after first instance (for testing reconnect failures)
  static preventAutoConnect = false;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Simulate connection opening (unless preventAutoConnect is set)
    if (!MockWebSocket.preventAutoConnect) {
      setTimeout(() => {
        if (this.onopen) {
          this.onopen();
        }
      }, 0);
    }
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  simulateMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  // Manually trigger open (for controlled testing)
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen();
    }
  }
}

// Store original WebSocket
const originalWebSocket = global.WebSocket;

describe('useAgentTaskStatus', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.preventAutoConnect = false;
    // @ts-expect-error - Mocking WebSocket
    global.WebSocket = MockWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    MockWebSocket.preventAutoConnect = false;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('connects to WebSocket on mount (AC7.2)', async () => {
    const { result } = renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: true,
      }),
    );

    // Initial state should be connecting
    expect(result.current.connectionState).toBe('connecting');

    // Advance timers to allow connection (using async version for proper timer handling)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Should be connected
    expect(result.current.connectionState).toBe('connected');

    // Should have subscribed to the task
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws?.sentMessages.some((msg) => msg.includes('subscribe'))).toBe(true);
  });

  it('updates status when receiving WebSocket message (AC7.2)', async () => {
    const { result } = renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: true,
      }),
    );

    // Wait for connection (using async version)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionState).toBe('connected');

    // Simulate receiving a status update
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws?.simulateMessage({
        type: 'task_status_update',
        payload: {
          taskId: 'test-task-id',
          status: {
            taskId: 'test-task-id',
            phase: 'running',
            progress: 50,
            message: 'Processing...',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      });
    });

    // Status should be updated
    expect(result.current.status).not.toBeNull();
    expect(result.current.status?.phase).toBe('running');
    expect(result.current.status?.progress).toBe(50);
  });

  it('shows reconnecting state when connection drops (AC7.5, AC7.6)', async () => {
    const { result } = renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: true,
        maxReconnectAttempts: 3,
        reconnectDelay: 1000,
      }),
    );

    // Wait for connection (using async version)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionState).toBe('connected');

    // Simulate connection close (use async act to ensure state updates complete)
    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws?.simulateClose();
      // Flush any microtasks
      await vi.advanceTimersByTimeAsync(0);
    });

    // Should be reconnecting (may briefly go through 'connecting' if reconnect starts)
    expect(['reconnecting', 'connecting']).toContain(result.current.connectionState);
    expect(result.current.reconnectAttempt).toBeGreaterThanOrEqual(1);
  });

  it('falls back to polling after max reconnect attempts (AC7.7)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: {
            taskId: 'test-task-id',
            phase: 'running',
            progress: 25,
          },
        }),
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: true,
        maxReconnectAttempts: 2,
        reconnectDelay: 100,
        pollingInterval: 5000,
      }),
    );

    // Wait for initial connection
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionState).toBe('connected');

    // Prevent subsequent WebSockets from auto-connecting to simulate persistent failures
    MockWebSocket.preventAutoConnect = true;

    // Simulate repeated connection failures until max attempts exhausted
    // The hook will create new WebSocket instances for each reconnect attempt
    // We need to close each one to trigger the next attempt or fallback to polling

    // Close initial connection and process through all reconnect attempts
    // Each close triggers either a reconnect (if under max) or fallback to polling
    for (let attempt = 0; attempt <= 2; attempt++) {
      await act(async () => {
        // Close the most recent WebSocket
        const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        ws?.simulateClose();
        // Advance time to allow reconnect timers to fire (if any)
        // Use enough time to cover exponential backoff: 100, 200, 400ms
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    // After max attempts (2) exhausted, should fall back to polling
    expect(result.current.isPolling).toBe(true);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('does not connect when disabled', () => {
    renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: false,
      }),
    );

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('cleans up on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useAgentTaskStatus({
        taskId: 'test-task-id',
        enabled: true,
      }),
    );

    // Wait for connection (using async version)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionState).toBe('connected');

    // Unmount the hook
    unmount();

    // WebSocket should be closed
    const ws = MockWebSocket.instances[0];
    expect(ws?.readyState).toBe(MockWebSocket.CLOSED);
  });
});
