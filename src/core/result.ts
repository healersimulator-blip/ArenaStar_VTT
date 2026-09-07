/** Shared result type used across core modules (§9 explicit error types). */
export type Ok = { ok: true };
export type Err = { ok: false; error: string };
export type OkOrErr = Ok | Err;

export const ok: Ok = { ok: true };
export const err = (error: string): Err => ({ ok: false, error });

/** Ok with a payload. */
export type OkVal<T> = { ok: true; value: T };
export type Result<T> = OkVal<T> | Err;

export const okVal = <T>(value: T): OkVal<T> => ({ ok: true, value });
