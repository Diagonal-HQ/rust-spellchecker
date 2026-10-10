#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const repositoryRoot = resolve(scriptDirectory, '../..');
const expectedLanguageIds = 'typescriptreact,php,html,markdown';
const engines = JSON.parse(readFileSync(resolve(scriptDirectory, 'engines.json'), 'utf8'));
const cspellBinary = process.env.CSPELL_BIN ?? resolve(repositoryRoot, 'node_modules/.bin/cspell');
const nativeBinary =
  process.env.RUST_SPELL_BIN ?? resolve(scriptDirectory, 'native/target/release/diagonal-spellcheck');
const dictionary =
  process.env.RUST_SPELL_DICTIONARY ?? resolve(scriptDirectory, 'native/target/cspell-lexicon.txt');
const configArgument = process.env.CSPELL_CONFIG ?? 'cspell.json';
const configPath = resolve(repositoryRoot, configArgument);
const cspellInstallLock =
  process.env.CSPELL_INSTALL_LOCK ?? resolve(dirname(cspellBinary), '../..', 'package-lock.json');

let fileList;
let verifyClean = false;
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--file-list=') && !fileList) {
    fileList = argument.slice('--file-list='.length);
  } else if (argument === '--verify-clean' && !verifyClean) {
    verifyClean = true;
  } else {
    console.error(`unknown or duplicate option ${argument}`);
    console.error('usage: node scripts/spellcheck-rust/hybrid.mjs --file-list=PATH [--verify-clean]');
    process.exit(2);
  }
}

if (!fileList || fileList === '-') {
  console.error('usage: node scripts/spellcheck-rust/hybrid.mjs --file-list=PATH [--verify-clean]');
  process.exit(2);
}
fileList = resolve(repositoryRoot, fileList);

function run(binary, arguments_, input) {
  return spawnSync(binary, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    input,
  });
}

function relayCspell() {
  const cspell = run(cspellBinary, [
    'lint',
    '**',
    '--file-list',
    fileList,
    '--config',
    configArgument,
    '--no-progress',
    '--show-suggestions',
  ]);
  if (cspell.error) {
    console.error(`Could not run ${cspellBinary}: ${cspell.error.message}`);
    process.exit(2);
  }
  if (cspell.signal) {
    console.error(`${cspellBinary} terminated with signal ${cspell.signal}`);
    process.exit(2);
  }
  process.stdout.write(cspell.stdout);
  process.stderr.write(cspell.stderr);
  process.exit(cspell.status);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of value) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function nativeIsCurrent() {
  try {
    const provenance = run(nativeBinary, ['--provenance']);
    if (provenance.error || provenance.signal || provenance.status !== 0) return false;
    const expected = [
      ['main.rs', resolve(scriptDirectory, 'native/src/main.rs')],
      ['Cargo.toml', resolve(scriptDirectory, 'native/Cargo.toml')],
      ['Cargo.lock', resolve(scriptDirectory, 'native/Cargo.lock')],
    ]
      .map(([name, path]) => `${name}.fnv1a64=${fnv1a64(readFileSync(path))}`)
      .join('\n');
    return provenance.stdout.trim() === expected;
  } catch {
    return false;
  }
}

