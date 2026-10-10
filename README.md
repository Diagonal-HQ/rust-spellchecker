# Rust spellchecker pilot

Custom Rust spellchecker research from Diagonal. The dependency-free Rust crate supports native scans with a prepared CSpell-derived lexicon. The hybrid wrapper delegates findings and suggestions to CSpell.

This is a source snapshot for review. It is not a drop-in CSpell replacement or a published package. Diagonal continues to use CSpell by default and in CI.

## Native crate

Build the crate from this repository:

```sh
cargo build --release --manifest-path scripts/spellcheck-rust/native/Cargo.toml
```

The executable requires a prepared dictionary and explicit input files. Dictionary preparation requires the consuming Diagonal checkout and its locked CSpell installation. Generated dictionaries, downloaded engines, build artifacts, application dependencies, and application Git history are excluded from this repository.

## Diagonal integration

The JavaScript wrappers and corpus tests retain their original Diagonal paths and assumptions. They require Diagonal's root config, dependency lockfile, production files, and worktree lifecycle. They do not run as a standalone npm project here. See [integration instructions](integration/README.md).

The [pilot README](scripts/spellcheck-rust/README.md) describes the implementation and preliminary measurements. The [local verification report](scripts/spellcheck-rust/VERIFICATION.md) records the source checkout's checks and setup blocker before export. These documents retain that historical context.

## Verification status

Nineteen Rust tests, formatting, all-target compilation, and release compilation passed in the source checkout. The expanded 103-file CSpell differential suite and new benchmarks have not run because the source checkout's setup remains incomplete. Direct native suggestions remain absent. The clean fast path remains experimental. No CI workflows are included in this snapshot.
