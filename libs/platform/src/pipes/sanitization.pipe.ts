import { Injectable, PipeTransform } from '@nestjs/common';
import { sanitizeObject, sanitizeString } from '@quynhonsemiconductor/platform-http';

/**
 * Strips XSS-dangerous markup from all string inputs before they reach handlers
 * or Zod validation (OWASP A03:2021 — Cross-Site Scripting Prevention).
 *
 * Must be registered BEFORE ZodValidationPipe:
 *   { provide: APP_PIPE, useClass: SanitizationPipe },  // strip XSS first
 *   { provide: APP_PIPE, useClass: ZodValidationPipe }, // then validate shape
 */
@Injectable()
export class SanitizationPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'string') return sanitizeString(value);
    if (value && typeof value === 'object' && value.constructor === Object)
      return sanitizeObject(value as Record<string, unknown>);
    return value;
  }
}