function dictionaryIsCurrent() {
  try {
    // Regenerating a lexicon does not establish support for new config semantics or imports.
    if (configPath !== resolve(repositoryRoot, 'cspell.json') ||
        sha256(readFileSync(configPath)) !== engines.native.supportedConfigSha256) return false;
    const content = readFileSync(dictionary, 'utf8');
    const lines = content.split('\n');
    const bodyIndex = lines.findIndex((line) => !line.startsWith('#'));
    if (bodyIndex < 0) return false;

    const metadata = new Map();
    for (const line of lines.slice(0, bodyIndex)) {
      const match = /^# ([^=]+)=(.*)$/u.exec(line);
      if (!match) continue;
      if (metadata.has(match[1])) return false;
      metadata.set(match[1], match[2]);
    }

    const version = run(cspellBinary, ['--version']);
    if (version.error || version.signal || version.status !== 0) return false;
    if (version.stdout.trim() !== engines.oracle.version) return false;
    const body = lines.slice(bodyIndex).join('\n');
    const expected = new Map([
      ['format', '2'],
      ['cspell', version.stdout.trim()],
      ['cspell.json.sha256', sha256(readFileSync(configPath))],
      ['package-lock.json.sha256', sha256(readFileSync(resolve(repositoryRoot, 'package-lock.json')))],
      ['cspell-install.package-lock.sha256', sha256(readFileSync(cspellInstallLock))],
      [
        'prepare-dictionary.mjs.sha256',
        sha256(readFileSync(resolve(scriptDirectory, 'prepare-dictionary.mjs'))),
      ],
      ['languageIds', expectedLanguageIds],
      ['entries.sha256', sha256(body)],
    ]);
    return (
      metadata.has('dictionaries') &&
      metadata.get('dictionaries').length > 0 &&
      [...expected].every(([key, value]) => metadata.get(key) === value)
    );
  } catch {
    return false;
  }
}

function isProductionPath(path) {
  return (
    ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'].includes(path) ||
    /^resources\/js\/.+\.(?:ts|tsx)$/u.test(path) ||
    /^app\/[^/]+\/resources\/js\/.+\.(?:ts|tsx)$/u.test(path) ||
    /^app\/[^/]+\/src\/.+\.php$/u.test(path) ||
    /^app\/[^/]+\/resources\/views\/.+\.blade\.php$/u.test(path) ||
    /^docs\/.+\.md$/u.test(path) ||
    /^product-documentation\/.+\.md$/u.test(path) ||
    /^app\/[^/]+\/README\.md$/u.test(path)
  );
}

function isIgnoredPath(path) {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return (
    path.startsWith('app/ai/eval-comparisons/') ||
    path.split('/').includes('generated') ||
    basename.includes('.generated.') ||
    basename.endsWith('.d.ts') ||
    basename.endsWith('.min.js') ||
    basename.endsWith('.snap') ||
    basename.endsWith('.test.ts') ||
    basename.endsWith('.test.tsx') ||
    basename.endsWith('Test.php') ||
    path === 'resources/js/lib/icons-data.ts'
  );
}

function trustedFiles() {
  try {
    const lines = readFileSync(fileList, 'utf8').split(/\r?\n/u).filter(Boolean);
    if (lines.length === 0 || lines.some((line) => !isAbsolute(line))) return undefined;
    const seen = new Set();
    for (const line of lines) {
      const absolute = resolve(line);
      const repositoryPath = relative(repositoryRoot, absolute).replaceAll('\\', '/');
      if (
        repositoryPath.startsWith('../') ||
        repositoryPath === '..' ||
        seen.has(absolute) ||
        !isProductionPath(repositoryPath) ||
        isIgnoredPath(repositoryPath) ||
        !statSync(absolute).isFile() ||
        realpathSync(absolute) !== absolute
      ) {
        return undefined;
      }
      accessSync(absolute, constants.R_OK);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolute));
      // In-document settings can change dictionaries, case, flags, and checked ranges.
      if (/\b(?:c?spell(?:-?checker)?|spell-?checker)::?|\bLocalWords:?/iu.test(text)) {
        return undefined;
      }
      seen.add(absolute);
    }
    return [...seen];
  } catch {
    return undefined;
  }
}

const files = trustedFiles();
if (verifyClean || !files || !dictionaryIsCurrent() || !nativeIsCurrent()) relayCspell();

const native = run(nativeBinary, ['--dictionary', dictionary, '--file-list', '-'], `${files.join('\n')}\n`);
if (native.error || native.signal || ![0, 1].includes(native.status)) relayCspell();

if (native.status === 0) {
  if (native.stdout !== '' || native.stderr !== '') relayCspell();
  process.stderr.write(`CSpell: Files checked: ${files.length}, Issues found: 0 in 0 files.\n`);
  process.exit(0);
}

// Exact diagnostics and suggestions remain owned by the pinned oracle.
relayCspell();
