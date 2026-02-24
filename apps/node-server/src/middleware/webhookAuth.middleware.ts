/**
 * Webhook Authentication Middleware
 *
 * Validates HMAC-signed webhook requests from agent containers.
 * Uses WEBHOOK_SECRET environment variable for signature verification.
 */

import crypto from 'node:crypto';

import type { RequestHandler } from 'express';

/**
 * Validates the HMAC signature of a webhook request.
 *
 * The signature is expected in the X-Webhook-Signature header.
 * Format: timestamp:signature
 * The signature is computed as HMAC-SHA256(timestamp:body, secret)
 */
const validateWebhookSignature = (
  body: string,
  signatureHeader: string,
  secret: string,
  maxAgeMs: number = 5 * 60 * 1000, // 5 minutes
): { valid: boolean; error?: string } => {
  try {
    const [timestampStr, signature] = signatureHeader.split(':');
    if (!timestampStr || !signature) {
      return { valid: false, error: 'Invalid signature format' };
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return { valid: false, error: 'Invalid timestamp' };
    }

    // Check if signature is not too old (replay protection)
    const now = Date.now();
    if (now - timestamp > maxAgeMs) {
      return { valid: false, error: 'Signature expired' };
    }

    // Check if signature is not from the future (clock skew tolerance: 1 minute)
    if (timestamp > now + 60 * 1000) {
      return { valid: false, error: 'Invalid timestamp' };
    }

    // Compute expected signature
    const payload = `${timestampStr}:${body}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return { valid: false, error: 'Invalid signature' };
    }

    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );

    return valid
      ? { valid: true }
      : { valid: false, error: 'Invalid signature' };
  } catch {
    return { valid: false, error: 'Signature validation failed' };
  }
};

/**
 * Creates a webhook signature for outgoing requests.
 * Used by the webhook dispatch service when calling agent containers.
 */
export const createWebhookSignature = (
  body: string,
  secret: string,
): string => {
  const timestamp = Date.now().toString();
  const payload = `${timestamp}:${body}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `${timestamp}:${signature}`;
};

// AC2.5: Configurable payload size limit with 1MB default
const MAX_WEBHOOK_PAYLOAD_BYTES = parseInt(
  process.env.MAX_WEBHOOK_PAYLOAD_BYTES ?? '1048576',
  10,
);

/**
 * Middleware to authenticate webhook requests from agents.
 * AC2.1, AC2.4: Checks Content-Length before HMAC verification to prevent CPU-based DoS.
 */
export const webhookAuthMiddleware: RequestHandler = (req, res, next) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[WebhookAuth] WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  // AC2.1, AC2.2, AC2.4: Check Content-Length BEFORE HMAC verification
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const bodySize = parseInt(contentLength, 10);
    if (!isNaN(bodySize) && bodySize > MAX_WEBHOOK_PAYLOAD_BYTES) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
  }

  // AC2.3: When Content-Length is missing, check actual body size
  const rawBody = JSON.stringify(req.body);
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_PAYLOAD_BYTES) {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  const signatureHeader = req.headers['x-webhook-signature'];

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    res.status(401).json({ error: 'Missing webhook signature' });
    return;
  }

  const result = validateWebhookSignature(
    rawBody,
    signatureHeader,
    webhookSecret,
  );

  if (!result.valid) {
    console.warn('[WebhookAuth] Invalid signature:', result.error);
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  next();
};

export { validateWebhookSignature };
