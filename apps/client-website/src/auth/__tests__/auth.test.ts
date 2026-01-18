/**
 * Dashboard Authentication Tests (AS-009)
 *
 * These tests validate the dashboard password authentication flow including:
 * - Login form validation
 * - Session management
 * - Rate limiting behavior
 * - Logout flow
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  dashboardLogin,
  dashboardLogout,
  checkDashboardSession,
} from '@/lib/api/dashboardAuth';
import { loginFieldConfigs } from '@/app/login/hooks';

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

const resetMocks = (): void => {
  mockFetch.mockReset();
};

describe('Dashboard Authentication API (AS-009)', () => {
  beforeEach(resetMocks);

  describe('dashboardLogin', () => {
    it('sends password to login endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: 'Login successful' }),
      });

      const result = await dashboardLogin({ password: 'test-password' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/login'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          credentials: 'include',
          body: JSON.stringify({ password: 'test-password' }),
        }),
      );
      expect(result.success).toBe(true);
    });

    it('throws error for invalid password', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid password' }),
        clone: function() { return this; },
      });

      await expect(dashboardLogin({ password: 'wrong' })).rejects.toThrow(
        'Invalid password',
      );
    });

    it('throws error for rate limiting', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          error: 'Too many login attempts. Try again in 5 minutes.',
        }),
        clone: function() { return this; },
      });

      await expect(dashboardLogin({ password: 'test' })).rejects.toThrow(
        'Too many login attempts',
      );
    });
  });

  describe('dashboardLogout', () => {
    it('calls logout endpoint with credentials', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: 'Logged out successfully' }),
      });

      const result = await dashboardLogout();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/logout'),
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('checkDashboardSession', () => {
    it('returns authenticated true for valid session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticated: true }),
      });

      const result = await checkDashboardSession();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/session'),
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
        }),
      );
      expect(result.authenticated).toBe(true);
    });

    it('returns authenticated false for invalid session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await checkDashboardSession();

      expect(result.authenticated).toBe(false);
    });

    it('returns authenticated false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await checkDashboardSession();

      expect(result.authenticated).toBe(false);
    });
  });
});

describe('Login Form Validation (AS-009)', () => {
  it('validates password is required', () => {
    const passwordConfig = loginFieldConfigs.find(
      (c: { id: string }) => c.id === 'password',
    );

    expect(passwordConfig).toBeDefined();
    expect(passwordConfig!.rules.required).toBe('Password is required');
  });

  it('has password field type', () => {
    const passwordConfig = loginFieldConfigs.find(
      (c: { id: string }) => c.id === 'password',
    );

    expect(passwordConfig!.type).toBe('password');
  });
});
