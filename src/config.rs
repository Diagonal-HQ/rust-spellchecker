use std::fs;
use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;

pub const CONFIG_FILE: &str = "spellcheck.toml";

// Generated and machine-oriented files that are rarely worth spellchecking.
const DEFAULT_EXCLUDES: [&str; 7] = [
    "*.lock",
    "*-lock.json",
    "*-lock.yaml",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.snap",
];

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// When non-empty, only files matching one of these globs are checked.
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub words: Vec<String>,
    pub word_files: Vec<PathBuf>,
}

pub struct LoadedConfig {
    /// Directory containing the config file, as given or discovered (may be relative).
    pub directory: PathBuf,
    pub config: Config,
}

/// Finds `spellcheck.toml` in `cwd` or its nearest ancestor and returns its path relative to `cwd`.
pub fn discover(cwd: &Path) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for directory in cwd.ancestors() {
        if directory.join(CONFIG_FILE).is_file() {
            return Some(relative.join(CONFIG_FILE));
        }
        relative.push("..");
    }
    None
}

pub fn load(path: &Path) -> Result<LoadedConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read config {}: {error}", path.display()))?;
    let config = toml::from_str(&content)
        .map_err(|error| format!("invalid config {}: {error}", path.display()))?;
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    Ok(LoadedConfig { directory, config })
}

/// Lexically resolves `path` against `cwd`, removing `.` and `..` components.
pub fn absolute(cwd: &Path, path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result
}

/// Gitignore-style globs anchored at `root`.
struct Patterns {
    root: PathBuf,
    matcher: Gitignore,
    /// Only the unanchored globs, for paths outside `root`.
    outside: Gitignore,
}

impl Patterns {
    fn new<'a>(
        root: PathBuf,
        globs: impl IntoIterator<Item = &'a str>,
        source: &str,
    ) -> Result<Self, String> {
        let mut builder = GitignoreBuilder::new(&root);
        let mut outside = GitignoreBuilder::new(&root);
        for glob in globs {
            builder
                .add_line(None, glob)
                .map_err(|error| format!("invalid {source} glob {glob}: {error}"))?;
            if !is_anchored(glob) {
                outside
                    .add_line(None, glob)
                    .map_err(|error| format!("invalid {source} glob {glob}: {error}"))?;
            }
        }
        let build = |builder: GitignoreBuilder| {
            builder
                .build()
                .map_err(|error| format!("invalid {source} globs: {error}"))
        };
        Ok(Self {
            root,
            matcher: build(builder)?,
            outside: build(outside)?,
        })
    }

    fn matches(&self, path: &Path, is_dir: bool) -> bool {
        match path.strip_prefix(&self.root) {
            Ok(relative) => self
                .matcher
                .matched_path_or_any_parents(relative, is_dir)
                .is_ignore(),
            // Outside the root only unanchored globs such as `*.lock` can apply.
            Err(_) => path
                .file_name()
                .is_some_and(|name| self.outside.matched(Path::new(name), is_dir).is_ignore()),
        }
    }
}

/// Whether a gitignore glob matches only from its root: it contains a `/` other than a
/// trailing one or a leading `**/`.
fn is_anchored(glob: &str) -> bool {
    let glob = glob.strip_prefix('!').unwrap_or(glob);
    let glob = glob.strip_suffix('/').unwrap_or(glob);
    glob.strip_prefix("**/").unwrap_or(glob).contains('/')
}

/// Decides which paths are checked. All paths are resolved against the working directory.
pub struct Filter {
    cwd: PathBuf,
    include: Option<Patterns>,
    exclude: Vec<Patterns>,
}

