export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function insist(condition, status, code, message) { if (!condition) throw new AppError(status, code, message); }
export const invalid = (condition, message) => insist(condition, 400, 'INVALID_INPUT', message);
export const conflict = (condition, message) => insist(condition, 409, 'CONFLICT', message);
