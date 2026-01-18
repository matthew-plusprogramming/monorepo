# AI-Native Engineering Dashboard Backend API

This document provides comprehensive documentation for the AI-Native Engineering Dashboard backend API.

## Table of Contents

- [Overview](#overview)
- [Base URL](#base-url)
- [Security](#security)
  - [CSRF Protection](#csrf-protection)
  - [Session Authentication](#session-authentication)
  - [Webhook Authentication](#webhook-authentication)
  - [CORS Configuration](#cors-configuration)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
  - [Health](#health)
  - [Authentication](#authentication)
  - [Projects](#projects)
  - [Spec Groups](#spec-groups)
  - [GitHub Integration](#github-integration)
  - [Agent Tasks](#agent-tasks)
- [WebSocket API](#websocket-api)
- [Error Handling](#error-handling)

---

## Overview

The AI-Native Engineering Dashboard backend is a Node.js/Express server that provides REST API endpoints and WebSocket connections for managing engineering projects, spec groups, GitHub integrations, and AI agent task dispatching.

The server is built with:
- **Express 5.x** - Web framework
- **Effect** - Functional programming library for error handling
- **Zod** - Runtime type validation
- **WebSocket (ws)** - Real-time communication
- **AWS DynamoDB** - Data persistence
- **AWS EventBridge** - Event dispatching

---

## Base URL

```
Development: http://localhost:{PORT}
Production: Configured via deployment
```

The `PORT` is configured via the `PORT` environment variable.

---

## Security

### CSRF Protection

The API implements the **double-submit cookie pattern** for CSRF protection.

#### How it works:

1. On any `GET` request (or if no token exists), the server sets a CSRF token cookie:
   - Cookie name: `csrf_token`
   - Cookie options: `httpOnly: false`, `sameSite: strict`, `secure: true` (in production)
   - Max age: 24 hours

2. For state-changing requests (`POST`, `PUT`, `DELETE`), the client must include the token in the `X-CSRF-Token` header.

3. The server validates that the header token matches the cookie token using constant-time comparison.

#### Client Implementation:

```javascript
// Read the CSRF token from cookies
const csrfToken = document.cookie
  .split('; ')
  .find(row => row.startsWith('csrf_token='))
  ?.split('=')[1];

// Include in state-changing requests
fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken
  },
  credentials: 'include',
  body: JSON.stringify({ password: '...' })
});
```

#### Error Responses:

| Status | Error | Description |
|--------|-------|-------------|
| 403 | `CSRF token missing from cookie` | No CSRF cookie present |
| 403 | `CSRF token missing from header` | `X-CSRF-Token` header not provided |
| 403 | `CSRF token mismatch` | Header and cookie tokens do not match |

---

### Session Authentication

Most API endpoints require session authentication via a signed cookie.

#### Session Token Format:

```
{timestamp}:{signature}
```

Where:
- `timestamp` - Unix timestamp in milliseconds when the session was created
- `signature` - HMAC-SHA256 of the timestamp using `SESSION_SECRET`

#### Cookie Details:

- Cookie name: `dashboard_session`
- `httpOnly: true`
- `sameSite: strict`
- `secure: true` (in production)
- Max age: Configurable via `SESSION_EXPIRY_HOURS` (default: 24 hours)

#### Endpoints Requiring Session:

All endpoints except:
- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/agent-tasks/:id/status` (uses webhook auth instead)

---

### Webhook Authentication

The `POST /api/agent-tasks/:id/status` endpoint uses HMAC-SHA256 webhook authentication for agent callbacks.

#### Signature Format:

```
X-Webhook-Signature: {timestamp}:{signature}
```

Where:
- `timestamp` - Unix timestamp in milliseconds
- `signature` - HMAC-SHA256 of `{timestamp}:{request_body}` using `WEBHOOK_SECRET`

#### Validation Rules:

1. Signature must not be older than 5 minutes (replay protection)
2. Signature must not be from more than 1 minute in the future (clock skew tolerance)
3. Signature must match the expected HMAC

#### Creating a Webhook Signature (for agents):

```javascript
const crypto = require('crypto');

function createWebhookSignature(body, secret) {
  const timestamp = Date.now().toString();
  const payload = `${timestamp}:${body}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `${timestamp}:${signature}`;
}

// Usage
const body = JSON.stringify({ phase: 'running', progress: 50 });
const signature = createWebhookSignature(body, process.env.WEBHOOK_SECRET);

fetch('/api/agent-tasks/{taskId}/status', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': signature
  },
  body: body
});
```

---

### CORS Configuration

CORS is configured with explicit allowed origins.

#### Configuration:

- Allowed origins: Set via `ALLOWED_ORIGINS` environment variable (comma-separated)
- Default (development): `http://localhost:3000`
- Credentials: Enabled (required for cookies)
- Allowed methods: `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`
- Allowed headers: `Content-Type`, `Authorization`, `X-CSRF-Token`

Server-to-server requests (no `Origin` header) are allowed.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Yes | - | Server port number |
| `AWS_ACCESS_KEY_ID` | Yes | - | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | - | AWS secret key |
| `AWS_REGION` | Yes | - | AWS region |
| `JWT_SECRET` | Yes | - | Secret for JWT signing |
| `PEPPER` | Yes | - | Password hashing pepper |
| `PASSWORD_HASH` | Yes | - | bcrypt hash of dashboard password |
| `SESSION_SECRET` | Yes | - | Secret for session token signing |
| `WEBHOOK_SECRET` | Yes | - | Secret for webhook HMAC signing |
| `SESSION_EXPIRY_HOURS` | No | `24` | Session duration in hours |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed CORS origins |
| `APP_ENV` | No | `development` | Environment (`development`/`production`) |
| `APP_VERSION` | No | `0.0.0` | Application version |
| `DEBUG` | No | - | Enable debug logging when set to `true` |

---

## API Endpoints

### Health

#### GET /api/health

Health check endpoint. No authentication required.

**Response (200 OK):**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "version": "0.0.1",
  "components": {
    "dynamodb": {
      "status": "healthy",
      "latencyMs": 45
    }
  }
}
```

**Status Values:**

| Status | Description |
|--------|-------------|
| `healthy` | All components operational |
| `degraded` | Some components have issues but service is functional |
| `unhealthy` | Critical components are down |

---

### Authentication

#### POST /api/auth/login

Authenticate with the dashboard password.

**Rate Limiting:** This endpoint has additional rate limiting to prevent brute force attacks.

**Request Body:**

```json
{
  "password": "string"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Login successful"
}
```

Sets the `dashboard_session` cookie on success.

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Validation error | Invalid request body |
| 401 | `Invalid password` | Password does not match |
| 500 | Internal server error | Server configuration error |

---

#### POST /api/auth/logout

End the current session.

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

Clears the `dashboard_session` cookie.

---

#### GET /api/auth/session

Verify the current session is valid.

**Authentication:** Required (session cookie)

**Response (200 OK):**

```json
{
  "authenticated": true
}
```

**Error Responses:**

| Status | Description |
|--------|-------------|
| 401 | Session invalid or expired |

---

### Projects

#### GET /api/projects

List all projects with spec group counts and health indicators.

**Authentication:** Required (session cookie)

**Response (200 OK):**

```json
{
  "projects": [
    {
      "id": "proj-123",
      "name": "Project Name",
      "status": "active",
      "specGroupCount": 5,
      "health": "healthy",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

---

#### GET /api/projects/:id

Get a specific project by ID.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Project ID |

**Response (200 OK):**

```json
{
  "id": "proj-123",
  "name": "Project Name",
  "status": "active",
  "specGroupCount": 5,
  "health": "healthy",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `Project with id {id} not found` | Project does not exist |

---

### Spec Groups

#### GET /api/spec-groups/:id

Get a spec group by ID with state display info and available transitions.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Spec Group ID |

**Response (200 OK):**

```json
{
  "specGroup": {
    "id": "sg-123",
    "name": "Feature Spec",
    "state": "DRAFT",
    "sectionsCompleted": false,
    "allGatesPassed": false,
    "prMerged": false,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  },
  "stateDisplay": {
    "label": "Draft",
    "color": "gray"
  },
  "availableTransitions": [
    {
      "toState": "REVIEWED",
      "description": "Mark as reviewed",
      "enabled": true
    },
    {
      "toState": "APPROVED",
      "description": "Approve spec",
      "enabled": false,
      "disabledReason": "Must be reviewed first"
    }
  ]
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `Spec group with id {id} not found` | Spec group does not exist |

---

#### POST /api/spec-groups/:id/transition

Transition a spec group to a new state.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Spec Group ID |

**Request Body:**

```json
{
  "toState": "REVIEWED",
  "reason": "Optional reason for transition"
}
```

**Valid States:**

- `DRAFT`
- `REVIEWED`
- `APPROVED`
- `IN_PROGRESS`
- `CONVERGED`
- `MERGED`

**Response (200 OK):**

Returns the same structure as `GET /api/spec-groups/:id`.

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Validation error | Invalid request body |
| 404 | `Spec group with id {id} not found` | Spec group does not exist |
| 409 | Conflict | Concurrent modification detected |
| 422 | Invalid state transition | Transition not allowed from current state |

---

#### PUT /api/spec-groups/:id/flags

Update spec group flags.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Spec Group ID |

**Request Body:**

```json
{
  "sectionsCompleted": true,
  "allGatesPassed": false,
  "prMerged": false
}
```

All fields are optional. Only provided fields will be updated.

**Response (200 OK):**

Returns the same structure as `GET /api/spec-groups/:id`.

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Validation error | Invalid request body |
| 404 | `Spec group with id {id} not found` | Spec group does not exist |

---

### GitHub Integration

#### GET /api/projects/:id/github/issues

Get GitHub issues linked to a project.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Project ID |

**Response (200 OK):**

```json
{
  "issues": [
    {
      "id": 12345,
      "number": 42,
      "title": "Issue Title",
      "state": "open",
      "htmlUrl": "https://github.com/owner/repo/issues/42",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "repoFullName": "owner/repo"
}
```

**Issue States:**

- `open` - Open issue (green badge)
- `closed` - Closed issue (gray badge)
- `in_progress` - In progress (blue badge)

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `No linked repository` | Project has no GitHub repository configured |
| 401 | `GitHub authentication failed` | GitHub token invalid or expired |
| 404 | `Project with id {id} not found` | Project does not exist |
| 502 | `GitHub API error` | Failed to communicate with GitHub |

---

#### GET /api/projects/:id/github/pulls

Get GitHub pull requests linked to a project.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Project ID |

**Response (200 OK):**

```json
{
  "pullRequests": [
    {
      "id": 12345,
      "number": 42,
      "title": "PR Title",
      "state": "open",
      "draft": false,
      "htmlUrl": "https://github.com/owner/repo/pull/42",
      "ciStatus": "passing",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "repoFullName": "owner/repo"
}
```

**PR States:**

- `open` - Open PR (green badge)
- `merged` - Merged PR (purple badge)
- `closed` - Closed PR (red badge)
- `draft` - Draft PR (gray badge)

**CI Status Values:**

- `passing` - All checks passed (green check)
- `failing` - Some checks failed (red X)
- `pending` - Checks in progress (yellow dot)

**Error Responses:**

Same as GitHub Issues endpoint.

---

### Agent Tasks

#### POST /api/spec-groups/:id/dispatch

Dispatch an agent task for a spec group.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Spec Group ID |

**Request Body:**

```json
{
  "action": "implement"
}
```

**Valid Actions:**

- `implement` - Dispatch implementation agent
- `test` - Dispatch test writing agent

**Response (201 Created):**

```json
{
  "task": {
    "id": "task-123",
    "specGroupId": "sg-123",
    "action": "implement",
    "status": "DISPATCHED",
    "webhookUrl": "https://agent-endpoint.example.com",
    "context": {
      "specGroupId": "sg-123",
      "specGroupName": "Feature Spec",
      "triggeredBy": "system",
      "triggeredAt": "2024-01-15T10:30:00.000Z"
    },
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  },
  "message": "Implementation task dispatched successfully"
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Validation error | Invalid action type |
| 404 | `Spec group with id {id} not found` | Spec group does not exist |
| 502 | `Webhook dispatch failed` | Failed to dispatch to agent endpoint (retryable) |
| 503 | `Webhook not configured` | No webhook URL configured |
| 504 | `Webhook timeout` | Agent endpoint timed out (retryable) |

---

#### GET /api/agent-tasks/:id

Get an agent task by ID.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent Task ID |

**Response (200 OK):**

```json
{
  "task": {
    "id": "task-123",
    "specGroupId": "sg-123",
    "action": "implement",
    "status": "RUNNING",
    "webhookUrl": "https://agent-endpoint.example.com",
    "context": {
      "specGroupId": "sg-123",
      "specGroupName": "Feature Spec",
      "triggeredBy": "system",
      "triggeredAt": "2024-01-15T10:30:00.000Z"
    },
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `Agent task with id {id} not found` | Task does not exist |

---

#### POST /api/agent-tasks/:id/status

Update agent task status (webhook callback from agents).

**Authentication:** Required (webhook signature - see [Webhook Authentication](#webhook-authentication))

**Note:** This endpoint does NOT require session authentication. It uses HMAC webhook authentication for agent callbacks.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent Task ID |

**Request Body:**

```json
{
  "phase": "running",
  "progress": 50,
  "message": "Processing files...",
  "logEntry": {
    "level": "info",
    "message": "Started file processing",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

**Phase Values:**

- `pending` - Task waiting to start
- `running` - Task in progress
- `completed` - Task finished successfully
- `failed` - Task failed
- `cancelled` - Task was cancelled

**Response (200 OK):**

```json
{
  "success": true,
  "status": {
    "taskId": "task-123",
    "phase": "running",
    "progress": 50,
    "message": "Processing files...",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

Updates are broadcast to WebSocket subscribers in real-time.

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Validation error | Invalid request body |
| 401 | `Missing webhook signature` | `X-Webhook-Signature` header not provided |
| 401 | `Invalid webhook signature` | Signature validation failed |
| 404 | `Agent task with id {id} not found` | Task does not exist |

---

#### GET /api/agent-tasks/:id/status

Get current agent task status (polling fallback).

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent Task ID |

**Response (200 OK):**

```json
{
  "status": {
    "taskId": "task-123",
    "phase": "running",
    "progress": 50,
    "message": "Processing files...",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

Returns `{ "status": null }` if no real-time status is available.

---

#### GET /api/agent-tasks/:id/logs

Get agent task logs.

**Authentication:** Required (session cookie)

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent Task ID |

**Response (200 OK):**

```json
{
  "taskId": "task-123",
  "logs": [
    {
      "level": "info",
      "message": "Task started",
      "timestamp": "2024-01-15T10:30:00.000Z"
    },
    {
      "level": "info",
      "message": "Processing file 1/10",
      "timestamp": "2024-01-15T10:30:05.000Z"
    }
  ]
}
```

**Log Levels:**

- `debug`
- `info`
- `warn`
- `error`

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `Agent task with id {id} not found` | Task does not exist |

---

## WebSocket API

### Connection

**Endpoint:** `ws://localhost:{PORT}/ws/agent-status`

**Authentication:** Session cookie (`dashboard_session`) is validated on connection.

### Connection Flow:

1. Client initiates WebSocket connection with session cookie
2. Server validates session token
3. If valid, sends `CONNECTION_STATUS` message
4. If invalid, closes connection with code `4001` (Unauthorized)

### Message Types

All messages follow this format:

```json
{
  "type": "MESSAGE_TYPE",
  "payload": {},
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### Client Messages

**SUBSCRIBE**

Subscribe to updates for a specific task.

```json
{
  "type": "SUBSCRIBE",
  "payload": {
    "taskId": "task-123"
  }
}
```

**UNSUBSCRIBE**

Unsubscribe from task updates.

```json
{
  "type": "UNSUBSCRIBE",
  "payload": {
    "taskId": "task-123"
  }
}
```

**PING**

Send a ping to keep connection alive.

```json
{
  "type": "PING",
  "payload": {}
}
```

#### Server Messages

**CONNECTION_STATUS**

Sent on successful connection.

```json
{
  "type": "CONNECTION_STATUS",
  "payload": {
    "connected": true
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**PONG**

Response to client PING.

```json
{
  "type": "PONG",
  "payload": {},
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**TASK_STATUS_UPDATE**

Broadcast when a subscribed task's status changes.

```json
{
  "type": "TASK_STATUS_UPDATE",
  "payload": {
    "taskId": "task-123",
    "status": {
      "taskId": "task-123",
      "phase": "running",
      "progress": 75,
      "message": "Almost done...",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Heartbeat

The server sends WebSocket ping frames every 30 seconds. Clients must respond with pong frames to keep the connection alive. Connections that don't respond are terminated.

### Reconnection

Clients should implement automatic reconnection with exponential backoff when the connection is lost.

### Example Client Implementation

```javascript
class AgentStatusWebSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.subscriptions = new Set();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('Connected');
      // Resubscribe to previous tasks
      this.subscriptions.forEach(taskId => {
        this.subscribe(taskId);
      });
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = (event) => {
      if (event.code === 4001) {
        console.error('Unauthorized - session invalid');
        return;
      }
      // Reconnect after delay
      setTimeout(() => this.connect(), 5000);
    };
  }

  subscribe(taskId) {
    this.subscriptions.add(taskId);
    this.send({
      type: 'SUBSCRIBE',
      payload: { taskId }
    });
  }

  unsubscribe(taskId) {
    this.subscriptions.delete(taskId);
    this.send({
      type: 'UNSUBSCRIBE',
      payload: { taskId }
    });
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'TASK_STATUS_UPDATE':
        console.log('Task update:', message.payload);
        break;
      case 'CONNECTION_STATUS':
        console.log('Connected:', message.payload.connected);
        break;
    }
  }
}

// Usage
const ws = new AgentStatusWebSocket('ws://localhost:3001/ws/agent-status');
ws.connect();
ws.subscribe('task-123');
```

---

## Error Handling

All error responses follow a consistent format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### HTTP Status Codes

| Status | Description |
|--------|-------------|
| 200 | Success |
| 201 | Created (for POST requests that create resources) |
| 400 | Bad Request - Invalid input or validation error |
| 401 | Unauthorized - Authentication required or failed |
| 403 | Forbidden - CSRF validation failed |
| 404 | Not Found - Resource does not exist |
| 409 | Conflict - Concurrent modification |
| 422 | Unprocessable Entity - Invalid state transition |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 502 | Bad Gateway - External service error (GitHub, webhook) |
| 503 | Service Unavailable - Service not configured |
| 504 | Gateway Timeout - External service timeout |

### Validation Errors

Validation errors (400 Bad Request) include detailed information about what failed:

```json
{
  "error": "Validation error: password is required"
}
```

### Retryable Errors

Some errors include a `retryable` flag indicating the client may retry:

```json
{
  "error": "Webhook dispatch failed",
  "retryable": true
}
```

---

## Rate Limiting

### IP-Based Rate Limiting

All endpoints are subject to IP-based rate limiting.

### Login Rate Limiting

The `/api/auth/login` endpoint has additional rate limiting:
- Stricter limits to prevent brute force attacks
- Rate limits are reset on successful login
