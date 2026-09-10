// The macOS terminal handoff writes a shell script, which is the only place in Hush
// where a value becomes shell text rather than an argv entry. A project path or a
// session title is user-supplied, so the quoting has to hold against values chosen to
// break out of it.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { shellQuote } = require('../src/terminal.cjs');

// Ask a real shell what the quoted value expands to. Anything other than the original
// string means the quoting let something through.
//
// The quoting is only used on macOS, so the shell is always present where it matters.
// Windows has no /bin/sh, and Git's sh is close enough to POSIX to be worth using when
// it is there; when neither exists these checks skip rather than pretend to pass.
const shell = (() => {
  for (const candidate of ['/bin/sh', 'sh']) {
    try {
      execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' });
      return candidate;
    } catch { /* try the next one */ }
  }
  return null;
})();
const needsShell = { skip: shell ? false : 'no POSIX shell on this machine' };

function expand(value) {
  return execFileSync(shell, ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
}

const hostile = [
  "plain",
  "with spaces",
  "it's got an apostrophe",
  "double\"quote",
  "semi;colon",
  "pipe|char",
  "amp&ersand",
  "back`tick`",
  "dollar$VAR and ${BRACED}",
  "sub$(command substitution)",
  "new\nline",
  "redirect > /tmp/should-not-happen",
  "and && or || chain",
  "glob * ? [a-z]",
  "trailing backslash \\",
  "'; rm -rf /tmp/nope; echo '",
  "C:\\Users\\someone\\Projects\\my app",
  "/home/user/a dir/with 'quotes'",
  "",
];

test('every value survives a real shell unchanged', needsShell, () => {
  for (const value of hostile) {
    assert.equal(expand(value), value, `mangled or interpreted: ${JSON.stringify(value)}`);
  }
});

test('an injected command does not run', needsShell, () => {
  const marker = `/tmp/hush-quote-${process.pid}`;
  // If the quoting leaked, this would create the file.
  const value = `x'; touch ${marker}; echo '`;
  expand(value);
  assert.equal(require('node:fs').existsSync(marker), false,
    'a quoted value must never execute anything');
});

test('unreserved values are left readable rather than quoted', () => {
  assert.equal(shellQuote('/usr/local/bin/claude'), '/usr/local/bin/claude');
  assert.equal(shellQuote('--mcp-config'), '--mcp-config');
});

test('an empty value stays an argument rather than disappearing', () => {
  assert.equal(shellQuote(''), "''");
});
