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

To rebuild, check out that script, run it in a directory containing the configuration above and the pinned packages, and replace its metadata header with the four comment lines at the top of the current `lexicon.txt`. The result should match the current word list exactly. Regenerate `NOTICE.md` from the same installed packages, and update the versions in this file.
