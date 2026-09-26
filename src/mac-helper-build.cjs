const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Both the source launch and packaging use this target. A universal helper also
// prevents a cached ARM helper from being shipped in an Intel app (or vice versa).
const minimumMacOS = '13.0';
async function buildMacHelper(source, output, compiler = 'swiftc', stdio = 'pipe') {
  const run = async (command, args, timeout) => {
    const result = await execute(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    if (stdio === 'inherit') { process.stdout.write(result.stdout); process.stderr.write(result.stderr); }
    return result.stdout + result.stderr;
  };
  const info = path.join(path.dirname(source), 'dictation-macos.plist');
  const toolchain = await run(compiler, ['--version'], 30000);
  const fingerprint = crypto.createHash('sha256')
    .update(fs.readFileSync(source)).update(fs.readFileSync(info))
    .update(toolchain).update(minimumMacOS).update('arm64,x86_64;-O;info-plist-v1').digest('hex');
  const manifest = output + '.build.json';
  try {
    if (fs.existsSync(output) && JSON.parse(fs.readFileSync(manifest)).fingerprint === fingerprint) return output;
  } catch {}
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.hush-helper-'));
  try {
    const slices = [];
    for (const arch of ['arm64', 'x86_64']) {
      const binary = path.join(temporary, arch);
      await run(compiler, ['-O', '-target', `${arch}-apple-macosx${minimumMacOS}`,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', info,
        '-o', binary, source], 300000);
      slices.push(binary);
    }
    const universal = path.join(temporary, 'dictation-macos');
    await run('/usr/bin/lipo', ['-create', ...slices, '-output', universal], 30000);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', universal], 30000);
    fs.renameSync(universal, output);
    fs.writeFileSync(manifest, JSON.stringify({ fingerprint }));
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { buildMacHelper, minimumMacOS };
