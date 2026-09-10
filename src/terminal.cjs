// Quoting for the one place a command cannot be passed as an argv vector: Terminal.app
// takes a file to run, so the command has to become shell text. Everything else on every
// platform launches argv directly and never needs this.
//
// Single quotes make the shell treat every byte literally, so the only case to handle is
// a single quote itself: close the quoted run, emit an escaped quote, reopen. A value
// that has been through this cannot start a new word, a subshell, or a redirect.

/** Quote one argument for /bin/sh so its contents can never be interpreted. */
function shellQuote(value) {
  const text = String(value);
  if (text === '') return "''";
  // Unreserved characters need no quoting, which keeps generated scripts readable.
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(text)) return text;
  return `'${text.split("'").join(`'\\''`)}'`;
}

module.exports = { shellQuote };
