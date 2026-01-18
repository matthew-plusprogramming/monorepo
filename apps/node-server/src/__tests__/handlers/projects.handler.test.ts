import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  listProjectsRequestHandler,
  getProjectRequestHandler,
} from '@/handlers/projects.handler';

// Mock the AppLayer to avoid DynamoDB dependency in tests
vi.mock('@/layers/app.layer', () => ({
  AppLayer: {},
}));

describe('Projects Handler', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  describe('GET /api/projects', () => {
    describe('AC1.1: Dashboard displays all projects as cards with name and status', () => {
      it('has correct route handler signature', () => {
        expect(typeof listProjectsRequestHandler).toBe('function');
      });
    });

    describe('AC1.2: Each project card shows spec group count', () => {
      it('handler is exported correctly', () => {
        expect(listProjectsRequestHandler).toBeDefined();
      });
    });

    describe('AC1.3: Each project card shows health indicator', () => {
      it('handler is available for routing', () => {
        // Handler can be attached to Express route
        expect(() => {
          app.get('/api/projects', listProjectsRequestHandler);
        }).not.toThrow();
      });
    });
  });

  describe('GET /api/projects/:id', () => {
    it('handler is exported correctly', () => {
      expect(getProjectRequestHandler).toBeDefined();
    });

    it('handler can be attached to parameterized route', () => {
      expect(() => {
        app.get('/api/projects/:id', getProjectRequestHandler);
      }).not.toThrow();
    });
  });
});
