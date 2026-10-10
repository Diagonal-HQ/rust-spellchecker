# Diagonal integration instructions

The pilot source came from `Diagonal-HQ/diagonal`, branch `codex/rust-spellchecker-pilot`, at base `10193ec0ea101165f12fcee65514e23e7568819f` with uncommitted implementation changes.

Preserve any existing work in the consuming Diagonal checkout. Review the package patch before applying it. Copy `scripts/spellcheck-rust/` into that checkout. The patch adds opt-in commands to its root `package.json`. It does not change the default spellcheck command, dependency declarations, or CI.

Use the consuming checkout's root `AGENTS.md` and `docs/development-environment.md`. Complete its supported setup before running Node scripts or application-dependent checks. Do not create or bypass its setup marker.

The wrappers resolve the repository root from their script location. They use that root's `cspell.json`, `package-lock.json`, installed CSpell, and production path contract. The corpus tests also use representative Diagonal source files. The supported config fingerprint is recorded in `scripts/spellcheck-rust/engines.json`; other config versions delegate to CSpell.

Follow the pilot README for dictionary preparation, native builds, comparisons, and benchmarks after the consuming checkout passes its setup gate. The standalone Rust crate can be reviewed and built in this repository without application dependencies.
