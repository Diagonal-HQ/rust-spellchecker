import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const nativeBinary =
  process.env.RUST_SPELL_BIN ?? resolve(repositoryRoot, 'scripts/spellcheck-rust/native/target/release/diagonal-spellcheck');
const dictionary =
  process.env.RUST_SPELL_DICTIONARY ??
  resolve(repositoryRoot, 'scripts/spellcheck-rust/native/target/cspell-lexicon.txt');

function readable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const missing = [
  !readable(cspellBinary) && `CSpell (${cspellBinary})`,
  !readable(nativeBinary) && `native binary (${nativeBinary})`,
  !readable(dictionary) && `prepared dictionary (${dictionary})`,
].filter(Boolean);

test('native milestone matches fixture detections, locations, order, and finding exit code', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, () => {
  const result = spawnSync(process.execPath, ['scripts/spellcheck-rust/compare-native.mjs', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CSPELL_BIN: cspellBinary,
      RUST_SPELL_BIN: nativeBinary,
      RUST_SPELL_DICTIONARY: dictionary,
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.counts, { cspell: 24, native: 24 });
  assert.deepEqual(report.exits, { cspell: 1, native: 1 });
  assert.equal(report.detectionsEquivalent, true);
  assert.equal(report.missing.length, 0);
  assert.equal(report.extra.length, 0);
  assert.equal(report.detectionOrderMatches, true);
  assert.equal(report.suggestionMismatches.length, 24);
  assert.equal(report.equivalent, false);
});

test('native shadow mode keeps known gaps non-blocking', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, () => {
  const result = spawnSync(process.execPath, ['scripts/spellcheck-rust/compare-native.mjs', '--shadow', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CSPELL_BIN: cspellBinary,
      RUST_SPELL_BIN: nativeBinary,
      RUST_SPELL_DICTIONARY: dictionary,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).equivalent, false);
});
