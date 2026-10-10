import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = resolve(root, 'scripts/spellcheck-rust/native/target');
const cspell = process.env.CSPELL_BIN ?? resolve(root, 'node_modules/.bin/cspell');
const native = process.env.RUST_SPELL_BIN ?? resolve(target, 'release/diagonal-spellcheck');
const dictionary = process.env.RUST_SPELL_DICTIONARY ?? resolve(target, 'cspell-lexicon.txt');
const seed = 0x5eed;

function run(binary, args, env = process.env) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', env, maxBuffer: 128 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function oracle(list, json = false) {
  return run(cspell, ['lint', '**', '--file-list', list, '--config', 'cspell.json',
    '--no-progress', '--show-suggestions', ...(json ? ['--reporter', '@cspell/cspell-json-reporter'] : [])]);
}

function hybrid(list) {
  return run(process.execPath, ['scripts/spellcheck-rust/hybrid.mjs', `--file-list=${list}`], {
    ...process.env, CSPELL_BIN: cspell, RUST_SPELL_BIN: native, RUST_SPELL_DICTIONARY: dictionary,
  });
}

function sameResult(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.stderr, expected.stderr);
}

function corpus() {
  const cases = [
    ['markdown-link-eol', 'md', 'recieve [hello](mispeling)'],
    ['markdown-link-unclosed', 'md', 'recieve [hello](mispeling'],
    ['markdown-link-title', 'md', '[recieve](hello "mispeling")'],
    ['url-schemes', 'md', 'https://example.test http://example.test recieve'],
    ['url-adjacency', 'md', 'recieve(https://example.test) mispeling'],
    ['email-adjacency', 'md', 'recieve hello@example.test mispeling'],
    ['unicode-astral', 'md', '😀 recieve'],
    ['unicode-apostrophe', 'md', 'café’érrror 😀 mispeling'],
    ['unicode-expanding-case', 'md', 'İ // cspell:words zorbulate\nzorbulate recieve'],
    ['unicode-decomposed', 'md', 'cafe\u0301 re\u0301cieve'],
    ['unicode-joiners', 'md', 'recie\u200dve mispe\u200cling'],
    ['unicode-letters', 'md', 'résumé naïve café Straße İstanbul recieve'],
    ['case-and-compounds', 'ts', 'const calculateRecieptTotl = "indexname ratelimit unbatched recieve";'],
    ['acronym-suffix', 'ts', 'const HTTPing = "HTTPmispeling";'],
    ['apostrophes', 'md', "don't invoice's recieve’s mispeling's"],
    ['hex-adjacency', 'ts', 'const color = "#f8fafc-recieve #f8fafc mispeling";'],
    ['digits-and-boundaries', 'ts', 'const value = "123recieve456 mispeling_0 Totl9";'],
    ['regex-escapes', 'php', "<?php\n$pattern = '/\\brecieve\\nhello/';"],
    ['date-adjacency', 'php', '<?php\n$date = "yyyyMMddTHHmmssX-recieve";'],
    ['base64-adjacency', 'ts', 'const value = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=recieve";'],
    ['short-words', 'md', 'teh Totl adress'],
    ['unknown-directive', 'md', '<!-- cspell:unknown-directive recieve -->'],
    ['words-same-line', 'ts', 'const recieve = 1; // cspell:words zorbulate'],
    ['words-spaced', 'md', '<!-- cspell: words zorbulate -->\nzorbulate recieve'],
    ['ignore', 'md', '<!-- cspell:ignore zorbulate -->\nzorbulate recieve'],
    ['flags', 'md', '<!-- cspell:forbid hello -->\nhello'],
    ['flags-alias', 'md', '<!-- spell-checker:flag hello -->\nhello'],
    ['local-words', 'md', '<!-- LocalWords: zorbulate -->\nzorbulate recieve'],
    ['regex-ignore', 'md', '<!-- cspell:ignoreRegExp /zorbulate/g -->\nzorbulate recieve'],
    ['regex-include', 'md', '<!-- cspell:includeRegExp /recieve/g -->\nzorbulate recieve'],
    ['dictionary-directive', 'md', '<!-- cspell:dictionaries !en_us -->\nhello recieve'],
    ['case-directive', 'md', '<!-- cspell:enableCaseSensitive -->\njavascript JavaScript recieve'],
    ['compound-directive', 'md', '<!-- cspell:disableCompoundWords -->\nratelimitreset recieve'],
    ['block-enable-same-line', 'md', '<!-- cspell:disable -->\nrecieve\n<!-- cspell:enable --> mispeling'],
    ['next-line-crlf', 'md', '<!-- cspell:disable-next-line -->\r\nrecieve\r\nmispeling'],
    ['disable-line-prefix', 'md', 'recieve <!-- cspell:disable-line-other -->\nmispeling'],
  ];
  let state = seed;
  const typos = ['recieve', 'mispeling', 'accomodate', 'definately'];
  const boundaries = [' ', '_', '.', '-', '/', '😀', '\t', ':'];
  const extensions = ['md', 'ts', 'tsx', 'php'];
  for (let index = 0; index < 64; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const boundary = boundaries[(state >>> 0) % boundaries.length];
    const typo = typos[index % typos.length];
    cases.push([`seed-${index}`, extensions[index % extensions.length], `hello${boundary}${typo}${boundary}world`]);
  }
  return cases;
}