impl Filter {
    pub fn new(
        cwd: &Path,
        cli_excludes: &[String],
        config: Option<&LoadedConfig>,
    ) -> Result<Self, String> {
        let mut exclude = vec![Patterns::new(
            cwd.to_path_buf(),
            DEFAULT_EXCLUDES
                .iter()
                .copied()
                .chain(cli_excludes.iter().map(String::as_str)),
            "--exclude",
        )?];
        let mut include = None;
        if let Some(loaded) = config {
            let root = absolute(cwd, &loaded.directory);
            exclude.push(Patterns::new(
                root.clone(),
                loaded.config.exclude.iter().map(String::as_str),
                "exclude",
            )?);
            if !loaded.config.include.is_empty() {
                include = Some(Patterns::new(
                    root,
                    loaded.config.include.iter().map(String::as_str),
                    "include",
                )?);
            }
        }
        Ok(Self {
            cwd: cwd.to_path_buf(),
            include,
            exclude,
        })
    }

    pub fn is_excluded(&self, path: &Path, is_dir: bool) -> bool {
        let path = absolute(&self.cwd, path);
        self.exclude
            .iter()
            .any(|patterns| patterns.matches(&path, is_dir))
    }

    pub fn selects_file(&self, path: &Path) -> bool {
        !self.is_excluded(path, false)
            && self
                .include
                .as_ref()
                .is_none_or(|include| include.matches(&absolute(&self.cwd, path), false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(directory: &str, toml: &str) -> LoadedConfig {
        LoadedConfig {
            directory: PathBuf::from(directory),
            config: toml::from_str(toml).unwrap(),
        }
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let error = toml::from_str::<Config>("ignorePaths = []").unwrap_err();
        assert!(error.to_string().contains("ignorePaths"));
    }

    #[test]
    fn absolute_paths_are_normalized_lexically() {
        let cwd = Path::new("/repo/app");
        assert_eq!(
            absolute(cwd, Path::new("./src/../a.ts")),
            Path::new("/repo/app/a.ts")
        );
        assert_eq!(absolute(cwd, Path::new("../docs")), Path::new("/repo/docs"));
    }

    #[test]
    fn config_globs_are_anchored_at_the_config_directory() {
        let config = loaded(
            "..",
            r#"
            include = ["app/*/src/**/*.php", "docs/**/*.{md,mdx}"]
            exclude = ["app/legacy/", "*.test.php", "!keep.test.php"]
            "#,
        );
        // Working inside /repo/app with the config at /repo.
        let filter = Filter::new(Path::new("/repo/app"), &[], Some(&config)).unwrap();
        assert!(filter.selects_file(Path::new("core/src/Thing.php")));
        assert!(filter.selects_file(Path::new("../docs/guide.mdx")));
        assert!(!filter.selects_file(Path::new("core/resources/x.php")));
        assert!(!filter.selects_file(Path::new("legacy/src/Old.php")));
        assert!(!filter.selects_file(Path::new("core/src/ThingTest.test.php")));
        assert!(filter.selects_file(Path::new("core/src/keep.test.php")));
        assert!(filter.is_excluded(Path::new("legacy"), true));
    }

    #[test]
    fn anchored_config_globs_do_not_match_outside_the_config_directory() {
        let config = loaded(
            "config",
            r#"
            include = ["/*.md", "docs/*.txt", "*.rs"]
            exclude = ["/skip.rs", "*.gen.rs"]
            "#,
        );
        let filter = Filter::new(Path::new("/repo"), &[], Some(&config)).unwrap();
        assert!(filter.selects_file(Path::new("config/notes.md")));
        assert!(!filter.selects_file(Path::new("other/typo.md")));
        assert!(!filter.selects_file(Path::new("other/docs/a.txt")));
        assert!(filter.selects_file(Path::new("other/main.rs")));
        assert!(filter.selects_file(Path::new("other/skip.rs")));
        assert!(!filter.selects_file(Path::new("config/skip.rs")));
        assert!(!filter.selects_file(Path::new("other/x.gen.rs")));
    }

    #[test]
    fn cli_and_default_excludes_apply_without_a_config() {
        let filter = Filter::new(Path::new("/repo"), &["fixtures/**".into()], None).unwrap();
        assert!(filter.selects_file(Path::new("src/main.rs")));
        assert!(!filter.selects_file(Path::new("Cargo.lock")));
        assert!(!filter.selects_file(Path::new("fixtures/a.md")));
        assert!(filter.selects_file(Path::new("src/fixtures/a.md")));
    }
}
