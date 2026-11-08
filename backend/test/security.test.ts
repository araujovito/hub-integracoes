import { describe, expect, it } from 'vitest';
import { isFreshTimestamp, parseWebhookTimestamp, signPayload, verifyAdminToken, verifySignature } from '../src/security.js';

describe('request authentication helpers', () => {
  const secret = 'test-secret-with-more-than-thirty-two-characters';
  const ts = 1_790_000_000;
  const body = '{"eventId":"evt-1"}';

  it('accepts a valid HMAC signature for the exact raw body and timestamp', () => {
    expect(verifySignature(body, signPayload(body, secret, ts), secret, ts)).toBe(true);
  });

  it('rejects changed body, changed timestamp, missing and malformed signatures', () => {
    expect(verifySignature(`${body} `, signPayload(body, secret, ts), secret, ts)).toBe(false);
    expect(verifySignature(body, signPayload(body, secret, ts), secret, ts + 1)).toBe(false);
    expect(verifySignature(body, undefined, secret, ts)).toBe(false);
    expect(verifySignature(body, 'sha256=oops', secret, ts)).toBe(false);
  });

  it('parses only whole Unix seconds in the timestamp header', () => {
    expect(parseWebhookTimestamp('1790000000')).toBe(1_790_000_000);
    for (const bad of [undefined, '', '1790000000000', '1790000000.5', '-1790000000', 'abc']) {
      expect(parseWebhookTimestamp(bad)).toBeNull();
    }
  });

  it('accepts timestamps within the tolerance window in either direction', () => {
    const now = ts * 1000;
    expect(isFreshTimestamp(ts - 300, now, 300)).toBe(true);
    expect(isFreshTimestamp(ts + 300, now, 300)).toBe(true);
    expect(isFreshTimestamp(ts - 301, now, 300)).toBe(false);
    expect(isFreshTimestamp(ts + 301, now, 300)).toBe(false);
  });

  it('compares admin tokens only when they match exactly', () => {
    expect(verifyAdminToken('test-admin-token', 'test-admin-token')).toBe(true);
    expect(verifyAdminToken('wrong', 'test-admin-token')).toBe(false);
  });
});

describe('webhook body guard', () => {
  it('accepts only bodies produced by the JSON parser', async () => {
    const { isParsedJson } = await import('../src/json-body.js');
    expect(isParsedJson({ raw: '{"a":1}', value: { a: 1 } })).toBe(true);
    expect(isParsedJson(undefined)).toBe(false);
    expect(isParsedJson(null)).toBe(false);
    expect(isParsedJson('oi')).toBe(false);
    expect(isParsedJson({ value: {} })).toBe(false);
  });
});
