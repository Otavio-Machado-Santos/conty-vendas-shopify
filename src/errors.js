export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function requireInput(condition, code, message) {
  if (!condition) throw new DomainError(code, message);
}
