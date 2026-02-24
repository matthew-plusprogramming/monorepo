// Note: Environment variables are loaded externally:
// - Local dev: via dotenvx-run in npm scripts (see package.json)
// - Lambda: via Lambda environment configuration (set at deploy time)
// Do NOT import @dotenvx/dotenvx/config here - it breaks Lambda runtime

import { createServer } from 'node:http';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import { Effect } from 'effect';
import express from 'express';
import { prettifyError, ZodError } from 'zod';

import {
  dispatchAgentTaskRequestHandler,
  getAgentTaskRequestHandler,
} from '@/handlers/agentDispatch.handler';
import {
  getAgentTaskLogsRequestHandler,
  getAgentTaskStatusRequestHandler,
  updateAgentTaskStatusRequestHandler,
} from '@/handlers/agentTaskStatus.handler';
import { dashboardLoginRequestHandler } from '@/handlers/dashboardLogin.handler';
import { dashboardLogoutRequestHandler } from '@/handlers/dashboardLogout.handler';
import { getUserRequestHandler } from '@/handlers/getUser.handler';
import { getGitHubIssuesRequestHandler } from '@/handlers/githubIssues.handler';
import { getGitHubPRsRequestHandler } from '@/handlers/githubPRs.handler';
import { healthRequestHandler } from '@/handlers/health.handler';
import { heartbeatRequestHandler } from '@/handlers/heartbeat.handler';
import { loginRequestHandler } from '@/handlers/login.handler';
import {
  getProjectRequestHandler,
  listProjectsRequestHandler,
} from '@/handlers/projects.handler';
import { registerRequestHandler } from '@/handlers/register.handler';
import {
  getSpecGroupRequestHandler,
  transitionStateRequestHandler,
  updateFlagsRequestHandler,
} from '@/handlers/specGroups.handler';
import {
  csrfTokenMiddleware,
  csrfValidationMiddleware,
} from '@/middleware/csrf.middleware';
import { dashboardRateLimitingMiddlewareRequestHandler } from '@/middleware/dashboardRateLimiting.middleware';
import { dashboardSessionMiddlewareRequestHandler } from '@/middleware/dashboardSession.middleware';
import { ipRateLimitingMiddlewareRequestHandler } from '@/middleware/ipRateLimiting.middleware';
import { isAuthenticatedMiddlewareRequestHandler } from '@/middleware/isAuthenticated.middleware';
import { jsonErrorMiddleware } from '@/middleware/jsonError.middleware';
import {
  loggingErrorMiddleware,
  loggingMiddleware,
} from '@/middleware/logging.middleware';
import { validateRouteParam } from '@/middleware/validateRouteParam.middleware';
import { webhookAuthMiddleware } from '@/middleware/webhookAuth.middleware';
import { initializeWebSocket } from '@/services/websocket.service';
import { EnvironmentSchema } from '@/types/environment';

try {
  EnvironmentSchema.parse(process.env);
} catch (error) {
  if (error instanceof ZodError) {
    console.error('Environment variables validation failed');
    console.error(prettifyError(error));
    process.exit(1);
  } else {
    throw error;
  }
}

const app = express();

// Configure CORS with explicit allowed origins (Security fix: restrict permissive CORS)
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(',').map((origin) => origin.trim())
  : ['http://localhost:3000']; // Default to localhost for development

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true, // Required for cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  }),
);
app.use(cookieParser());
app.use(loggingMiddleware);
app.use(ipRateLimitingMiddlewareRequestHandler);
// AC2.6: Limit JSON body size to prevent oversized payloads reaching any endpoint
app.use(express.json({ limit: '1mb' }));
app.use(jsonErrorMiddleware);

// CSRF protection: Set token cookie and validate on state-changing requests
app.use(csrfTokenMiddleware);
app.use(csrfValidationMiddleware);

// Health endpoint - no authentication required (AC11.7)
app.get('/api/health', healthRequestHandler);

app.get(
  '/heartbeat',
  isAuthenticatedMiddlewareRequestHandler,
  heartbeatRequestHandler,
);
app.post('/register', registerRequestHandler);
app.post('/login', loginRequestHandler);
// AC4.3: Route parameter validation for :identifier
app.get(
  '/user/:identifier',
  validateRouteParam('identifier'),
  getUserRequestHandler,
);

// Dashboard authentication endpoints (AS-009)
app.post(
  '/api/auth/login',
  dashboardRateLimitingMiddlewareRequestHandler,
  dashboardLoginRequestHandler,
);
app.post('/api/auth/logout', dashboardLogoutRequestHandler);
app.get(
  '/api/auth/session',
  dashboardSessionMiddlewareRequestHandler,
  (req, res) => {
    res.json({ authenticated: true });
  },
);

// Projects endpoints (AS-001)
app.get(
  '/api/projects',
  dashboardSessionMiddlewareRequestHandler,
  listProjectsRequestHandler,
);
// AC4.3: All :id routes have validateRouteParam('id') for defense-in-depth
app.get(
  '/api/projects/:id',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getProjectRequestHandler,
);

// Spec Groups endpoints (AS-003)
app.get(
  '/api/spec-groups/:id',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getSpecGroupRequestHandler,
);
app.post(
  '/api/spec-groups/:id/transition',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  transitionStateRequestHandler,
);
app.put(
  '/api/spec-groups/:id/flags',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  updateFlagsRequestHandler,
);

// GitHub Issues endpoint (AS-004)
app.get(
  '/api/projects/:id/github/issues',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getGitHubIssuesRequestHandler,
);

// GitHub Pull Requests endpoint (AS-005)
app.get(
  '/api/projects/:id/github/pulls',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getGitHubPRsRequestHandler,
);

// Agent Dispatch endpoints (AS-006)
app.post(
  '/api/spec-groups/:id/dispatch',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  dispatchAgentTaskRequestHandler,
);
app.get(
  '/api/agent-tasks/:id',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getAgentTaskRequestHandler,
);

// Agent Task Status endpoints (AS-007)
// POST /api/agent-tasks/:id/status - Update task status (agent callback, webhook auth required)
// Security fix: Added HMAC webhook authentication to prevent unauthorized status updates
app.post(
  '/api/agent-tasks/:id/status',
  validateRouteParam('id'),
  webhookAuthMiddleware,
  updateAgentTaskStatusRequestHandler,
);
// GET /api/agent-tasks/:id/status - Get task status (polling fallback, AC7.7)
app.get(
  '/api/agent-tasks/:id/status',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getAgentTaskStatusRequestHandler,
);
// GET /api/agent-tasks/:id/logs - Get task logs (AC7.4)
app.get(
  '/api/agent-tasks/:id/logs',
  validateRouteParam('id'),
  dashboardSessionMiddlewareRequestHandler,
  getAgentTaskLogsRequestHandler,
);

// Error logging middleware - captures errors for structured logging (AC12.7)
app.use(loggingErrorMiddleware);

// Create HTTP server and initialize WebSocket (AS-007)
const server = createServer(app);

// Initialize WebSocket server for real-time agent status updates (AC7.2)
Effect.runSync(initializeWebSocket(server, { path: '/ws/agent-status' }));

server.listen(process.env.PORT, () => {
  console.log(`Server listening on port ${process.env.PORT}`);
  console.log(
    `WebSocket available at ws://localhost:${process.env.PORT}/ws/agent-status`,
  );
});

export { app, server };
