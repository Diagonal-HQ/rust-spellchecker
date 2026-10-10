#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const shadow = process.argv.includes('--shadow');
const json = process.argv.includes('--json');
const fileListArgument = process.argv.find((argument) => argument.startsWith('--file-list='));
const fileList = fileListArgument?.slice('--file-list='.length);
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const nativeBinary =
  process.env.RUST_SPELL_BIN ?? resolve(scriptDirectory, 'native/target/release/diagonal-spellcheck');
const dictionary =
  process.env.RUST_SPELL_DICTIONARY ?? resolve(scriptDirectory, 'native/target/cspell-lexicon.txt');
const fixtureFiles = [
  'scripts/spellcheck-rust/fixtures/parity.php',
  'scripts/spellcheck-rust/fixtures/parity.ts',
  'scripts/spellcheck-rust/fixtures/sample.blade.php',
  'scripts/spellcheck-rust/fixtures/sample.md',
  'scripts/spellcheck-rust/fixtures/sample.php',
  'scripts/spellcheck-rust/fixtures/sample.ts',
  'scripts/spellcheck-rust/fixtures/sample.tsx',
];

function run(binary, arguments_) {
  const started = process.hrtime.bigint();
  const result = spawnSync(binary, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const milliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (result.error) throw new Error(`Could not run ${binary}: ${result.error.message}`);
  if (result.signal) throw new Error(`${binary} terminated with signal ${result.signal}`);
  return { ...result, milliseconds: Number(milliseconds.toFixed(2)) };
}

function repositoryPath(path) {
  const absolute = path.startsWith('file:') ? fileURLToPath(path) : resolve(repositoryRoot, path);
  return relative(repositoryRoot, absolute).replaceAll('\\', '/');
}

function key(issue) {
  return `${issue.path}:${issue.row}:${issue.col}:${issue.word}`;
}

function compare(oracle, candidate) {
  const oracleMap = new Map(oracle.map((issue) => [key(issue), issue]));
  const candidateMap = new Map(candidate.map((issue) => [key(issue), issue]));
  const missing = oracle.filter((issue) => !candidateMap.has(key(issue)));
  const extra = candidate.filter((issue) => !oracleMap.has(key(issue)));
  const detectionOrderMatches = JSON.stringify(oracle.map(key)) === JSON.stringify(candidate.map(key));
  const suggestionMismatches = oracle
    .filter((issue) => candidateMap.has(key(issue)))
    .filter((issue) => JSON.stringify(issue.suggestions) !== JSON.stringify(candidateMap.get(key(issue)).suggestions))
    .map((issue) => key(issue));
  return { missing, extra, detectionOrderMatches, suggestionMismatches };
}

try {
  const cspellArguments = [
    'lint',
    ...(fileList ? ['--file-list', fileList] : ['scripts/spellcheck-rust/fixtures/**/*']),
    '--config',
    'cspell.json',
    '--no-progress',
    '--show-suggestions',
    '--reporter',
    '@cspell/cspell-json-reporter',
  ];
  const nativeArguments = [
    '--dictionary',
    dictionary,
    ...(fileList ? ['--file-list', fileList] : fixtureFiles),
  ];
  const cspell = run(cspellBinary, cspellArguments);
  const native = run(nativeBinary, nativeArguments);
  if (![0, 1].includes(cspell.status)) {
    throw new Error(`unexpected CSpell exit ${cspell.status}: ${cspell.stderr}`);
  }
  if (![0, 1].includes(native.status)) {
    throw new Error(`unexpected native exit ${native.status}: ${native.stderr}`);
  }

  const cspellReport = JSON.parse(cspell.stdout);
  const oracle = cspellReport.issues.map((issue) => ({
    path: repositoryPath(issue.uri),
    row: issue.row,
    col: issue.col,
    word: issue.text,
    suggestions: issue.suggestions ?? [],
  }));
  const candidate = native.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((issue) => ({ ...issue, path: repositoryPath(issue.path) }));
  const comparison = compare(oracle, candidate);
  const detectionsEquivalent =
    comparison.missing.length === 0 && comparison.extra.length === 0 && comparison.detectionOrderMatches;
  const equivalent =
    detectionsEquivalent && comparison.suggestionMismatches.length === 0 && cspell.status === native.status;
  const report = {
    scope: fileList ? { fileList } : { fixtures: fixtureFiles },
    engines: {
      cspell: run(cspellBinary, ['--version']).stdout.trim(),
      native: run(nativeBinary, ['--version']).stdout.trim(),
    },
    exits: { cspell: cspell.status, native: native.status },
    milliseconds: { cspell: cspell.milliseconds, native: native.milliseconds },
    counts: { cspell: oracle.length, native: candidate.length },
    detectionsEquivalent,
    equivalent,
    ...comparison,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`CSpell: ${oracle.length} issues, exit ${cspell.status}, ${cspell.milliseconds} ms`);
    console.log(`Native: ${candidate.length} issues, exit ${native.status}, ${native.milliseconds} ms`);
    console.log(`Detection/location/order parity: ${detectionsEquivalent ? 'yes' : 'no'}`);
    console.log(`Missing: ${comparison.missing.length}; extra: ${comparison.extra.length}`);
    console.log(`Ordered suggestion mismatches: ${comparison.suggestionMismatches.length}`);
    console.log(`Full equivalence: ${equivalent ? 'yes' : 'no'}`);
  }
  if (!equivalent && !shadow) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
