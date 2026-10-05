/** 业务错误：携带公开错误码与 HTTP 状态 */
export class ApiError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const ERR = {
  INVALID_BOUNDARY: "INVALID_BOUNDARY",
  RANGE_EXCEEDED: "RANGE_EXCEEDED",
  MIRROR_OUTSIDE: "MIRROR_OUTSIDE",
  DEGENERATE_MIRROR: "DEGENERATE_MIRROR",
  TOO_MANY_MIRRORS: "TOO_MANY_MIRRORS",
  ORIGIN_OUTSIDE: "ORIGIN_OUTSIDE",
  ORIGIN_ON_MIRROR: "ORIGIN_ON_MIRROR",
  ZERO_DIRECTION: "ZERO_DIRECTION",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
} as const;
