// The engine loads better-sqlite3 with require() on first use and accepts
// only the constructor the real package exports (upstream 0.32.0, #1793).
// An alias to portable/sqlite.ts alone would hand it the module namespace,
// so this gives it the class itself.
// eslint-disable-next-line @typescript-eslint/no-var-requires
module.exports = require('./sqlite').default;
