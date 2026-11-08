/** Body produced by the app's application/json parser: raw text kept for HMAC verification. */
export type ParsedJson = { raw: string; value: unknown };

/**
 * True only for bodies produced by our JSON parser. Requests without a body, or
 * with another content type handled by a Fastify default parser (e.g. text/plain
 * arrives as a bare string), must be rejected before signature verification.
 */
export function isParsedJson(body: unknown): body is ParsedJson {
  return typeof body === 'object' && body !== null && typeof (body as { raw?: unknown }).raw === 'string';
}
