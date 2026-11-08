import { describe, expect, it } from 'vitest';
import { safeTrimId } from '../src/maintenance.js';

describe('stream trim floor', () => {
  it('uses the retention cutoff when everything older was read and acknowledged', () => {
    expect(safeTrimId('1000-0', '5000-0', null)).toBe('1000-0');
    expect(safeTrimId('9000-0', '0-0', null)).toBe('0-1'); // nothing read yet: keep all
  });

  it('never trims past the oldest pending entry', () => {
    expect(safeTrimId('5000-0', '9000-0', '3000-2')).toBe('3000-2');
  });

  it('never trims entries the group has not read yet', () => {
    expect(safeTrimId('5000-0', '2000-1', null)).toBe('2000-2');
  });

  it('compares sequence numbers within the same millisecond', () => {
    expect(safeTrimId('3000-5', '3000-2', null)).toBe('3000-3');
    expect(safeTrimId('3000-1', '3000-2', null)).toBe('3000-1');
  });
});

describe('transient database errors', async () => {
  const { isTransientDatabaseError } = await import('../src/database.js');
  it('treats connection failures and server shutdowns as transient', () => {
    expect(isTransientDatabaseError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientDatabaseError(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('does not hide real bugs as unavailability', () => {
    expect(isTransientDatabaseError(Object.assign(new Error('x'), { code: '42P01' }))).toBe(false); // undefined_table
    expect(isTransientDatabaseError(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});
