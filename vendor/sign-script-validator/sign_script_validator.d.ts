/* tslint:disable */
/* eslint-disable */

/**
 * Validates a script and returns a JSON string:
 * `{"ok":true}` or `{"ok":false,"error":"...","line":N,"col":M}`
 * (line/col are absent when the error has no position, e.g. size cap).
 */
export function validate(script: string): string;
