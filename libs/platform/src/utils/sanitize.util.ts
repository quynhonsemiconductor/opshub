/**
 * Strips dangerous HTML markup from string inputs (OWASP A03 — XSS prevention).
 * Applied before the value reaches any controller handler.
 *
 * Removes:
 *   - <script>, <iframe>, <object>, <embed>, <form>, <input>, <textarea>, <style>
 *   - Inline event handlers:  onclick="...", onload='...', onerror=xxx
 *
 * This file is CONVERGED with the copy in opshub and must stay byte-identical.
 * The two had drifted, and each had a gap the other did not — see the three
 * notes below, every one of which is a case the other copy got wrong. Fix a
 * defect here in both repos, or the divergence is a security defect rather than
 * an inconsistency (qnsc-app-platform/docs/ADMISSION-TEST.md).
 *
 * Worth stating plainly: stripping markup from INPUT is a weak control whatever
 * the pattern. The defence that actually holds is context-aware encoding at the
 * point of output. This is defence in depth, not the boundary.
 */
export function sanitizeString(input: string): string {
  return (
    input
      .replace(/<\s*script[^>]*>.*?<\s*\/\s*script>/gis, '')
      // `\s*` after the optional slash is deliberate: `</ script>` is a form one
      // copy stripped and the other did not.
      .replace(/<\s*\/?\s*(?:script|iframe|object|embed|form|input|textarea|style)\b[^>]*>/gis, '')
      // ONE alternation, not two passes. Matching `["'][^"']*["']` first stops at
      // the wrong quote when a value legitimately contains the other one:
      // `onclick="a'b"` matched `"a'` and left `b"` behind — a partial strip that
      // leaves live markup, which is worse than no strip at all.
      .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gis, '')
      .trim()
  );
}

/** True only for a `{}` literal — not a Date, a class instance or a null-prototype object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  // `value.constructor === Object` is the tempting form and it is weaker:
  // `constructor` is an ordinary writable property, so it describes what an
  // object CLAIMS rather than what it is.
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Recursively sanitize all string values in a plain object or array.
 * Non-string primitives, Dates, and class instances pass through unchanged.
 */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = (value as unknown[]).map((item: unknown) =>
        typeof item === 'string'
          ? sanitizeString(item)
          : isPlainObject(item)
            ? sanitizeObject(item)
            : item,
      );
    } else if (isPlainObject(value)) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized as T;
}
