# Rust spellchecker pilot

This is an opt-in differential pilot. CSpell 10.1.1 remains the oracle, the `npm run spellcheck` implementation, and the only spellchecker used by CI. Nothing here replaces it.

Status on 2026-10-10: worktree setup is incomplete. The CSpell counts, parity claims, and timing tables below are preliminary observations from the earlier session before setup completed. They are not final verification. This continuation ran only dependency-free Rust checks. The new 103-file adversarial suite, Node checks, repository spellcheck, and benchmarks remain blocked by setup. See [the local verification report](VERIFICATION.md).

## Result

The maintained Rust engines evaluated here are not drop-in CSpell replacements:

- `typos` 1.51.1 is a fast correction-database checker. It does not implement CSpell dictionaries, per-file `cspell:` directives, or CSpell's suggestion ranking.
- Harper CLI 2.12.0 is a prose grammar/spelling linter. Its PHP, Blade, TypeScript, and TSX parsers intentionally skip many identifiers and string literals that CSpell checks. It also does not implement CSpell directives.

Building a generally CSpell-compatible Rust engine would mean reproducing CSpell's parsers, compound-word and case rules, dictionary formats and precedence, directive language, URL handling, Unicode behavior, suggestion ranking, glob semantics, diagnostics, ordering, and exit behavior. The custom milestone in `native/` implements a bounded Diagonal subset. A hybrid wrapper preserves exact CSpell diagnostics on failing scans while allowing an equivalent native clean result to take the fast path.

## Custom native milestone

`native/` is a dependency-free Rust scanner. `prepare-dictionary.mjs` uses the already locked CSpell 10.1.1 packages to resolve Diagonal's configured language dictionaries and emit a sorted, lower-cased accepted-word lexicon. The generated 246,568-word, 2.47 MB lexicon is build output and is not committed. The release binary needs that lexicon at runtime but does not need Node or CSpell.

The preparation step records and the hybrid validates the CSpell version; SHA-256 of `cspell.json`, the repository lockfile, the lockfile of the CSpell installation that generated the artifact, the preparation script, and the generated entries; the selected language IDs; and the resolved dictionary names. The native binary also reports embedded hashes of its source and Cargo manifests so a stale executable cannot authorize a clean result. Missing, malformed, modified, stale, or provenance-mismatched artifacts delegate to CSpell instead of taking the fast path.

The native scanner currently implements Unicode-aware word extraction, camel-case boundaries, CSpell coding-compound-term lookup, URL/email/Markdown-target suppression, Base64 and hexadecimal suppression, PHP/regex escape handling, apostrophe normalization and possessives, date/random-string handling, minimum word length, repeated-character suppression, and the fixture forms of `cspell:words`, `cspell:ignore`, `cspell:disable-line`, `cspell:disable-next[-line]`, and block disable/enable. Columns use UTF-16 code units, as CSpell does. Native relative file-list entries resolve from the process working directory; CSpell relative entries resolve from the list directory. File discovery and the production glob/ignore contract remain external to the binary; this is not a CSpell-compatible CLI.

On the seven native contract fixtures it exactly matches all 24 CSpell detections, paths, lines, columns, ordering, and finding exit code. It intentionally emits no suggestions, so all 24 ordered suggestion lists remain mismatches and direct native equivalence remains false.

On the current main-tree input list after configured path exclusions, CSpell and the native milestone both report zero issues across the same 7,764 files. The previous 93 native extras were resolved by implementing the semantic categories above, not by adding the reported words to a broad allowlist. Three representative real files (regex-heavy PHP, hex-heavy TypeScript, and Markdown containing URLs/hashes) are copied to an ignored temporary directory and mutated with two misspellings each; both engines report the same six words, paths, lines, columns, order, and finding exit status.

That zero differential is evidence for this tree and these mutations, not proof of general CSpell compatibility. A clean false negative is the dangerous case because a native-only clean result skips the oracle. Adoption would therefore require a much larger seeded mutation corpus, periodic `--verify-clean` oracle runs, and versioned cache invalidation.

`hybrid.mjs` is the compatibility boundary. The fast path requires a provenance-valid dictionary and native binary plus an absolute, unique list of readable UTF-8, non-symlinked files inside the production path contract. It rejects configured ignored paths. Relative, duplicate, ignored, unsupported, missing, globbed, unreadable, outside-repository, and otherwise ambiguous inputs delegate to CSpell. Validated paths go to native through standard input to avoid command-line size limits and a second read of the caller's file list.

