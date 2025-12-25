export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_ADDRESS'
  | 'INVALID_TX'
  | 'TX_NOT_FOUND'
  | 'TX_FAILED'
  | 'RATE_LIMITED'
  | 'ENERGY_NOT_ENOUGH'
  | 'USDT_NOT_ENOUGH'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR'
  | 'INVALID_STATE'
  | 'INVALID_PAYOUT'
  | 'UNAUTHORIZED'
  | 'ADMIN_DISABLED'
  | 'RPC_ERROR'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  code: ApiErrorCode;
  statusCode: number;

  constructor(code: ApiErrorCode, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function toErrorResponse(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof ApiError) {
    return { ok: false, code: err.code, message: err.message };
  }
  const msg = (err as any)?.message || String(err);
  return { ok: false, code: 'INTERNAL_ERROR', message: msg };
}


