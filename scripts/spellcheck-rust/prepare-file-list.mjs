#!/usr/bin/env node

import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  console.error('usage: node scripts/spellcheck-rust/prepare-file-list.mjs INPUT OUTPUT');
  process.exit(2);
}

const input = resolve(repositoryRoot, inputArgument);
const output = resolve(repositoryRoot, outputArgument);
const entries = (await readFile(input, 'utf8')).split(/\r?\n/u).filter(Boolean);
const seen = new Set();
const absoluteEntries = [];
for (const entry of entries) {
  const absolute = isAbsolute(entry) ? resolve(entry) : resolve(repositoryRoot, entry);
  const repositoryPath = relative(repositoryRoot, absolute);
  if (repositoryPath === '..' || repositoryPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`path is outside the repository: ${entry}`);
  }
  if (seen.has(absolute)) throw new Error(`duplicate path: ${entry}`);
  if (!(await stat(absolute)).isFile()) throw new Error(`path is not a file: ${entry}`);
  if ((await realpath(absolute)) !== absolute) throw new Error(`symbolic links are unsupported: ${entry}`);
  seen.add(absolute);
  absoluteEntries.push(absolute);
}

await writeFile(output, `${absoluteEntries.join('\n')}\n`);
console.log(`Wrote ${absoluteEntries.length} absolute paths to ${output}`);
