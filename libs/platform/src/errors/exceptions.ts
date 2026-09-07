import { DomainException as SharedDomainException } from '@quynhonsemiconductor/platform-http';
import type { ErrorCategory, ErrorCode } from './error-codes';

/**
 * Base exception for all domain/application errors.
 * The global exception filter maps this to the wire envelope.
 *
 * Extends the shared `@quynhonsemiconductor/platform-http` DomainException so that errors
 * thrown by shared packages (e.g. `@quynhonsemiconductor/identity`'s AuthService) and errors
 * thrown by opshub's own use-cases share ONE class identity. The global
 * exception filter then maps both through a single `instanceof` branch instead
 * of letting shared-package errors fall through to a generic 500. opshub keeps
 * its strict `ErrorCode` catalog typing on the constructor (the shared base
 * intentionally accepts an open `string`); the shared base derives `httpStatus`
 * from the (identical) category table.
 */
export class DomainException extends SharedDomainException {
  constructor(code: ErrorCode, message: string, category: ErrorCategory, details?: unknown[]) {
    super(code, message, category, details);
  }
}

export class NotFoundException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'NOT_FOUND');
  }
}

export class ConflictException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'CONFLICT');
  }
}

export class ValidationException extends DomainException {
  constructor(code: ErrorCode, message: string, details?: unknown[]) {
    super(code, message, 'VALIDATION_FAILED', details);
  }
}

/**
 * A 403 with a reason.
 *
 * WHY THE CODE IS A PARAMETER. It was hardcoded to `FORBIDDEN`, so every refusal on this path told a
 * client the same thing — and separation of duties is not the same refusal as a missing permission.
 * "You may not approve your own request" is answered by asking a colleague; "you lack
 * `document.approve`" is answered by asking for access. Both arrived as `FORBIDDEN`, and the
 * distinction survived only as a prefix smuggled into the human-readable message
 * (`'REQUEST_SOD_VIOLATION: Requester cannot approve their own request'`), where no client can act on
 * it and `ErrorCodes.REQUEST_SOD_VIOLATION` sat in the catalogue unemitted.
 *
 * MESSAGE STILL FIRST, so the thirty-odd existing call sites are unchanged and a bare
 * `new PermissionDeniedException()` still means a plain `FORBIDDEN`.
 */
export class PermissionDeniedException extends DomainException {
  constructor(message = 'Permission denied', code: ErrorCode = 'FORBIDDEN') {
    super(code, message, 'PERMISSION_DENIED');
  }
}

export class UnauthorizedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'UNAUTHORIZED');
  }
}

export class PreconditionFailedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'PRECONDITION_FAILED');
  }
}
