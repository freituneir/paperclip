export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Tool-gateway failure with a machine-readable reason code. Extends HttpError so
 * routes that let it propagate (e.g. accepting a tool-action card in an issue
 * thread) answer with its real status and `code` instead of a generic 500.
 */
export class ToolGatewayHttpError extends HttpError {
  declare details: Record<string, unknown>;
  readonly reasonCode: string;

  constructor(
    status: number,
    message: string,
    reasonCode: string,
    details: Record<string, unknown> = {},
  ) {
    super(status, message, details);
    this.reasonCode = reasonCode;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new HttpError(404, message, details);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function payloadTooLarge(message: string, details?: unknown) {
  return new HttpError(413, message, details);
}

export function unsupportedMediaType(message: string, details?: unknown) {
  return new HttpError(415, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}
