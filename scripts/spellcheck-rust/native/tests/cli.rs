use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "diagonal-spellcheck-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("dictionary.txt"), "hello\nworld\n").unwrap();
        fs::write(directory.join("clean.md"), "hello world\n").unwrap();
        fs::write(directory.join("typo.md"), "😀 recieve\n").unwrap();
        Self(directory)
    }

    fn run(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
            .current_dir(&self.0)
            .args(arguments)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn clean_and_finding_exits_have_distinct_json_contracts() {
    let fixture = Fixture::new();
    let clean = fixture.run(&["--dictionary", "dictionary.txt", "clean.md"]);
    assert_eq!(clean.status.code(), Some(0));
    assert!(clean.stdout.is_empty());
    assert!(clean.stderr.is_empty());
    let typo = fixture.run(&["--dictionary", "dictionary.txt", "typo.md"]);
    assert_eq!(typo.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(typo.stdout).unwrap(),
        "{\"path\":\"typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\",\"suggestions\":[]}\n"
    );
    assert!(typo.stderr.is_empty());
}

#[test]
fn invalid_or_duplicate_options_never_return_clean() {
    let fixture = Fixture::new();
    for arguments in [
        vec![],
        vec!["--dictionary"],
        vec!["--dictionary", "dictionary.txt", "--file-list"],
        vec!["--dictionary", "dictionary.txt", "--file-list", "--version"],
        vec![
            "--dictionary",
            "dictionary.txt",
            "--dictionary",
            "dictionary.txt",
            "clean.md",
        ],
        vec![
            "--dictionary",
            "dictionary.txt",
            "--file-list",
            "a",
            "--file-list",
            "b",
        ],
        vec!["--unknown"],
    ] {
        let result = fixture.run(&arguments);
        assert_eq!(result.status.code(), Some(2), "{arguments:?}");
        assert!(!result.stderr.is_empty());
    }
}

#[test]
fn missing_files_and_invalid_utf8_never_return_clean() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("invalid.md"), [0xff, 0xfe]).unwrap();
    for input in ["missing.md", "invalid.md", "."] {
        let result = fixture.run(&["--dictionary", "dictionary.txt", input]);
        assert_eq!(result.status.code(), Some(2), "{input}");
        assert!(result.stdout.is_empty());
        assert!(!result.stderr.is_empty());
    }
}

#[test]
fn missing_empty_and_invalid_utf8_dictionaries_never_return_clean() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("empty.txt"), "# metadata only\n").unwrap();
    fs::write(fixture.0.join("invalid.txt"), [0xff]).unwrap();
    for dictionary in ["missing.txt", "empty.txt", "invalid.txt"] {
        let result = fixture.run(&["--dictionary", dictionary, "clean.md"]);
        assert_eq!(result.status.code(), Some(2), "{dictionary}");
        assert!(result.stdout.is_empty());
    }
}

#[test]
fn nested_absolute_file_lists_preserve_order_and_crlf() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("nested")).unwrap();
    let typo = fixture.0.join("typo.md");
    fs::write(
        fixture.0.join("nested/files.txt"),
        format!(
            "{}\r\n\r\n{}\r\n",
            fixture.0.join("clean.md").display(),
            typo.display()
        ),
    )
    .unwrap();
    let result = fixture.run(&[
        "--dictionary",
        "dictionary.txt",
        "--file-list",
        "nested/files.txt",
    ]);
    assert_eq!(result.status.code(), Some(1));
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(output.contains(&format!("\"path\":\"{}\"", typo.display())));
    assert!(output.contains("\"word\":\"recieve\""));
}

#[test]
fn missing_empty_and_invalid_lists_never_return_clean() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("empty.txt"), "\n\r\n").unwrap();
    fs::write(fixture.0.join("invalid.txt"), [0xff]).unwrap();
    for list in [
        Path::new("missing.txt"),
        Path::new("empty.txt"),
        Path::new("invalid.txt"),
    ] {
        let result = fixture.run(&[
            "--dictionary",
            "dictionary.txt",
            "--file-list",
            list.to_str().unwrap(),
        ]);
        assert_eq!(result.status.code(), Some(2), "{}", list.display());
    }
}

#[test]
fn validated_file_lists_can_arrive_through_standard_input() {
    let fixture = Fixture::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(&fixture.0)
        .args(["--dictionary", "dictionary.txt", "--file-list", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"clean.md\r\n\r\ntypo.md\r\n")
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("\"word\":\"recieve\"")
    );
    assert!(result.stderr.is_empty());
}
