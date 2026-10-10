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
        "{\"path\":\"typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\"}\n"
    );
    assert!(typo.stderr.is_empty());
}

#[test]
fn builtin_lexicon_is_used_without_a_dictionary() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("prose.md"), "Receive the documentation.\n").unwrap();
    let clean = fixture.run(&["prose.md"]);
    assert_eq!(clean.status.code(), Some(0));
    assert!(clean.stdout.is_empty());
    let typo = fixture.run(&["typo.md"]);
    assert_eq!(typo.status.code(), Some(1));
    assert!(
        String::from_utf8(typo.stdout)
            .unwrap()
            .contains("\"word\":\"recieve\"")
    );
}

#[test]
fn word_files_extend_the_lexicon() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("project.md"), "Zorbulate the Frobnitz.\n").unwrap();
    fs::write(
        fixture.0.join("words.txt"),
        "# project words\nZorbulate\nfrobnitz\n",
    )
    .unwrap();
    assert_eq!(fixture.run(&["project.md"]).status.code(), Some(1));
    let result = fixture.run(&["--words", "words.txt", "project.md"]);
    assert_eq!(result.status.code(), Some(0));
    assert!(result.stdout.is_empty());
    let missing = fixture.run(&["--words", "missing.txt", "project.md"]);
    assert_eq!(missing.status.code(), Some(2));
}

#[test]
fn invalid_or_duplicate_options_never_return_clean() {
    let fixture = Fixture::new();
    for arguments in [
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
        vec!["--words"],
        vec!["--config"],
        vec!["--config", "a.toml", "--no-config"],
        vec!["--config", "missing.toml"],
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
    for input in ["missing.md", "invalid.md"] {
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

#[test]
fn directories_are_walked_in_order_and_respect_ignore_rules() {
    let fixture = Fixture::new();
    let project = fixture.0.join("project");
    for directory in ["src/nested", "ignored", ".hidden", "skipped"] {
        fs::create_dir_all(project.join(directory)).unwrap();
    }
    fs::write(project.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    fs::write(project.join("b.md"), "mispeling\n").unwrap();
    fs::write(project.join("src/a.ts"), "const recieve = 1;\n").unwrap();
    fs::write(project.join("src/nested/c.md"), "hello world\n").unwrap();
    fs::write(project.join("ignored/x.md"), "ignoredtypo\n").unwrap();
    fs::write(project.join("debug.log"), "logtypo\n").unwrap();
    fs::write(project.join(".hidden/x.md"), "hiddentypo\n").unwrap();
    fs::write(project.join("skipped/x.md"), "excludedtypo\n").unwrap();
    fs::write(project.join("package-lock.json"), "{\"lockfiletypo\": 1}\n").unwrap();
    fs::write(project.join("image.png"), [0x89, b'P', b'N', b'G', 0, b'x']).unwrap();
    fs::write(project.join("latin1.txt"), [b'c', b'a', b'f', 0xe9]).unwrap();

    let result = fixture.run(&["--exclude", "project/skipped/**", "project"]);
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "{\"path\":\"project/b.md\",\"row\":1,\"col\":1,\"word\":\"mispeling\"}\n\
         {\"path\":\"project/src/a.ts\",\"row\":1,\"col\":7,\"word\":\"recieve\"}\n"
    );
}

#[test]
fn files_and_directories_can_be_mixed() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("docs")).unwrap();
    fs::write(
        fixture.0.join("docs/guide.md"),
        "Receive the documentation.\n",
    )
    .unwrap();
    let result = fixture.run(&["docs", "typo.md"]);
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "{\"path\":\"typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\"}\n"
    );
    let current = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(fixture.0.join("docs"))
        .args([".", "../typo.md"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(current.stdout).unwrap(),
        "{\"path\":\"../typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\"}\n"
    );
    fs::write(fixture.0.join("docs/typo.md"), "mispeling\n").unwrap();
    let relative = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(fixture.0.join("docs"))
        .arg(".")
        .output()
        .unwrap();
    assert!(
        String::from_utf8(relative.stdout)
            .unwrap()
            .starts_with("{\"path\":\"typo.md\"")
    );
    fs::remove_file(fixture.0.join("docs/typo.md")).unwrap();
    let clean = fixture.run(&["docs"]);
    assert_eq!(clean.status.code(), Some(0));
    assert!(clean.stdout.is_empty());
}

#[test]
fn no_arguments_scan_the_working_directory() {
    let fixture = Fixture::new();
    let result = fixture.run(&[]);
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "{\"path\":\"typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\"}\n"
    );
}

#[test]
fn discovered_config_sets_scope_words_and_excludes() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("src/generated")).unwrap();
    fs::create_dir_all(fixture.0.join("notes")).unwrap();
    fs::write(
        fixture.0.join("spellcheck.toml"),
        r#"
include = ["src/**/*.ts", "/*.md"]
exclude = ["src/generated/"]
words = ["Zorbulate"]
word_files = ["words.txt"]
"#,
    )
    .unwrap();
    fs::write(fixture.0.join("words.txt"), "frobnitz\n").unwrap();
    fs::write(
        fixture.0.join("src/app.ts"),
        "zorbulate(frobnitz, mispeling);\n",
    )
    .unwrap();
    fs::write(fixture.0.join("src/generated/api.ts"), "generatedtypo\n").unwrap();
    fs::write(fixture.0.join("src/notes.txt"), "notincluded\n").unwrap();
    fs::write(fixture.0.join("notes/todo.md"), "anchoredtypo\n").unwrap();

    let expected = "{\"path\":\"src/app.ts\",\"row\":1,\"col\":21,\"word\":\"mispeling\"}\n\
                    {\"path\":\"typo.md\",\"row\":1,\"col\":4,\"word\":\"recieve\"}\n";
    let result = fixture.run(&[]);
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    assert_eq!(String::from_utf8(result.stdout).unwrap(), expected);

    // From a subdirectory the config is found in a parent and paths stay relative to the caller.
    let nested = Command::new(env!("CARGO_BIN_EXE_diagonal-spellcheck"))
        .current_dir(fixture.0.join("src"))
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(nested.stdout).unwrap(),
        expected
            .replace("src/app.ts", "../src/app.ts")
            .replace("typo.md", "../typo.md")
    );

    // Explicitly named files are filtered too, so hooks can pass changed files.
    let explicit = fixture.run(&["src/generated/api.ts", "src/app.ts"]);
    assert_eq!(
        String::from_utf8(explicit.stdout).unwrap(),
        "{\"path\":\"src/app.ts\",\"row\":1,\"col\":21,\"word\":\"mispeling\"}\n"
    );

    let ignored = fixture.run(&["--no-config", "src"]);
    let output = String::from_utf8(ignored.stdout).unwrap();
    assert!(output.contains("zorbulate") && output.contains("generatedtypo"));
}

#[test]
fn explicit_config_and_invalid_configs() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("config")).unwrap();
    fs::write(
        fixture.0.join("config/custom.toml"),
        "words = [\"recieve\"]\n",
    )
    .unwrap();
    let result = fixture.run(&["--config", "config/custom.toml", "typo.md"]);
    assert_eq!(result.status.code(), Some(0));

    fs::write(fixture.0.join("spellcheck.toml"), "ignorePaths = [\"x\"]\n").unwrap();
    let unknown = fixture.run(&["typo.md"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(
        String::from_utf8(unknown.stderr)
            .unwrap()
            .contains("ignorePaths")
    );

    fs::write(fixture.0.join("spellcheck.toml"), "words = [\n").unwrap();
    assert_eq!(fixture.run(&["typo.md"]).status.code(), Some(2));
}
