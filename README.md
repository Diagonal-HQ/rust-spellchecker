# diagonal-spellcheck

A source-code spellchecker written in Rust. Its English and software-terms lexicon is embedded in the binary. It checks identifiers, strings, comments, and prose in any text file. It splits camelCase and snake_case, and it skips URLs, email addresses, Markdown link targets, hex, UUIDs, Base64, date format strings, and random-looking tokens.

## Install

Prebuilt binaries are attached to each [GitHub Release](https://github.com/Diagonal-HQ/rust-spellchecker/releases). They're available for macOS (Apple silicon) and Linux (x86_64 and arm64, statically linked). Each archive contains the binary, this README, the license files, and `NOTICE.md`.

```sh
version=0.1.2
target=aarch64-apple-darwin   # or x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
archive=diagonal-spellcheck-$version-$target.tar.gz
base=https://github.com/Diagonal-HQ/rust-spellchecker/releases/download/v$version
curl -fsSLO "$base/$archive"
curl -fsSL "$base/$archive.sha256" | shasum -a 256 -c -
tar -xzf "$archive"
sudo install "diagonal-spellcheck-$version-$target/diagonal-spellcheck" /usr/local/bin/
```

Or build from source:

```sh
cargo install --locked --git https://github.com/Diagonal-HQ/rust-spellchecker --tag v0.1.2
# or, from a checkout:
cargo build --release   # target/release/diagonal-spellcheck
```

## Usage

```sh
diagonal-spellcheck [--config PATH|--no-config] [--dictionary PATH] [--words PATH]... [--exclude GLOB]... [--file-list PATH|-] [PATHS...]
```

```sh
diagonal-spellcheck                           # the project described by spellcheck.toml, or the current directory
diagonal-spellcheck .                         # audit every file under the current directory
diagonal-spellcheck src docs README.md        # mix directories and files
diagonal-spellcheck --exclude 'fixtures/**' --words project-words.txt .
```

- `PATHS...` and `--file-list` name files or directories to check. A file list has one path per line, and `-` reads it from standard input. Relative paths resolve from the working directory. With no paths and no file list, the tool checks the directory containing the config file, or the working directory if there is no config.
- Directories are walked recursively, in sorted order:
  - `.gitignore`, `.ignore`, and global git excludes are respected, even outside a Git repository.
  - Hidden files and directories are skipped.
  - Binary files (anything containing a NUL byte) and files that aren't UTF-8 are skipped.
  - Lockfiles and generated files are excluded by default: `*.lock`, `*-lock.json`, `*-lock.yaml`, `*.min.js`, `*.min.css`, `*.map`, `*.snap`.
- Excludes and the config's `include` apply to explicitly named files too, so a pre-commit hook can pass every changed file and let the config decide. A missing or non-UTF-8 explicit file that passes the filters is an error.
- `--exclude GLOB` skips matching paths. Globs use `.gitignore` syntax anchored at the working directory. It can be repeated.
- `--words PATH` adds accepted words from a file, one per line. `#` lines are comments. Use this for project vocabulary. It can be repeated.
- `--dictionary PATH` replaces the built-in lexicon with a file in the [lexicon format](#lexicon).
- `--config PATH` uses a specific config file instead of discovering one, and `--no-config` disables config files.

Each finding is printed as a JSON line:

```json
{"path":"src/app.ts","row":3,"col":17,"word":"recieve"}
```

Files are scanned in parallel, and output follows input order: explicit paths in argument order, with walked files sorted within each directory. `row` and `col` are 1-based. `col` counts UTF-16 code units, which matches most editors' column numbering. The exit code is `0` when nothing is found, `1` when there are findings, and `2` for usage, file, or dictionary errors.

## Configuration

The tool loads `spellcheck.toml` from the working directory or its nearest parent:

```toml
# Only check files matching these globs. Omit to check everything.
include = [
  "src/**/*.{ts,tsx}",
  "app/*/src/**/*.php",
  "docs/**/*.md",
  "/README.md",
]

# Skip these, in addition to .gitignore and the built-in lockfile excludes.
exclude = ["src/generated/", "*.test.ts", "!src/important.test.ts"]

# Project vocabulary, inline and/or from files with one word per line.
words = ["Diagonal", "Inertia"]
word_files = ["spellcheck-words.txt"]
```

- All keys are optional. Unknown keys are an error, so a typo in a setting never quietly changes results.
- `include` and `exclude` use `.gitignore` syntax anchored at the config file's directory. A pattern containing a `/` (or starting with one) matches from that directory, and a bare pattern like `*.test.ts` matches at any depth. A trailing `/` matches directories, `!` re-includes, and `{a,b}` alternatives work.
- `word_files` paths are relative to the config file. Words from the config, `--words`, and in-file directives are all added to the lexicon.
- Command-line `--exclude` and `--words` add to the config rather than replacing it.

### In-file directives

| Directive | Effect |
| --- | --- |
| `spellcheck:words foo, bar` | Accepts the words in this file. `spellcheck:ignore` works the same way. |
| `spellcheck:disable-next-line` | Skips the next line. |
| `spellcheck:disable` / `spellcheck:enable` | Skips the lines between them. |

Lines containing a directive are never checked.

## Lexicon

[`lexicon/lexicon.txt`](lexicon/lexicon.txt) is the built-in word list, embedded at compile time. It has about 245,800 lower-cased words, copied from the CSpell 10.1.1 dictionaries (English, software terms, TypeScript, Node, npm, PHP, HTML, CSS, fonts, AWS, and others). `@compound<TAB>part` lines list compound-word parts: a trailing `+` marks a part that starts a compound, a leading `+` marks one that ends it, and both mark a middle part. [`lexicon/NOTICE.md`](lexicon/NOTICE.md) carries the source packages' licenses (MIT, except `@cspell/dict-django`, which declares MIT but ships a WTFPL license file; the notices also include the SCOWL notice for `en_US`).

[`lexicon/SOURCE.md`](lexicon/SOURCE.md) records how the list was extracted and how to rebuild it. CSpell supplies only this word data. The tokenizer, filters, directives, and output are this crate's own.

## Test

```sh
cargo test
```

`tests/fixtures.rs` checks the fixtures listed in `tests/fixtures/inputs.txt` against `tests/fixtures/expected.jsonl` using the built-in lexicon. The release workflow runs the same check against each built binary.

## Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on every push to `main` and on pull requests:

- formatting, Clippy, and the tests on Linux and macOS
- release builds for all three targets, each smoke-tested against the fixtures
- archives with SHA-256 checksums, uploaded as workflow artifacts

On `main`, if no release exists for the version in `Cargo.toml`, the workflow tags the commit `v<version>` and publishes a GitHub Release with the archives, per-archive `.sha256` files, and a combined `SHA256SUMS`. To release, bump `version` in `Cargo.toml`, run `cargo build` so `Cargo.lock` updates, update the version in the [install](#install) examples, then merge to `main`. Pushes that don't change the version build and test but publish nothing, so a released version's files never change.

## Limitations

- No suggestions.
- No per-language parsing. Every file is tokenized the same way, except that Markdown link targets are skipped in `.md` files.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

The embedded lexicon is third-party data under its own licenses; see [`lexicon/NOTICE.md`](lexicon/NOTICE.md).

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
