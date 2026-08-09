/**
 * Privacy at capture time.
 *
 * The contract is narrow and absolute: if `isSecretField` returns true, the recorder never
 * reads `.value` from that element. There is no redaction pass later, because a value that
 * was never captured cannot be leaked by a bug in a downstream exporter.
 */

const SECRET_INPUT_TYPES = new Set(['password']);

/** autocomplete tokens that identify credentials or payment data. */
const SECRET_AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
];

/** Substrings in name/id/placeholder/label that mark a field as sensitive. */
const SECRET_HINTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'api-key',
  'auth',
  'credential',
  'otp',
  'mfa',
  '2fa',
  'totp',
  'one_time_code',
  'verification_code',
  'security_code',
  'passcode',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
  'creditcard',
  'ssn',
  'social_security',
  'pin',
  'private_key',
  'access_key',
  'session',
];

export interface SecretProbe {
  inputType: string | null;
  autocomplete: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  labelText: string | null;
}

/**
 * Pure predicate over the element's identifying attributes, so it is testable without a DOM.
 * `isSecretElement` is the thin adapter used by the content script.
 */
export function isSecretField(probe: SecretProbe): boolean {
  if (probe.inputType && SECRET_INPUT_TYPES.has(probe.inputType.toLowerCase())) return true;

  if (probe.autocomplete) {
    const tokens = probe.autocomplete.toLowerCase().split(/\s+/);
    if (tokens.some((t) => SECRET_AUTOCOMPLETE.includes(t))) return true;
  }

  const haystack = [probe.name, probe.id, probe.placeholder, probe.ariaLabel, probe.labelText]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .toLowerCase()
    // Normalise separators so "Card Number" and "card-number" both hit "card_number".
    .replace(/[\s-]+/g, '_');

  if (!haystack) return false;
  return SECRET_HINTS.some((hint) => haystack.includes(hint));
}

export function isSecretElement(el: Element, labelText: string | null): boolean {
  return isSecretField({
    inputType: el.getAttribute('type'),
    autocomplete: el.getAttribute('autocomplete'),
    name: el.getAttribute('name'),
    id: el.getAttribute('id'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    labelText,
  });
}

/**
 * Values that look like secrets even in a field that does not. Long random-looking strings
 * pasted into a plain text box are the common case (an API key in a "config" textarea).
 */
export function looksLikeSecretValue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  if (/\s/.test(trimmed)) return false; // real prose has spaces
  if (/^(sk|pk|ghp|gho|xox[baprs]|AKIA|AIza)[-_A-Za-z0-9]{10,}$/.test(trimmed)) return true;
  if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(trimmed)) return true; // JWT
  // High-entropy mixed-case-plus-digit blob with no separators.
  return /^[A-Za-z0-9+/_-]{32,}$/.test(trimmed) && /[a-z]/.test(trimmed) && /[A-Z0-9]/.test(trimmed);
}
