#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cspell = process.env.CSPELL_BIN ?? resolve(root, 'node_modules/.bin/cspell');
const native = process.env.RUST_SPELL_BIN ?? resolve(root, 'scripts/spellcheck-rust/native/target/release/diagonal-spellcheck');
const dictionary = process.env.RUST_SPELL_DICTIONARY ?? resolve(root, 'scripts/spellcheck-rust/native/target/cspell-lexicon.txt');
const [listArgument, runsArgument = '5'] = process.argv.slice(2);
const runs = Number(runsArgument);
if (!listArgument || process.argv.length > 4 || !Number.isInteger(runs) || runs < 1 || runs > 20) {
  console.error('usage: node scripts/spellcheck-rust/benchmark.mjs ABSOLUTE_FILE_LIST [RUNS=5]');
  process.exit(2);
}

function run(binary, args, env = process.env) {
  const start = process.hrtime.bigint();
  const result = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, milliseconds: Number(process.hrtime.bigint() - start) / 1e6 };
}

function sameResult(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.stderr, expected.stderr);
}

let temporary;
try {
  const gate = run(resolve(root, 'bin/worktree'), ['check']);
  assert.equal(gate.status, 0, 'worktree check failed');
  assert.ok(gate.stdout === '' || /Setup: complete/u.test(gate.stdout), 'worktree setup is incomplete; timings are not authorized');
  assert.ok(isAbsolute(listArgument), 'file-list path must be absolute');
  const list = resolve(listArgument);
  const bytes = readFileSync(list);
  const files = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
  assert.ok(files.length > 0 && files.every(isAbsolute), 'file list must contain absolute entries');
  assert.equal(new Set(files).size, files.length, 'duplicate input paths');
  assert.equal(run(cspell, ['--version']).stdout.trim(), '10.1.1');
  const nativeVersion = run(native, ['--version']);
  assert.equal(nativeVersion.status, 0);
  const oracleArgs = ['lint', '**', '--file-list', list, '--config', 'cspell.json', '--no-progress', '--show-suggestions'];
  const hybridArgs = ['scripts/spellcheck-rust/hybrid.mjs', `--file-list=${list}`];
  const environment = { ...process.env, CSPELL_BIN: cspell, RUST_SPELL_BIN: native, RUST_SPELL_DICTIONARY: dictionary };
  const expected = run(cspell, oracleArgs);
  assert.ok([0, 1].includes(expected.status), 'oracle configuration or runner failure');
  sameResult(run(process.execPath, [...hybridArgs, '--verify-clean'], environment), expected);

  temporary = mkdtempSync(resolve(root, 'scripts/spellcheck-rust/native/target/benchmark-'));
  const log = resolve(temporary, 'lint-calls.txt');
  const spy = resolve(temporary, 'cspell.mjs');
  writeFileSync(spy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === 'lint') appendFileSync(${JSON.stringify(log)}, 'lint\\n');
const result = spawnSync(${JSON.stringify(cspell)}, process.argv.slice(2), { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
if (result.error || result.signal) process.exit(2);
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status);
`);
  chmodSync(spy, 0o755);
  sameResult(run(process.execPath, hybridArgs, {
    ...environment, CSPELL_BIN: spy,
    CSPELL_INSTALL_LOCK: process.env.CSPELL_INSTALL_LOCK ?? resolve(dirname(cspell), '../..', 'package-lock.json'),
  }), expected);
  let oracleInvoked = false;
  try {
    oracleInvoked = readFileSync(log, 'utf8').includes('lint');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const samples = { cspell: [], hybrid: [] };
  for (let index = 0; index < runs; index += 1) {
    const order = index % 2 === 0 ? ['cspell', 'hybrid'] : ['hybrid', 'cspell'];
    for (const engine of order) {
      const result = engine === 'cspell' ? run(cspell, oracleArgs) : run(process.execPath, hybridArgs, environment);
      sameResult(result, expected);
      samples[engine].push(Number(result.milliseconds.toFixed(2)));
    }
  }
  assert.deepEqual(readFileSync(list), bytes, 'file list changed during benchmark');
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { samplesMs: values, minMs: sorted[0], maxMs: sorted.at(-1),
      medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
  };
  console.log(JSON.stringify({
    scope: { list, inputPaths: files.length, listSha256: sha256(bytes),
      configSha256: sha256(readFileSync(resolve(root, 'cspell.json'))),
      sourceSha256: sha256(readFileSync(resolve(root, 'scripts/spellcheck-rust/native/src/main.rs'))),
      dictionarySha256: sha256(readFileSync(dictionary)) },
    engines: { cspell: '10.1.1', native: nativeVersion.stdout.trim() },
    exit: expected.status, hybridOracleInvokedInUntimedProbe: oracleInvoked,
    method: 'Untimed verification, then alternating new processes; ordinary OS cache; acquisition and preparation excluded.',
    cspell: stats(samples.cspell), hybrid: stats(samples.hybrid),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