test('seeded adversarial corpus exposes native gaps and preserves hybrid output', async (t) => {
  const gate = run(resolve(root, 'bin/worktree'), ['check']);
  assert.equal(gate.status, 0, 'worktree setup check failed');
  assert.ok(gate.stdout === '' || /Setup: complete/u.test(gate.stdout), 'worktree setup is incomplete');
  for (const path of [cspell, native, dictionary]) await access(path);
  assert.equal(run(cspell, ['--version']).stdout.trim(), '10.1.1');

  await mkdir(target, { recursive: true });
  const workspace = await mkdtemp(resolve(target, 'adversarial-'));
  const documents = await mkdtemp(resolve(root, 'docs/spellcheck-rust-adversarial-'));
  const scripts = await mkdtemp(resolve(root, 'resources/js/spellcheck-rust-adversarial-'));
  try {
    const files = [];
    for (const [name, extension, text] of corpus()) {
      const directory = extension === 'md' ? documents : extension === 'php' ? workspace : scripts;
      const path = resolve(directory, `${name}.${extension}`);
      await writeFile(path, `${text}\n`);
      files.push(path);
    }
    const representatives = [
      'app/ai/src/Support/PageDesignAnalyzer.php',
      'app/workflows/resources/js/components/workflowStep/workflowCanvasNodeColors.ts',
      'docs/frontend-test-performance.md',
    ];
    for (const [index, source] of representatives.entries()) {
      const extension = source.endsWith('.md') ? 'md' : source.endsWith('.php') ? 'php' : 'ts';
      const path = resolve(extension === 'md' ? documents : extension === 'php' ? workspace : scripts,
        `representative-${index}.${extension}`);
      const text = await readFile(resolve(root, source), 'utf8');
      const comment = extension === 'md' ? '\nrecieve mispeling\n' : '\n// recieve mispeling\n';
      await writeFile(path, text + comment);
      files.push(path);
    }
    files.sort();
    const list = resolve(workspace, 'files.txt');
    await writeFile(list, `${files.join('\n')}\n`);
    const expected = oracle(list, true);
    assert.equal(expected.status, 1, expected.stderr);
    const oracleIssues = JSON.parse(expected.stdout).issues.map((issue) => ({
      path: fileURLToPath(issue.uri), row: issue.row, col: issue.col, word: issue.text,
    }));
    const result = run(native, ['--dictionary', dictionary, '--file-list', list]);
    assert.ok([0, 1].includes(result.status), result.stderr);
    const nativeIssues = result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const { path, row, col, word } = JSON.parse(line);
      return { path, row, col, word };
    });
    const key = (issue) => JSON.stringify(issue);
    const oracleKeys = new Set(oracleIssues.map(key));
    const nativeKeys = new Set(nativeIssues.map(key));
    const missing = oracleIssues.filter((issue) => !nativeKeys.has(key(issue)));
    const extra = nativeIssues.filter((issue) => !oracleKeys.has(key(issue)));
    const unsafeCleanFiles = [...new Set(oracleIssues.map((issue) => issue.path))]
      .filter((path) => !nativeIssues.some((issue) => issue.path === path));
    t.diagnostic(JSON.stringify({ seed, files: files.length, oracleIssues: oracleIssues.length,
      nativeIssues: nativeIssues.length, missing, extra, unsafeCleanFiles }));

    await t.test('aggregate failing output and suggestions match byte for byte', () => {
      sameResult(hybrid(list), oracle(list));
    });
    for (const [index, path] of unsafeCleanFiles.entries()) {
      await t.test(`false clean probe ${path.split('/').at(-1)} invokes the oracle`, async () => {
        const single = resolve(workspace, `single-${index}.txt`);
        await writeFile(single, `${path}\n`);
        sameResult(hybrid(single), oracle(single));
      });
    }
    await t.test('direct native detection, location, and order parity', () => {
      assert.deepEqual(nativeIssues, oracleIssues, 'native semantic gaps remain; do not promote the fast path');
    });
  } finally {
    for (const directory of [workspace, documents, scripts]) await rm(directory, { recursive: true, force: true });
  }
});
