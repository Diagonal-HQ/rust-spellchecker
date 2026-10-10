import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const targetRoot = resolve(repositoryRoot, 'scripts/spellcheck-rust/native/target');
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const nativeBinary =
  process.env.RUST_SPELL_BIN ?? resolve(targetRoot, 'release/diagonal-spellcheck');
const dictionary = process.env.RUST_SPELL_DICTIONARY ?? resolve(targetRoot, 'cspell-lexicon.txt');
const fixtures = [
  'scripts/spellcheck-rust/fixtures/parity.php',
  'scripts/spellcheck-rust/fixtures/parity.ts',
  'scripts/spellcheck-rust/fixtures/sample.blade.php',
  'scripts/spellcheck-rust/fixtures/sample.md',
  'scripts/spellcheck-rust/fixtures/sample.php',
  'scripts/spellcheck-rust/fixtures/sample.ts',
  'scripts/spellcheck-rust/fixtures/sample.tsx',
];
const cleanFiles = [
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

function run(binary, arguments_, env = process.env) {
  return spawnSync(binary, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function oracle(fileList, config = 'cspell.json') {
  return run(cspellBinary, [
    'lint',
    '**',
    '--file-list',
    fileList,
    '--config',
    config,
    '--no-progress',
    '--show-suggestions',
  ]);
}

function hybrid(fileList, overrides = {}, arguments_ = []) {
  return run(
    process.execPath,
    ['scripts/spellcheck-rust/hybrid.mjs', `--file-list=${fileList}`, ...arguments_],
    {
      ...process.env,
      CSPELL_BIN: cspellBinary,
      RUST_SPELL_BIN: nativeBinary,
      RUST_SPELL_DICTIONARY: dictionary,
      ...overrides,
    },
  );
}

function assertSameResult(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.stderr, expected.stderr);
}

test('hybrid failing output, suggestions, and exit code are byte-identical to CSpell', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-'));
  try {
    const fileList = resolve(directory, 'fixtures.txt');
    await writeFile(
      fileList,
      `${fixtures.map((fixture) => resolve(repositoryRoot, fixture)).join('\n')}\n`,
    );
    const expected = oracle(fileList);
    const actual = hybrid(fileList);
    assert.equal(expected.status, 1);
    assert.match(expected.stdout, /recieve/u);
    assert.doesNotMatch(expected.stdout, /File not found/u);
    assertSameResult(actual, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hybrid clean output and exit code are byte-identical to CSpell', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-clean-'));
  try {
    const fileList = resolve(directory, 'fixtures.txt');
    await writeFile(
      fileList,
      `${cleanFiles.map((file) => resolve(repositoryRoot, file)).join('\n')}\n`,
    );
    const expected = oracle(fileList);
    const actual = hybrid(fileList);
    assert.equal(expected.status, 0);
    assertSameResult(actual, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hybrid clean fast path validates CSpell version without invoking lint', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-fast-'));
  try {
    const fileList = resolve(directory, 'files.txt');
    const fakeCspell = resolve(directory, 'cspell.mjs');
    await writeFile(
      fileList,
      `${cleanFiles.map((file) => resolve(repositoryRoot, file)).join('\n')}\n`,
    );
    await writeFile(
      fakeCspell,
      `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('10.1.1'); process.exit(0); }\nconsole.error('oracle lint unexpectedly invoked'); process.exit(88);\n`,
    );
    await chmod(fakeCspell, 0o755);
    const result = hybrid(fileList, {
      CSPELL_BIN: fakeCspell,
      CSPELL_INSTALL_LOCK: resolve(dirname(cspellBinary), '../..', 'package-lock.json'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CSpell: Files checked: 3, Issues found: 0 in 0 files.\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale, headerless, modified, and missing dictionaries cannot authorize a clean result', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const productionDirectory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-provenance-'));
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-provenance-'));
  try {
    const typoFile = resolve(productionDirectory, 'typo.md');
    const fileList = resolve(directory, 'files.txt');
    await writeFile(typoFile, 'recieve\n');
    await writeFile(fileList, `${typoFile}\n`);
    const expected = oracle(fileList);
    assert.equal(expected.status, 1);
    assert.match(expected.stdout, /recieve/u);

    const original = await readFile(dictionary, 'utf8');
    const headerless = original
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith('#'))
      .join('\n') + 'recieve\n';
    const modified = `${original}recieve\n`;
    const bodyIndex = original.split('\n').findIndex((line) => !line.startsWith('#'));
    const staleLines = original.split('\n');
    const staleBody = `${staleLines.slice(bodyIndex).join('\n')}recieve\n`;
    const stale = [
      ...staleLines
        .slice(0, bodyIndex)
        .map((line) =>
          line.startsWith('# cspell.json.sha256=')
            ? `# cspell.json.sha256=${'0'.repeat(64)}`
            : line.startsWith('# entries.sha256=')
              ? `# entries.sha256=${createHash('sha256').update(staleBody).digest('hex')}`
              : line,
        ),
      staleBody,
    ].join('\n');

    for (const [name, content] of [
      ['headerless', headerless],
      ['modified', modified],
      ['stale', stale],
    ]) {
      const candidate = resolve(directory, `${name}.txt`);
      await writeFile(candidate, content);
      assertSameResult(hybrid(fileList, { RUST_SPELL_DICTIONARY: candidate }), expected);
    }
    assertSameResult(
      hybrid(fileList, { RUST_SPELL_DICTIONARY: resolve(directory, 'missing.txt') }),
      expected,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(productionDirectory, { recursive: true, force: true });
  }
});

test('a stale or unidentifiable native binary cannot authorize a clean result', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const productionDirectory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-binary-'));
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-binary-'));
  try {
    const typoFile = resolve(productionDirectory, 'typo.md');
    const fileList = resolve(directory, 'files.txt');
    const fakeNative = resolve(directory, 'native.mjs');
    await writeFile(typoFile, 'recieve\n');
    await writeFile(fileList, `${typoFile}\n`);
    await writeFile(
      fakeNative,
      `#!/usr/bin/env node\nif (process.argv.includes('--provenance')) { console.log('stale'); process.exit(0); }\nprocess.exit(0);\n`,
    );
    await chmod(fakeNative, 0o755);
    const expected = oracle(fileList);
    assert.equal(expected.status, 1);
    assertSameResult(hybrid(fileList, { RUST_SPELL_BIN: fakeNative }), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(productionDirectory, { recursive: true, force: true });
  }
});

test('changed and malformed CSpell config always use the oracle', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const productionDirectory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-config-'));
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-config-'));
  try {
    const source = resolve(productionDirectory, 'source.md');
    const fileList = resolve(directory, 'files.txt');
    await writeFile(source, 'Diagonal\n');
    await writeFile(fileList, `${source}\n`);
    const changedConfig = resolve(directory, 'changed.json');
    const config = JSON.parse(await readFile(resolve(repositoryRoot, 'cspell.json'), 'utf8'));
    config.flagWords = ['Diagonal'];
    await writeFile(changedConfig, `${JSON.stringify(config)}\n`);
    const changedExpected = oracle(fileList, changedConfig);
    assert.equal(changedExpected.status, 1);
    assertSameResult(
      hybrid(fileList, { CSPELL_CONFIG: changedConfig }),
      changedExpected,
    );

    const malformedConfig = resolve(directory, 'malformed.json');
    await writeFile(malformedConfig, '{');
    const malformedExpected = oracle(fileList, malformedConfig);
    assertSameResult(
      hybrid(fileList, { CSPELL_CONFIG: malformedConfig }),
      malformedExpected,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(productionDirectory, { recursive: true, force: true });
  }
});

test('relative entries delegate to CSpell and preserve list-directory resolution', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-relative-'));
  try {
    const fileList = resolve(directory, 'files.txt');
    await writeFile(resolve(directory, 'README.md'), 'recieve\n');
    await writeFile(fileList, 'README.md\n');
    const expected = oracle(fileList);
    assert.equal(expected.status, 1);
    assert.match(expected.stdout, /recieve/u);
    assertSameResult(hybrid(fileList), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ambiguous, ignored, unsupported, missing, and unreadable paths fail closed to CSpell', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const productionDirectory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-paths-'));
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-paths-'));
  try {
    const clean = resolve(productionDirectory, 'clean.md');
    const ignored = resolve(productionDirectory, 'ignored.generated.md');
    const unsupported = resolve(productionDirectory, 'unsupported.txt');
    const unreadable = resolve(productionDirectory, 'unreadable.md');
    await writeFile(clean, 'Diagonal\n');
    await writeFile(ignored, 'recieve\n');
    await writeFile(unsupported, 'recieve\n');
    await writeFile(unreadable, 'recieve\n');
    await chmod(unreadable, 0o000);

    const cases = [
      ['duplicate', [clean, clean]],
      ['ignored', [ignored]],
      ['unsupported', [unsupported]],
      ['missing-or-renamed', [resolve(productionDirectory, 'missing.md')]],
      ['glob', [resolve(repositoryRoot, 'docs/*.md')]],
      ['unreadable', [unreadable]],
    ];
    for (const [name, paths] of cases) {
      const fileList = resolve(directory, `${name}.txt`);
      await writeFile(fileList, `${paths.join('\n')}\n`);
      assertSameResult(hybrid(fileList), oracle(fileList));
    }
    await chmod(unreadable, 0o600);
  } finally {
    await chmod(resolve(productionDirectory, 'unreadable.md'), 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    await rm(productionDirectory, { recursive: true, force: true });
  }
});

test('unknown and duplicate hybrid options fail with usage', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, () => {
  for (const arguments_ of [
    ['--unknown'],
    ['--file-list=a', '--file-list=b'],
    ['--file-list=-'],
  ]) {
    const result = run(process.execPath, ['scripts/spellcheck-rust/hybrid.mjs', ...arguments_]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/u);
  }
});

test('in-document settings cannot authorize a false clean native result', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-directives-'));
  try {
    const source = resolve(directory, 'source.md');
    const list = resolve(directory, 'files.txt');
    await writeFile(source, '<!-- cspell:forbid hello -->\nhello\n');
    await writeFile(list, `${source}\n`);
    const candidate = run(nativeBinary, ['--dictionary', dictionary, source]);
    assert.equal(candidate.status, 0, candidate.stderr);
    const expected = oracle(list);
    assert.equal(expected.status, 1);
    assert.match(expected.stdout, /hello/u);
    assertSameResult(hybrid(list), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inherited config and external dictionary edits always remain owned by CSpell', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-inheritance-'));
  try {
    const source = resolve(directory, 'source.md');
    const list = resolve(directory, 'files.txt');
    const parent = resolve(directory, 'parent.json');
    const child = resolve(directory, 'child.json');
    const customDictionary = resolve(directory, 'custom.txt');
    await writeFile(source, 'recieve\n');
    await writeFile(list, `${source}\n`);
    await writeFile(customDictionary, 'recieve\n');
    await writeFile(parent, JSON.stringify({
      version: '0.2', language: 'en',
      dictionaryDefinitions: [{ name: 'pilot-custom', path: './custom.txt' }],
      dictionaries: ['pilot-custom'],
    }));
    await writeFile(child, JSON.stringify({ version: '0.2', import: ['./parent.json'] }));
    const accepted = oracle(list, child);
    assert.equal(accepted.status, 0, accepted.stderr);
    assertSameResult(hybrid(list, { CSPELL_CONFIG: child }), accepted);
    await writeFile(customDictionary, 'hello\n');
    const rejected = oracle(list, child);
    assert.equal(rejected.status, 1, rejected.stderr);
    assertSameResult(hybrid(list, { CSPELL_CONFIG: child }), rejected);
    await writeFile(parent, JSON.stringify({ version: '0.2', flagWords: ['recieve'] }));
    assertSameResult(hybrid(list, { CSPELL_CONFIG: child }), oracle(list, child));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('nested lists, dot segments, whitespace, BOM, and symbolic links preserve oracle resolution', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-nested-'));
  try {
    await mkdir(resolve(directory, 'nested/deeper'), { recursive: true });
    const source = resolve(directory, 'source.md');
    const link = resolve(directory, 'linked.md');
    await writeFile(source, 'recieve\n');
    await symlink(source, link);
    for (const [index, text] of [
      '../source.md\n', './deeper/../../source.md\r\n',
      `${source}\r\n\r\n`, ` ${source}\n`, `\ufeff${source}\n`, `${link}\n`, '',
    ].entries()) {
      const list = resolve(directory, `nested/list-${index}.txt`);
      await writeFile(list, text);
      assertSameResult(hybrid(list), oracle(list));
    }
    const absent = resolve(directory, 'nested/absent.txt');
    assertSameResult(hybrid(absent), oracle(absent));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every dictionary provenance field is required and duplicate metadata is rejected', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-metadata-'));
  try {
    const source = resolve(directory, 'source.md');
    const list = resolve(directory, 'files.txt');
    await writeFile(source, 'recieve\n');
    await writeFile(list, `${source}\n`);
    const expected = oracle(list);
    assert.equal(expected.status, 1);
    const original = await readFile(dictionary, 'utf8');
    const lines = original.split('\n');
    const bodyIndex = lines.findIndex((line) => !line.startsWith('#'));
    const body = `${lines.slice(bodyIndex).join('\n')}recieve\n`;
    const poisoned = `${lines.slice(0, bodyIndex).map((line) => line.startsWith('# entries.sha256=')
      ? `# entries.sha256=${createHash('sha256').update(body).digest('hex')}` : line).join('\n')}\n${body}`;
    const poisonedPath = resolve(directory, 'poisoned.txt');
    await writeFile(poisonedPath, poisoned);
    assert.equal(run(nativeBinary, ['--dictionary', poisonedPath, source]).status, 0);
    const metadata = poisoned.split('\n').filter((line) => /^# [^=]+=/u.test(line));
    assert.equal(metadata.length, 9);
    for (const [index, line] of metadata.entries()) {
      const path = resolve(directory, `missing-${index}.txt`);
      await writeFile(path, poisoned.replace(`${line}\n`, ''));
      assertSameResult(hybrid(list, { RUST_SPELL_DICTIONARY: path }), expected);
    }
    const duplicate = resolve(directory, 'duplicate.txt');
    await writeFile(duplicate, `${metadata[0]}\n${poisoned}`);
    assertSameResult(hybrid(list, { RUST_SPELL_DICTIONARY: duplicate }), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native errors, signals, and unexpected clean output delegate to CSpell', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(repositoryRoot, 'docs/spellcheck-rust-failures-'));
  try {
    const source = resolve(directory, 'source.md');
    const list = resolve(directory, 'files.txt');
    const fake = resolve(directory, 'native.mjs');
    await writeFile(source, 'recieve\n');
    await writeFile(list, `${source}\n`);
    const provenance = run(nativeBinary, ['--provenance']);
    assert.equal(provenance.status, 0);
    const expected = oracle(list);
    assert.equal(expected.status, 1);
    for (const body of [
      'process.exit(2);', 'process.kill(process.pid, "SIGTERM");',
      'console.log("unexpected output");', 'console.error("unexpected warning");',
    ]) {
      await writeFile(fake, `#!/usr/bin/env node\nif (process.argv.includes('--provenance')) { process.stdout.write(${JSON.stringify(provenance.stdout)}); process.exit(0); }\n${body}\n`);
      await chmod(fake, 0o755);
      assertSameResult(hybrid(list, { RUST_SPELL_BIN: fake }), expected);
    }
    assertSameResult(hybrid(list, { RUST_SPELL_BIN: resolve(directory, 'missing-native') }), expected);
    const absentOracle = hybrid(list, { CSPELL_BIN: resolve(directory, 'missing-cspell') });
    assert.equal(absentOracle.status, 2);
    assert.match(absentOracle.stderr, /Could not run/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verify-clean explicitly invokes the oracle on otherwise clean inputs', { skip: missing.length ? `missing ${missing.join(', ')}` : false }, async () => {
  const directory = await mkdtemp(resolve(targetRoot, 'hybrid-verify-'));
  try {
    const list = resolve(directory, 'files.txt');
    await writeFile(list, `${cleanFiles.map((file) => resolve(repositoryRoot, file)).join('\n')}\n`);
    assertSameResult(hybrid(list, {}, ['--verify-clean']), oracle(list));
    const fake = resolve(directory, 'cspell.mjs');
    await writeFile(fake, '#!/usr/bin/env node\nconsole.log("oracle invoked"); process.exit(73);\n');
    await chmod(fake, 0o755);
    const result = hybrid(list, { CSPELL_BIN: fake }, ['--verify-clean']);
    assert.equal(result.status, 73);
    assert.equal(result.stdout, 'oracle invoked\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
