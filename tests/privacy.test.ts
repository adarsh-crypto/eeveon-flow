import { describe, expect, it } from 'vitest';
import { isSecretField, looksLikeSecretValue, type SecretProbe } from '../src/record/privacy';

function probe(overrides: Partial<SecretProbe>): SecretProbe {
  return {
    inputType: 'text',
    autocomplete: null,
    name: null,
    id: null,
    placeholder: null,
    ariaLabel: null,
    labelText: null,
    ...overrides,
  };
}

describe('isSecretField', () => {
  it('catches a password input by type', () => {
    expect(isSecretField(probe({ inputType: 'password' }))).toBe(true);
  });

  it('catches credential and payment autocomplete tokens', () => {
    expect(isSecretField(probe({ autocomplete: 'current-password' }))).toBe(true);
    expect(isSecretField(probe({ autocomplete: 'cc-number' }))).toBe(true);
    expect(isSecretField(probe({ autocomplete: 'shipping cc-csc' }))).toBe(true);
  });

  it('catches sensitive names regardless of separator or case', () => {
    expect(isSecretField(probe({ name: 'api_key' }))).toBe(true);
    expect(isSecretField(probe({ id: 'API-KEY' }))).toBe(true);
    expect(isSecretField(probe({ labelText: 'Card Number' }))).toBe(true);
    expect(isSecretField(probe({ placeholder: 'One-time code' }))).toBe(true);
    expect(isSecretField(probe({ ariaLabel: 'CVV' }))).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    expect(isSecretField(probe({ name: 'search' }))).toBe(false);
    expect(isSecretField(probe({ labelText: 'Full name' }))).toBe(false);
    expect(isSecretField(probe({ placeholder: 'Search games' }))).toBe(false);
  });
});

describe('looksLikeSecretValue', () => {
  it('catches known key prefixes', () => {
    expect(looksLikeSecretValue('sk-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeSecretValue('ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe(true);
    expect(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE1234')).toBe(true);
  });

  it('catches a JWT', () => {
    expect(looksLikeSecretValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig')).toBe(true);
  });

  it('leaves prose and short values alone', () => {
    expect(looksLikeSecretValue('half-life')).toBe(false);
    expect(looksLikeSecretValue('a fairly long sentence typed into a search box')).toBe(false);
    expect(looksLikeSecretValue('2026-08-08')).toBe(false);
  });
});
