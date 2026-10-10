# Rust spellchecker local verification

2026-10-10. Worktree: `/Users/owen/development/Diagonal-HQ/diagonal-spellchecker`.
Branch: `codex/rust-spellchecker-pilot`. HEAD remains `10193ec0ea101165f12fcee65514e23e7568819f`.

The Rust checks pass. CSpell parity and performance verification remain blocked by incomplete repository setup. The implementation remains an opt-in pilot. CSpell remains the default and CI checker. All existing source files remain in this worktree. No commit, branch update, publication, credential action, or service restart occurred.

## Changes

- Fixed Markdown link scanning at end of line and with an unclosed target.
- Fixed byte offsets after Unicode apostrophes and before directives with expanding Unicode case mappings.
- Changed diagnostic columns to UTF-16 code units to match the pinned CSpell source.
- Fixed URL scanning to select the earliest scheme on each line.
- Reject empty dictionaries, missing option values, and duplicate native options.
- Restrict hybrid clean authorization to CSpell 10.1.1, the inspected root config fingerprint, valid provenance, and eligible files without in-document settings. Imports and external dictionary configurations use CSpell. Unexpected native clean output also uses CSpell.
- Send validated paths through native standard input. This avoids argument size limits and a second native read of the caller's list.
- Rust coverage now includes 12 unit tests and seven CLI tests. One unit test runs 128 deterministic token-boundary probes.
- Added a 103-file differential suite: 36 adversarial cases, 64 cases from seed `0x5eed`, and three mutated repository files. Added hybrid tests for nested lists, relative paths, Unicode, directives, inherited config, dictionary changes, provenance, links, and runner failures. These JavaScript tests have not run.
- Added a setup-gated benchmark runner with exact-output checks, alternating engine order, individual samples, hashes, and an untimed oracle-invocation probe. It has not run.

## Setup diagnosis

`bin/worktree check` reported `Setup: incomplete` for slot `diagonal-10`. Later `bin/worktree status` checks reported the same state. The container inventory contained no slot-10 PHP CLI container. Host process inspection was unavailable in the sandbox. `vendor/` and `node_modules/` remain absent.

The selected runtime is Docker Compose. Only `PHP_EXECUTABLE_PATH` was read from the active `.env` for this selection. The safe diagnostic succeeded:

```sh
docker compose run --no-deps -u "$(id -u):$(id -g)" --rm php-cli composer --version
```

Result: Composer 2.10.3 and PHP 8.4.25, exit 0. Container names and health status showed shared PostgreSQL, MongoDB, and RustFS healthy and Valkey running. No service restart was needed or attempted. This diagnostic does not establish why the earlier install attempts stalled. Composer install was not retried.

The supported resume path cannot proceed under the current constraints. `bin/dcomposer` invokes the explicitly forbidden environment-dump command. After Composer installation, incomplete `bin/worktree setup` calls `cleanup_slot`, which deletes slot databases, Redis keys, and buckets before provisioning. Neither command was invoked. No setup marker was written or bypassed. A safe lifecycle correction and authorization for the slot cleanup are prerequisites for a full setup retry.

## Local checks

The existing temporary Rust toolchain was reused. No toolchain installation or application dependency installation occurred. These commands ran from the exact worktree:

```sh
PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH RUSTFLAGS=-Dwarnings cargo test --offline --manifest-path scripts/spellcheck-rust/native/Cargo.toml
PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH cargo fmt --manifest-path scripts/spellcheck-rust/native/Cargo.toml -- --check
PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH RUSTFLAGS=-Dwarnings cargo check --offline --manifest-path scripts/spellcheck-rust/native/Cargo.toml --all-targets
PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH DYLD_LIBRARY_PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/lib RUSTFLAGS=-Dwarnings cargo build --offline --release --manifest-path scripts/spellcheck-rust/native/Cargo.toml
git diff --check
```

Results: 19 tests passed, zero failed; formatting passed; all-target compilation passed; release build passed; tracked whitespace check passed. A separate read-only check verified that the default spellcheck script, dependency declarations, and CI files did not change. Pilot source files also passed a trailing-whitespace scan.

An initial release build exited 0 with a stripping warning because `rust-objcopy` could not find `libLLVM.dylib`. The command-local library path above resolved that warning. No global configuration changed.

This lint command was attempted and remains unavailable:

```sh
PATH=/private/tmp/diagonal-rust-audit.lbuJXK/rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH cargo clippy --offline --manifest-path scripts/spellcheck-rust/native/Cargo.toml --all-targets -- -D warnings
```

Result: exit 101, `no such command: clippy`. Compiler warnings treated as errors passed, but this does not replace Clippy.

## Blocked checks and remaining gaps

No JavaScript test, JavaScript formatting/lint check, repository CSpell scan, full corpus comparison, or benchmark ran in this continuation. No CI checks or manual application checks ran. Setup must complete before these commands:

```sh
npm run spellcheck:rust:native:prepare
npm run spellcheck:rust:native:build
npm run test:spellcheck:rust
npm run spellcheck
npm run spellcheck:rust:native:shadow -- --file-list=/absolute/path/to/files.txt
npm run spellcheck:rust:benchmark -- /absolute/path/to/files.txt 5
```

Prepare the absolute list with the existing `prepare-file-list.mjs` command from a known repository-relative production list. The benchmark records the actual input count and whether the hybrid invoked CSpell lint. The differential suite fails on native semantic disagreements and reports their locations. It does not accept new disagreements as a baseline.

The earlier 7,764-file clean observation and 2.15–2.57 second hybrid versus approximately 12.31 second CSpell observation remain preliminary. Current CSpell disagreement counts and current scan timings are unknown. The new directive guard reduces fast-path coverage, so earlier hybrid timings do not describe the current wrapper. An entire scan delegates when any selected file contains in-document settings.

Direct native suggestions remain absent. The lower-cased lexicon does not retain dictionary-specific weights, preferred corrections, case information, or tie and timeout behavior needed for exact ranking. The pinned CSpell source confirms those inputs affect suggestions. Fallback retains the oracle's diagnostics and suggestions. Full CSpell equivalence is not established for native tokenization, merged dictionaries, case rules, compounds, Unicode, or suppression heuristics. The adversarial suite must run before any adoption decision.
