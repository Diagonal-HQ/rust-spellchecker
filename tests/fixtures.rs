use std::process::Command;

// The release workflow's smoke test runs the same command against each built binary.
#[test]
fn fixtures_match_expected_findings_with_the_builtin_lexicon() {
    let result = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "--no-config",
            "--words",
            "tests/fixtures/words.txt",
            "--file-list",
            "tests/fixtures/inputs.txt",
        ])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        include_str!("fixtures/expected.jsonl")
    );
}
