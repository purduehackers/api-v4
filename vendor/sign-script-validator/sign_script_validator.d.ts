/* tslint:disable */
/* eslint-disable */

/**
 * Validates and lowers a script, returning a JSON string:
 * `{"ok":true,"artifact":"<base64 grain bytecode>"}` or
 * `{"ok":false,"error":"...","line":N,"col":M}`
 * (line/col are absent when the error has no position, e.g. size cap).
 */
export function validate(script: string): string;