Only CSpell 10.1.1 and the exact inspected root config fingerprint in `engines.json` can authorize native clean results. New config semantics, imports, or external dictionaries always delegate, even after lexicon regeneration. Files with in-document settings also delegate, including the CSpell aliases and `LocalWords`. This is deliberate: native skips directive lines and does not implement flags, case switches, locale changes, or regular-expression directives. Its clean result is unsafe for those inputs. This guard reduces the fast-path coverage and invalidates the earlier full-corpus hybrid timings as measurements of the current wrapper.

If native finds anything, fails, emits unexpected clean output, or `--verify-clean` is requested, the hybrid invokes CSpell and relays stdout, stderr, suggestions, ordering, and exit code. On an eligible native clean scan, it reproduces CSpell's clean file-count summary and exits zero without invoking CSpell lint. Directly porting suggestions would require CSpell's weighted trie walker, dictionary-specific edit-cost maps, preferred corrections, case mapping, tie behavior, result limits, and timeout semantics. The current lower-cased lexicon loses that information. Suggestions remain owned by CSpell.

The inspected CSpell library and selected dictionary packages report MIT licenses. The pilot does not vendor their dictionary data; if a generated lexicon is later distributed or cached outside the build, its artifact must carry the applicable notices for every contributing package.

## Contract fixtures

The fixtures cover PHP, Blade, TypeScript, TSX, Markdown, identifiers, strings, fenced code, URLs, Unicode, casing, `cspell:words`, `cspell:ignore`, `cspell:disable-next-line`, generated-file exclusion, CSS hex, Base64, regex escapes/local words, underscore-separated PHP functions, coding compounds, email addresses, UUIDs/hashes, date formats, and alphabet/random strings. Every newly suppressed category has an adjacent misspelling that must remain visible.

With CSpell 10.1.1 and `typos` 1.51.1:

- CSpell reports 20 issues; `typos` reports 16.
- `typos` misses six CSpell diagnostics: `sentnce`, two occurrences of `résumé`, two occurrences of `Totl`, and `Shippng`.
- `typos` adds two `definately` diagnostics on lines disabled by CSpell directives.
- All 14 shared diagnostics have different ordered suggestion lists.
- Common diagnostics happen to retain the same order in this fixture, but the tools use different finding exit codes: CSpell uses 1 and `typos` uses 2.
- Both honor the generated-file exclusion only after the pilot adds a separate `typos.toml`; that duplication is itself a cache/configuration invalidation risk.

The config deliberately does not copy the large CSpell `words` list into a `typos` substitution table. Treating accepted project terms as typo-to-replacement mappings would change semantics and could silently rewrite text.

Harper's `SpellCheck`-only run found 12 items, but mostly in directive comments rather than the source text CSpell checks: three in PHP (`cspell`, `zorbulate`, `cspell`), none in Blade, two in TypeScript (`cspell`, `skippdword`), two in TSX (`cspell`, `Diagonalised`), and five in Markdown (`Compatability`, `sentnce`, `misspeling`, the directive-disabled `definately`, and `CSpell`). It missed the PHP/Blade/TypeScript/TSX strings and identifiers that make up most of the oracle contract.

## Run locally

Use the CSpell version already locked by `package-lock.json`. Install or download the pinned `typos` asset recorded in `engines.json`, verify its SHA-256, then provide its path:

```sh
TYPOS_BIN=/path/to/typos npm run spellcheck:rust:compare
TYPOS_BIN=/path/to/typos npm run spellcheck:rust:shadow
TYPOS_BIN=/path/to/typos npm run test:spellcheck:rust
```

To build the custom milestone with a local Rust toolchain:

```sh
npm run spellcheck:rust:native:prepare
npm run spellcheck:rust:native:build
npm run spellcheck:rust:native:prepare-files -- relative-files.txt absolute-files.txt
npm run spellcheck:rust:native:compare
npm run spellcheck:rust:native:shadow
npm run spellcheck:rust:native:hybrid -- --file-list=/absolute/path/to/files.txt
```

`CSPELL_MODULE_ROOT` can point the preparation step at a temporary installation containing the locked CSpell packages. That installation must have a lockfile so its exact package graph can be bound into the generated artifact. `RUST_SPELL_BIN` and `RUST_SPELL_DICTIONARY` override the comparison defaults. `compare-native.mjs --file-list=/path/to/list` compares an identical explicit main-tree file list. Relative file-list resolution differs between CSpell and the native tool for nested list locations, so the hybrid never sends relative entries to native. `prepare-files` deliberately resolves a known repository-relative input list into the absolute-list contract.

