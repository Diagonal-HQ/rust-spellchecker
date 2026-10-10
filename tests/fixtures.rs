use std::process::Command;

const FIXTURES: [&str; 7] = [
    "tests/fixtures/parity.php",
    "tests/fixtures/parity.ts",
    "tests/fixtures/sample.blade.php",
    "tests/fixtures/sample.md",
    "tests/fixtures/sample.php",
    "tests/fixtures/sample.ts",
    "tests/fixtures/sample.tsx",
];

#[test]
fn fixtures_match_expected_findings_with_the_builtin_lexicon() {
    let result = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["--no-config", "--words", "tests/fixtures/words.txt"])
        .args(FIXTURES)
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        include_str!("fixtures/expected.jsonl")
    );
}
