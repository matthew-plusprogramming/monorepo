/**
 * useAgentTaskStatus Hook Tests
 *
 * Tests for the client-side WebSocket hook for real-time agent status (AS-007).
 * Covers AC7.2, AC7.5, AC7.6, AC7.7.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentTaskStatus } from '../useAgentTaskStatus';

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Simulate connection opening
    setTimeout(() => {
      if (this.onopen) {
        this.onopen();
      }
    }, 0);
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
}

// Store original WebSocket
const originalWebSocket = global.WebSocket;

describe('useAgentTaskStatus', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error - Mocking WebSocket
    global.WebSocket = MockWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
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

    // Advance timers to allow connection
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // Should be connected
    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

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

    // Wait for connection
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

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

    // Wait for connection
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    // Simulate connection close
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws?.simulateClose();
    });

    // Should be reconnecting
    expect(result.current.connectionState).toBe('reconnecting');
    expect(result.current.reconnectAttempt).toBe(1);
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
      vi.advanceTimersByTime(10);
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    // Simulate multiple connection failures
    for (let i = 0; i < 3; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        ws?.simulateClose();
      });

      // Advance through reconnection delay with exponential backoff
      await act(async () => {
        vi.advanceTimersByTime(100 * Math.pow(2, i) + 10);
      });
    }

    // Should fall back to polling after max attempts
    await waitFor(() => {
      expect(result.current.isPolling).toBe(true);
    });

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

    // Wait for connection
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    // Unmount the hook
    unmount();

    // WebSocket should be closed
    const ws = MockWebSocket.instances[0];
    expect(ws?.readyState).toBe(MockWebSocket.CLOSED);
  });
});