The compare commands exit 1 while any detection, location, ordered suggestion list, ordering, or exit code differs. The shadow commands print the same report but exit 0 for known semantic mismatches; runner/configuration failures still exit 2. The hybrid returns native zero only on a clean scan and otherwise returns the oracle's exact result. Set `CSPELL_BIN` only when evaluating a separately installed copy of the locked oracle.

No CI workflow invokes these commands. Rollback is deleting `scripts/spellcheck-rust/` and the opt-in package scripts; `spellcheck` never changes.

After `bin/worktree check` reports `Setup: complete`, run the expanded suite and a benchmark with an explicitly prepared absolute file list:

```sh
npm run test:spellcheck:rust
npm run spellcheck
npm run spellcheck:rust:benchmark -- /absolute/path/to/files.txt 5
```

The new adversarial suite uses seed `0x5eed`, 36 hand-built cases, 64 seeded cases, and three mutated repository files. It checks native detections, positions, and order. It reports missing and extra findings and probes each native false-clean file separately through the hybrid. Native semantic disagreements fail the suite; they are not converted into accepted baselines. It also checks exact hybrid output and suggestions. The suite requires its dependencies and a complete setup rather than silently skipping the new coverage. PHP probes use the temporary target directory and therefore exercise the hybrid's unsupported-path fallback; Markdown, TypeScript, and TSX probes use production paths.

The benchmark runner also enforces the setup gate. It verifies exact output before and during the measurements, records input and artifact hashes, alternates engine order, and reports every sample plus min, median, and max. An untimed CSpell wrapper probe records whether the hybrid actually invoked oracle lint. Timed samples use the original oracle executable. Each sample is a new process with ordinary OS cache state. No forced cold-cache or dependency acquisition measurement is claimed.

## Preliminary timing before setup completed

Measurements were taken on the authorized arm64 Mac mini from this worktree. They are observations, not speedup promises. Each invocation was a new process; “first” is the first observed process with ordinary OS cache state, not a forced cold filesystem cache. “Warm” is subsequent new-process wall time. Dependency acquisition is excluded.

| Input | Engine | First process | Subsequent processes | Outcome |
| --- | --- | ---: | ---: | --- |
| 5 original contract files | CSpell 10.1.1 | 0.54 s | 0.45–0.49 s | 20 findings |
| 5 original contract files | `typos` 1.51.1 | 0.01 s | 0.01 s | 16 findings; non-equivalent |
| 7 native contract files | CSpell 10.1.1 | 0.77 s | 0.74 s | 24 findings |
| 7 native contract files | hybrid | 0.79 s | 0.79–0.80 s | exact CSpell output; oracle invoked |
| 8,946 tracked paths selected by the production globs before ignore filtering | CSpell 10.1.1 | 13.93 s | 12.14–13.22 s | exit 0 |
| same path list | `typos` 1.51.1 | 6.33 s | 6.04–6.25 s | exit 2; non-equivalent findings |
| 7,764 tracked paths after configured exclusions | CSpell 10.1.1 | 12.39 s | 12.09 s | 0 findings |
| same exact absolute file list | provenance-validating hybrid | 2.57 s | 2.15 s | 0 findings; oracle skipped |

An earlier JSON differential on the same 7,764 paths measured 12.32 seconds for CSpell and 1.45 seconds for native. The later hybrid timings include Node wrapper startup and dictionary loading. These observations show meaningful clean-path runtime headroom, but they are not a general speedup promise: a failing hybrid scan pays both the native pre-scan and CSpell, and the current clean corpus cannot exercise direct native suggestions.

The exact CSpell package was acquired into a temporary directory with `npm install --ignore-scripts --no-audit --no-fund`; that one observed acquisition took about 2 seconds. This is separate from engine runtime and is not representative of a clean full `npm ci`. The Rust release assets were also downloaded to a temporary directory and are not vendored in this repository.

Dictionary preparation took 2.0 seconds in the latest observed run and the dependency-free release build took 2.18 seconds after the Rust toolchain was present. Those are separate from steady-state scan runtime. The full-repository timings are useful only as upper-level process comparisons; the hybrid's clean-path result is equivalent on the measured tree, while broader semantic compatibility remains unproven.
