import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const typosBinary = process.env.TYPOS_BIN ?? 'typos';

function isRunnable(binary) {
  if (binary.includes('/')) {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
}

const missing = [
  !isRunnable(cspellBinary) && `CSpell (${cspellBinary})`,
  !isRunnable(typosBinary) && `typos (${typosBinary})`,
].filter(Boolean);

test('the golden fixtures expose the known Rust-engine parity gaps', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, () => {
  const result = spawnSync(process.execPath, ['scripts/spellcheck-rust/compare.mjs', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, CSPELL_BIN: cspellBinary, TYPOS_BIN: typosBinary },
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.engines.cspell, '10.1.1');
  assert.match(report.engines.typos, /1\.51\.1/u);
  assert.deepEqual(report.counts, { cspell: 20, typos: 16 });
  assert.equal(report.equivalent, false);
  assert.deepEqual(report.missing.map(({ word }) => word), ['sentnce', 'résumé', 'résumé', 'Totl', 'Totl', 'Shippng']);
  assert.deepEqual(report.extra.map(({ word }) => word), ['definately', 'definately']);
  assert.equal(report.suggestionMismatches.length, 14);
  assert.equal(report.orderMatches, true);
  assert.deepEqual(report.exits, { cspell: 1, typos: 2, semanticClassMatches: true });
});

test('shadow mode reports mismatches without blocking', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, () => {
  const result = spawnSync(process.execPath, ['scripts/spellcheck-rust/compare.mjs', '--shadow', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, CSPELL_BIN: cspellBinary, TYPOS_BIN: typosBinary },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).equivalent, false);
});
