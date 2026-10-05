/** 统一错误码，API 与 CLI 共用。 */
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GEOMETRY"
  | "BUDGET"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION", message, details);
}

export function notFoundError(message: string): AppError {
  return new AppError("NOT_FOUND", message);
}

export function geometryError(message: string, details?: unknown): AppError {
  return new AppError("GEOMETRY", message, details);
}
