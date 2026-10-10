import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const targetRoot = resolve(repositoryRoot, 'scripts/spellcheck-rust/native/target');
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const nativeBinary =
  process.env.RUST_SPELL_BIN ?? resolve(targetRoot, 'release/diagonal-spellcheck');
const dictionary = process.env.RUST_SPELL_DICTIONARY ?? resolve(targetRoot, 'cspell-lexicon.txt');
const representatives = [
  'app/ai/src/Support/PageDesignAnalyzer.php',
  'app/workflows/resources/js/components/workflowStep/workflowCanvasNodeColors.ts',
  'docs/frontend-test-performance.md',
];

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const missing = [
  !(await readable(cspellBinary)) && `CSpell (${cspellBinary})`,
  !(await readable(nativeBinary)) && `native binary (${nativeBinary})`,
  !(await readable(dictionary)) && `prepared dictionary (${dictionary})`,
].filter(Boolean);

function run(binary, arguments_) {
  return spawnSync(binary, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

test('seeded mutations in representative real files preserve native detection parity', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'mutations-'));
  try {
    const files = [];
    for (const [index, source] of representatives.entries()) {
      const sourceText = await readFile(resolve(repositoryRoot, source), 'utf8');
      const destination = resolve(directory, `${index}-${basename(source)}`);
      const comment = source.endsWith('.md') ? '\nNative parity mutation: recieve mispeling\n' : '\n// Native parity mutation: recieve mispeling\n';
      await writeFile(destination, sourceText + comment);
      files.push(destination);
    }

    const cspell = run(cspellBinary, [
      'lint',
      ...files,
      '--config',
      'cspell.json',
      '--no-progress',
      '--show-suggestions',
      '--reporter',
      '@cspell/cspell-json-reporter',
    ]);
    const native = run(nativeBinary, ['--dictionary', dictionary, ...files]);
    assert.equal(cspell.status, 1, cspell.stderr);
    assert.equal(native.status, 1, native.stderr);

    const oracle = JSON.parse(cspell.stdout).issues.map((issue) => ({
      file: basename(fileURLToPath(issue.uri)),
      row: issue.row,
      col: issue.col,
      word: issue.text,
    }));
    const candidate = native.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((issue) => ({ file: basename(issue.path), row: issue.row, col: issue.col, word: issue.word }));

    assert.equal(oracle.length, 6);
    assert.deepEqual(candidate, oracle);
    assert.deepEqual(oracle.map(({ word }) => word), [
      'recieve',
      'mispeling',
      'recieve',
      'mispeling',
      'recieve',
      'mispeling',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
