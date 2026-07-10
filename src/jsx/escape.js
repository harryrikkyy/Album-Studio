// @ts-check
// jsx/escape.js — safe JSX string-literal escaping, shared by the JSX
// template builders and the bridge implementations.

/**
 * Safe JSX single-quoted string literal. Escapes \, ', \r, \n, U+2028, U+2029.
 * Use this anywhere a user-supplied path or layer name is interpolated into JSX
 * to prevent injection (e.g. a filename like  foo");app.activeDocument.close();// ).
 * @param {unknown} value
 */
function jsxString(value) {
  return "'" + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029') + "'"
}

module.exports = { jsxString }
