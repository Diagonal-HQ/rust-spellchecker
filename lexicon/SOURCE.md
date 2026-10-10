# Lexicon source

`lexicon.txt` is fixed data. It was extracted once from CSpell's dictionaries, and this repository has no code that regenerates it. This file records how it was built, so it can be audited or rebuilt.

## Inputs

- `cspell` and `cspell-lib` 10.1.1.
- The dictionary package versions listed in [`NOTICE.md`](NOTICE.md). Those are the packages that contribute words.
- This CSpell configuration, with no project words:

  ```json
  {
    "version": "0.2",
    "language": "en",
    "dictionaries": ["software-terms", "node", "typescript", "html", "css", "php", "fonts"]
  }
  ```

## Extraction

The extraction script is `scripts/spellcheck-rust/prepare-dictionary.mjs` at commit `7838b9f` (`git show 7838b9f:scripts/spellcheck-rust/prepare-dictionary.mjs`). It runs under Node with the CSpell packages above installed. For each language ID (`typescriptreact`, `php`, `html`, `markdown`), it:

1. Resolves the final CSpell settings for an empty document with that ID under the configuration above, then loads the dictionary collection for those settings.
2. Takes every word from every dictionary in the collection that has a trie, keeping a word only if the merged collection accepts it (`collection.has(word)`). Forbidden and flagged words drop out at this step.
3. Lower-cases each word with the `en-US` locale and replaces `’` and `` ` `` with `'`.
4. Records each word from the `coding-compound-terms` dictionary that contains a `+` as an `@compound` entry, lower-cased.

The output is the union of all four passes: `@compound<TAB>part` lines first, then the words, each group deduplicated and sorted with `localeCompare(…, 'en-US')`.

## Rebuilding

The script resolves `cspell.json` and `package-lock.json` from the directory two levels above itself, and it loads CSpell from that directory's `node_modules`. This lays out a working directory to match:

```sh
work=$(mktemp -d)
mkdir -p "$work/scripts/spellcheck-rust"
git show 7838b9f:scripts/spellcheck-rust/prepare-dictionary.mjs \
  > "$work/scripts/spellcheck-rust/prepare-dictionary.mjs"
cat > "$work/cspell.json" <<'JSON'
{
  "version": "0.2",
  "language": "en",
  "dictionaries": ["software-terms", "node", "typescript", "html", "css", "php", "fonts"]
}
JSON
# Pins every contributing dictionary to its NOTICE.md version. Without the overrides,
# npm resolves newer dictionary releases and the word list differs.
cat > "$work/package.json" <<'JSON'
{
  "private": true,
  "dependencies": { "cspell": "10.1.1" },
  "overrides": {
    "@cspell/dict-aws": "4.0.17",
    "@cspell/dict-companies": "3.2.12",
    "@cspell/dict-cryptocurrencies": "5.0.5",
    "@cspell/dict-css": "4.1.2",
    "@cspell/dict-django": "4.1.6",
    "@cspell/dict-en_us": "4.4.36",
    "@cspell/dict-filetypes": "3.0.18",
    "@cspell/dict-fonts": "4.0.6",
    "@cspell/dict-fullstack": "3.2.9",
    "@cspell/dict-html": "4.0.16",
    "@cspell/dict-html-symbol-entities": "4.0.5",
    "@cspell/dict-node": "5.0.9",
    "@cspell/dict-npm": "5.2.47",
    "@cspell/dict-php": "4.1.1",
    "@cspell/dict-public-licenses": "2.0.16",
    "@cspell/dict-software-terms": "5.4.1",
    "@cspell/dict-typescript": "3.2.3"
  }
}
JSON
cd "$work"
npm install --ignore-scripts --no-audit --no-fund   # also writes package-lock.json
node scripts/spellcheck-rust/prepare-dictionary.mjs lexicon.txt
```

`lexicon.txt` in `$work` then has the script's metadata header followed by the word list. Replace that header with the four comment lines at the top of the current `lexicon/lexicon.txt`. The word list then matches the current one exactly; this recipe was checked byte-for-byte against the committed lexicon. Regenerate `NOTICE.md` from the same installed packages, and update the versions in this file.
