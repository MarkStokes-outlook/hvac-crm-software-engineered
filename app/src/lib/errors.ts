export class DomainError extends Error {
  status = 422;
  constructor(message: string, readonly fields: Record<string, string> = {}) {
    super(message);
  }
}
export class ForbiddenError extends DomainError {
  status = 403;
  constructor(message = 'You do not have permission to do that.') {
    super(message);
  }
}
export class NotFoundError extends DomainError {
  status = 404;
  constructor(what = 'Record') {
    super(`${what} not found.`);
  }
}
/** Optimistic-lock or contested-resource conflict; surfaced to the user, never silently overwritten. */
export class ConflictError extends DomainError {
  status = 409;
}

export function assert(cond: unknown, message: string, field?: string): asserts cond {
  if (!cond) throw new DomainError(message, field ? { [field]: message } : {});
}
