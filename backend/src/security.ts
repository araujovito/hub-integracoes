import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature: HMAC-SHA256 over `<timestamp>.<raw body>`, where timestamp
 * is Unix seconds sent in X-Webhook-Timestamp. Signing the timestamp lets the
 * receiver reject old captures; changing it invalidates the signature.
 */
export function signPayload(rawBody: string, secret: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}

export function verifySignature(rawBody: string, supplied: string | undefined, secret: string, timestamp: number): boolean {
  if (!supplied || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = Buffer.from(signPayload(rawBody, secret, timestamp), 'utf8');
  const actual = Buffer.from(supplied.toLowerCase(), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Parse X-Webhook-Timestamp: whole Unix seconds only (no ms, no decimals). */
export function parseWebhookTimestamp(header: string | undefined): number | null {
  if (!header || !/^\d{9,11}$/.test(header)) return null;
  return Number(header);
}

/** True when the signed timestamp is within `toleranceSeconds` of now, either way. */
export function isFreshTimestamp(timestamp: number, nowMs: number, toleranceSeconds: number): boolean {
  return Math.abs(nowMs / 1000 - timestamp) <= toleranceSeconds;
}

export function verifyAdminToken(supplied: string | undefined, expectedToken: string): boolean {
  if (!supplied || supplied.length > 512) return false;
  const actual = Buffer.from(supplied, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
