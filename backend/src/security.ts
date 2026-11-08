import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

export function verifySignature(rawBody: string, supplied: string | undefined, secret: string): boolean {
  if (!supplied || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = Buffer.from(signPayload(rawBody, secret), 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyAdminToken(supplied: string | undefined, expectedToken: string): boolean {
  if (!supplied || supplied.length > 512) return false;
  const actual = Buffer.from(supplied, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
