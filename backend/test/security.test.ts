import { describe, expect, it } from 'vitest';
import { signPayload, verifyAdminToken, verifySignature } from '../src/security.js';
import { isParsedJson } from '../src/json-body.js';

describe('request authentication helpers', () => {
  const secret = 'test-secret-with-more-than-thirty-two-characters';

  it('accepts a valid HMAC signature for the exact raw body', () => {
    const body = '{"eventId":"evt-1"}';
    expect(verifySignature(body, signPayload(body, secret), secret)).toBe(true);
  });

  it('rejects changed body, missing signature, and malformed signature', () => {
    const body = '{"eventId":"evt-1"}';
    expect(verifySignature(body + ' ', signPayload(body, secret), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=oops', secret)).toBe(false);
  });

  it('compares admin tokens only when they match exactly', () => {
    expect(verifyAdminToken('test-admin-token', 'test-admin-token')).toBe(true);
    expect(verifyAdminToken('wrong', 'test-admin-token')).toBe(false);
  });
});

describe('webhook body guard', () => {
  it('accepts only bodies produced by the JSON parser', () => {
    expect(isParsedJson({ raw: '{"a":1}', value: { a: 1 } })).toBe(true);
  });

  it('rejects missing bodies and bodies from other content-type parsers', () => {
    expect(isParsedJson(undefined)).toBe(false);
    expect(isParsedJson(null)).toBe(false);
    expect(isParsedJson('oi')).toBe(false);
    expect(isParsedJson({ value: {} })).toBe(false);
  });
});
