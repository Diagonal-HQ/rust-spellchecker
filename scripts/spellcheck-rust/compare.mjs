#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const fixtureDirectory = resolve(scriptDirectory, 'fixtures');
const fixtureFiles = [
  'sample.blade.php',
  'sample.md',
  'sample.php',
  'sample.ts',
  'sample.tsx',
].map((file) => resolve(fixtureDirectory, file));
const typosConfig = resolve(scriptDirectory, 'typos.toml');
const shadow = process.argv.includes('--shadow');
const json = process.argv.includes('--json');

const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const typosBinary = process.env.TYPOS_BIN ?? 'typos';

function run(binary, arguments_) {
  const started = process.hrtime.bigint();
  const result = spawnSync(binary, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;

  if (result.error) {
    throw new Error(`Could not run ${binary}: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${binary} terminated with signal ${result.signal}`);
  }

  return { ...result, elapsedMilliseconds };
}

function version(binary) {
  const result = run(binary, ['--version']);
  return result.stdout.trim() || result.stderr.trim();
}

function repositoryPath(path) {
  const absolutePath = path.startsWith('file:') ? fileURLToPath(path) : resolve(repositoryRoot, path);
  return relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
}

function characterColumn(path, row, byteOffset) {
  const line = readFileSync(resolve(repositoryRoot, path)).toString('utf8').split(/\r?\n/u)[row - 1] ?? '';
  const prefix = Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8');
  return [...prefix].length + 1;
}

function normalizeCspell(report) {
  return report.issues.map((issue) => ({
    path: repositoryPath(issue.uri),
    row: issue.row,
    col: issue.col,
    word: issue.text,
    suggestions: issue.suggestions ?? [],
  }));
}

function normalizeTypos(output) {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'typo')
    .map((record) => {
      const path = repositoryPath(record.path);
      return {
        path,
        row: record.line_num,
        col: characterColumn(path, record.line_num, record.byte_offset),
        word: record.typo,
        suggestions: record.corrections ?? [],
      };
    });
}

function key(issue) {
  return `${issue.path}:${issue.row}:${issue.col}:${issue.word}`;
}

function indexByKey(issues) {
  return new Map(issues.map((issue) => [key(issue), issue]));
}

function compare(cspellIssues, typosIssues) {
  const cspellIndex = indexByKey(cspellIssues);
  const typosIndex = indexByKey(typosIssues);
  const missing = cspellIssues.filter((issue) => !typosIndex.has(key(issue)));
  const extra = typosIssues.filter((issue) => !cspellIndex.has(key(issue)));
  const suggestionMismatches = cspellIssues
    .filter((issue) => typosIndex.has(key(issue)))
    .filter((issue) => JSON.stringify(issue.suggestions) !== JSON.stringify(typosIndex.get(key(issue)).suggestions))
    .map((issue) => ({
      issue: key(issue),
      cspell: issue.suggestions,
      typos: typosIndex.get(key(issue)).suggestions,
    }));
  const commonCspellOrder = cspellIssues.filter((issue) => typosIndex.has(key(issue))).map(key);
  const commonTyposOrder = typosIssues.filter((issue) => cspellIndex.has(key(issue))).map(key);

  return {
    equivalent:
      missing.length === 0 &&
      extra.length === 0 &&
      suggestionMismatches.length === 0 &&
      JSON.stringify(commonCspellOrder) === JSON.stringify(commonTyposOrder),
    missing,
    extra,
    suggestionMismatches,
    orderMatches: JSON.stringify(commonCspellOrder) === JSON.stringify(commonTyposOrder),
  };
}

function printIssues(label, issues) {
  console.log(`${label} (${issues.length})`);
  for (const issue of issues) {
    console.log(`  ${key(issue)}`);
  }
}

try {
  const cspellVersion = version(cspellBinary);
  const typosVersion = version(typosBinary);
  const cspell = run(cspellBinary, [
    'lint',
    ...fixtureFiles,
    '--config',
    'cspell.json',
    '--no-progress',
    '--show-suggestions',
    '--reporter',
    '@cspell/cspell-json-reporter',
  ]);
  const typos = run(typosBinary, [
    '--config',
    typosConfig,
    '--isolated',
    '--force-exclude',
    '--format',
    'json',
    '--sort',
    '--color',
    'never',
    ...fixtureFiles,
  ]);

  if (![0, 1].includes(cspell.status)) {
    throw new Error(`CSpell returned unexpected exit code ${cspell.status}: ${cspell.stderr.trim()}`);
  }
  if (![0, 2].includes(typos.status)) {
    throw new Error(`typos returned unexpected exit code ${typos.status}: ${typos.stderr.trim()}`);
  }

  const cspellReport = JSON.parse(cspell.stdout);
  const cspellIssues = normalizeCspell(cspellReport);
  const typosIssues = normalizeTypos(typos.stdout);
  const comparison = compare(cspellIssues, typosIssues);
  const exitSemanticsMatch =
    (cspell.status === 0 && typos.status === 0) || (cspell.status === 1 && typos.status === 2);
  const report = {
    engines: { cspell: cspellVersion, typos: typosVersion },
    exits: { cspell: cspell.status, typos: typos.status, semanticClassMatches: exitSemanticsMatch },
    milliseconds: {
      cspell: Number(cspell.elapsedMilliseconds.toFixed(2)),
      typos: Number(typos.elapsedMilliseconds.toFixed(2)),
    },
    counts: { cspell: cspellIssues.length, typos: typosIssues.length },
    ...comparison,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`CSpell ${cspellVersion}: ${cspellIssues.length} issues, exit ${cspell.status}, ${report.milliseconds.cspell} ms`);
    console.log(`typos ${typosVersion}: ${typosIssues.length} issues, exit ${typos.status}, ${report.milliseconds.typos} ms`);
    console.log(`Equivalent: ${report.equivalent ? 'yes' : 'no'}`);
    printIssues('Missing from typos', comparison.missing);
    printIssues('Extra in typos', comparison.extra);
    console.log(`Suggestion mismatches: ${comparison.suggestionMismatches.length}`);
    console.log(`Common-issue order matches: ${comparison.orderMatches ? 'yes' : 'no'}`);
    console.log(`Exit semantic class matches: ${exitSemanticsMatch ? 'yes' : 'no'} (CSpell uses 1; typos uses 2 for findings)`);
  }

  if (!comparison.equivalent && !shadow) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
