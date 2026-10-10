use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufWriter, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;

use ignore::WalkBuilder;

mod config;
use config::Filter;

const BUILTIN_LEXICON: &str = include_str!("../lexicon/lexicon.txt");

const DIRECTIVE_PREFIX: &str = "spellcheck:";

#[derive(Debug, PartialEq, Eq)]
struct Issue {
    path: String,
    row: usize,
    col: usize,
    word: String,
}

struct Dictionary {
    words: HashSet<String>,
    compound_start: HashSet<String>,
    compound_middle: HashSet<String>,
    compound_end: HashSet<String>,
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}

fn read_word_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("could not read dictionary {}: {error}", path.display()))
}

fn parse_dictionary(content: &str) -> Dictionary {
    let mut dictionary = Dictionary {
        words: HashSet::new(),
        compound_start: HashSet::new(),
        compound_middle: HashSet::new(),
        compound_end: HashSet::new(),
    };
    add_words(&mut dictionary, content);
    dictionary
}

fn add_words(dictionary: &mut Dictionary, content: &str) {
    for line in content
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let Some(marker) = line.strip_prefix("@compound\t") else {
            dictionary.words.insert(line.to_locale_lowercase());
            continue;
        };
        let leading = marker.starts_with('+');
        let trailing = marker.ends_with('+');
        let word = marker.trim_matches('+').to_owned();
        match (leading, trailing) {
            (false, true) => {
                dictionary.compound_start.insert(word);
            }
            (true, true) => {
                dictionary.compound_middle.insert(word);
            }
            (true, false) => {
                dictionary.compound_end.insert(word);
            }
            _ => {}
        }
    }
}

fn has_directive(lowercase: &str, command: &str) -> bool {
    lowercase.contains(&format!("{DIRECTIVE_PREFIX}{command}"))
}

fn parse_directive_words(line: &str) -> Vec<String> {
    let lowercase = line.to_ascii_lowercase();
    let Some(start) = lowercase.find(DIRECTIVE_PREFIX) else {
        return Vec::new();
    };
    let directive = &line[start + DIRECTIVE_PREFIX.len()..];
    let mut fields = directive.split(|c: char| c.is_whitespace() || c == ',' || c == ';');
    let Some(command) = fields.next() else {
        return Vec::new();
    };
    if !matches!(
        command.to_ascii_lowercase().as_str(),
        "word" | "words" | "ignore" | "ignoreword" | "ignorewords" | "ignore-word" | "ignore-words"
    ) {
        return Vec::new();
    }
    fields
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '’'))
        .filter(|word| !word.is_empty())
        .map(|word| word.to_locale_lowercase())
        .collect()
}

trait LocaleLowercase {
    fn to_locale_lowercase(&self) -> String;
}

impl LocaleLowercase for str {
    fn to_locale_lowercase(&self) -> String {
        self.chars()
            .flat_map(char::to_lowercase)
            .map(|character| {
                if matches!(character, '’' | '`') {
                    '\''
                } else {
                    character
                }
            })
            .collect()
    }
}

fn is_compound(word: &str, dictionary: &Dictionary) -> bool {
    fn finish(rest: &str, dictionary: &Dictionary) -> bool {
        if dictionary.compound_end.contains(rest) {
            return true;
        }
        for (byte, _) in rest.char_indices().skip(1) {
            if dictionary.compound_middle.contains(&rest[..byte])
                && finish(&rest[byte..], dictionary)
            {
                return true;
            }
        }
        false
    }

    for (byte, _) in word.char_indices().skip(1) {
        if dictionary.compound_start.contains(&word[..byte]) && finish(&word[byte..], dictionary) {
            return true;
        }
    }
    false
}

fn is_accepted(word: &str, dictionary: &Dictionary, local_words: &HashSet<String>) -> bool {
    let normalized = word.to_locale_lowercase();
    dictionary.words.contains(&normalized)
        || local_words.contains(&normalized)
        || is_compound(&normalized, dictionary)
        || normalized
            .strip_suffix("'s")
            .is_some_and(|base| dictionary.words.contains(base) || local_words.contains(base))
        || {
            let trimmed = normalized.trim_matches(['.', '-', '+', '_', '\'', '`']);
            trimmed != normalized
                && (dictionary.words.contains(trimmed)
                    || local_words.contains(trimmed)
                    || is_compound(trimmed, dictionary))
        }
}

fn camel_parts(word: &str, start_byte: usize) -> Vec<(usize, String)> {
    let characters: Vec<(usize, char)> = word.char_indices().collect();
    if characters.is_empty() {
        return Vec::new();
    }
    let mut breaks = vec![0];
    for index in 1..characters.len() {
        let previous = characters[index - 1].1;
        let current = characters[index].1;
        let next = characters.get(index + 1).map(|(_, c)| *c);
        if (previous.is_lowercase() && current.is_uppercase())
            || (previous.is_uppercase()
                && current.is_uppercase()
                && next.is_some_and(char::is_lowercase))
        {
            breaks.push(characters[index].0);
        }
    }
    breaks.push(word.len());
    breaks
        .windows(2)
        .map(|range| (start_byte + range[0], word[range[0]..range[1]].to_owned()))
        .collect()
}

fn is_repeating(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    word.chars().count() >= 4 && chars.all(|character| character.eq_ignore_ascii_case(&first))
}

fn raw_words(line: &str) -> Vec<(usize, String)> {
    let mut words = Vec::new();
    let mut start = None;
    for (offset, character) in line.char_indices() {
        let in_word = character.is_alphabetic() || character == '\'' || character == '’';
        match (start, in_word) {
            (None, true) => start = Some(offset),
            (Some(begin), false) => {
                let word = line[begin..offset].trim_matches(['\'', '’']);
                let adjustment = line[begin..offset].find(word).unwrap_or(0);
                if !word.is_empty() {
                    words.push((begin + adjustment, word.to_owned()));
                }
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        let word = line[begin..].trim_matches(['\'', '’']);
        let adjustment = line[begin..].find(word).unwrap_or(0);
        if !word.is_empty() {
            words.push((begin + adjustment, word.to_owned()));
        }
    }
    words
}

fn possible_words(line: &str) -> Vec<(usize, String)> {
    let mut words = Vec::new();
    let mut start = None;
    for (offset, character) in line.char_indices() {
        let in_word = character.is_alphanumeric()
            || matches!(character, '_' | '\'' | '’' | '`' | '.' | '+' | '-');
        match (start, in_word) {
            (None, true) => start = Some(offset),
            (Some(begin), false) => {
                let word = &line[begin..offset];
                if word.chars().any(char::is_alphabetic) {
                    words.push((begin, word.to_owned()));
                }
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        let word = &line[begin..];
        if word.chars().any(char::is_alphabetic) {
            words.push((begin, word.to_owned()));
        }
    }
    words
}

fn remove_escape_prefix(
    line: &str,
    byte: usize,
    word: &str,
    dictionary: &Dictionary,
    local_words: &HashSet<String>,
) -> (usize, String) {
    if byte > 0
        && line.as_bytes()[byte - 1] == b'\\'
        && word
            .chars()
            .next()
            .is_some_and(|character| "anrvtbfgANRVTBFG".contains(character))
    {
        let first_length = word.chars().next().map_or(0, char::len_utf8);
        let remainder = &word[first_length..];
        if !components_are_accepted(word, dictionary, local_words)
            && components_are_accepted(remainder, dictionary, local_words)
        {
            return (byte + first_length, remainder.to_owned());
        }
    }
    (byte, word.to_owned())
}

fn components_are_accepted(
    word: &str,
    dictionary: &Dictionary,
    local_words: &HashSet<String>,
) -> bool {
    let mut found = false;
    for (_, raw) in raw_words(word) {
        found = true;
        if is_accepted(&raw, dictionary, local_words) {
            continue;
        }
        for part in raw.split(['\'', '’', '`']) {
            for (_, camel) in camel_parts(part, 0) {
                if camel.chars().count() >= 4 && !is_accepted(&camel, dictionary, local_words) {
                    return false;
                }
            }
        }
    }
    found
}

fn is_hex_sequence(word: &str) -> bool {
    word.len() >= 4
        && word
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        && word
            .bytes()
            .any(|byte| byte.is_ascii_digit() || byte == b'-')
        && (word == word.to_ascii_lowercase() || word == word.to_ascii_uppercase())
}

fn is_css_hex(line: &str, byte: usize, word: &str) -> bool {
    line[..byte].ends_with('#')
        && (3..=8).contains(&word.len())
        && word.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_random_string(word: &str) -> bool {
    if word.len() < 40 {
        return false;
    }
    let mut categories = 0usize;
    let mut previous = None;
    for character in word.chars() {
        let category = if character.is_ascii_digit() {
            0
        } else if character.is_lowercase() {
            1
        } else if character.is_uppercase() {
            2
        } else if matches!(character, '-' | '_' | '.' | '\'') {
            3
        } else {
            4
        };
        if previous != Some(category) {
            categories += 1;
            previous = Some(category);
        }
    }
    categories as f64 / word.chars().count() as f64 >= 0.5
}

fn url_ranges(line: &str) -> Vec<(usize, usize)> {
    let lowercase = line.to_ascii_lowercase();
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(relative) = ["http://", "https://", "ftp://"]
        .iter()
        .filter_map(|scheme| lowercase[from..].find(scheme))
        .min()
    {
        let start = from + relative;
        let end = line[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`'))
            .map_or(line.len(), |length| start + length);
        ranges.push((start, end));
        from = end.max(start + 1);
    }
    ranges
}

fn email_ranges(line: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for (at, _) in line.match_indices('@') {
        let start = line[..at]
            .char_indices()
            .rev()
            .find(|&(_, character)| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '`' | '<' | '>')
            })
            .map_or(0, |(index, character)| index + character.len_utf8());
        let end = line[at..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '`' | '<' | '>')
            })
            .map_or(line.len(), |length| at + length);
        if line[start..end].contains('.') {
            ranges.push((start, end));
        }
    }
    ranges
}

fn is_ascii_alphabet_sequence(word: &str) -> bool {
    word == "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
}

fn markdown_link_ranges(line: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(relative) = line[from..].find("](") {
        let start = from + relative + 2;
        let end = line[start..]
            .find(')')
            .map_or(line.len(), |length| start + length);
        ranges.push((start, end));
        if end == line.len() {
            break;
        }
        from = end + 1;
    }
    ranges
}

fn base64_ranges(line: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = None;
    for (offset, character) in line.char_indices() {
        let allowed = character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=');
        match (start, allowed) {
            (None, true) => start = Some(offset),
            (Some(begin), false) => {
                let candidate = &line[begin..offset];
                if candidate.len() >= 40
                    && candidate
                        .bytes()
                        .any(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'/'))
                    && candidate.bytes().any(|byte| byte.is_ascii_lowercase())
                    && candidate.bytes().any(|byte| byte.is_ascii_uppercase())
                {
                    ranges.push((begin, offset));
                }
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        let candidate = &line[begin..];
        if candidate.len() >= 40
            && candidate
                .bytes()
                .any(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'/'))
            && candidate.bytes().any(|byte| byte.is_ascii_lowercase())
            && candidate.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            ranges.push((begin, line.len()));
        }
    }
    ranges
}

fn is_date_format_string(word: &str) -> bool {
    let letters: Vec<char> = word
        .chars()
        .filter(|character| character.is_alphabetic())
        .collect();
    letters.len() >= 6
        && letters
            .iter()
            .all(|character| "yYMdDTHhmsSXxZ".contains(*character))
        && letters.windows(2).any(|pair| pair[0] != pair[1])
}

fn all_caps_base_with_suffix<'a>(
    word: &'a str,
    dictionary: &Dictionary,
    local_words: &HashSet<String>,
) -> Option<&'a str> {
    for suffix in ["ing", "ies", "es", "ings", "ize", "ed", "ning", "s"] {
        let Some(base) = word.strip_suffix(suffix) else {
            continue;
        };
        if base.chars().count() >= 2
            && base.chars().all(|character| character.is_uppercase())
            && is_accepted(base, dictionary, local_words)
        {
            return Some(base);
        }
    }
    None
}

fn escaped_contraction_is_accepted(
    line: &str,
    byte: usize,
    word: &str,
    dictionary: &Dictionary,
    local_words: &HashSet<String>,
) -> bool {
    let end = byte + word.len();
    let Some(after_escape) = line[end..].strip_prefix("\\'") else {
        return false;
    };
    let suffix: String = after_escape
        .chars()
        .take_while(|character| character.is_alphabetic())
        .collect();
    !suffix.is_empty() && is_accepted(&format!("{word}'{suffix}"), dictionary, local_words)
}

fn byte_to_column(line: &str, byte: usize) -> usize {
    line[..byte].encode_utf16().count() + 1
}

struct Input {
    path: PathBuf,
    // Files found by walking a directory are skipped when they are binary or not UTF-8.
    discovered: bool,
}

fn scan_file(input: &Input, dictionary: &Dictionary) -> Result<Vec<Issue>, String> {
    let bytes = fs::read(&input.path)
        .map_err(|error| format!("could not read {}: {error}", input.path.display()))?;
    if input.discovered && bytes.contains(&0) {
        return Ok(Vec::new());
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(scan_text(&input.path, &content, dictionary)),
        Err(_) if input.discovered => Ok(Vec::new()),
        Err(_) => Err(format!(
            "could not read {}: not valid UTF-8",
            input.path.display()
        )),
    }
}

fn scan_text(path: &Path, content: &str, dictionary: &Dictionary) -> Vec<Issue> {
    let lines: Vec<&str> = content.lines().collect();
    let mut local_words = HashSet::new();
    for line in &lines {
        local_words.extend(parse_directive_words(line));
    }

    let mut issues = Vec::new();
    let mut disabled_block = false;
    let mut disable_next_line = false;
    for (index, line) in lines.iter().enumerate() {
        let lowercase = line.to_lowercase();
        let is_directive_line = has_directive(&lowercase, "");
        let disabled_for_line = disabled_block || disable_next_line;
        disable_next_line = false;

        if is_directive_line {
            if has_directive(&lowercase, "disable-next") {
                disable_next_line = true;
            }
            if has_directive(&lowercase, "disable")
                && !has_directive(&lowercase, "disable-line")
                && !has_directive(&lowercase, "disable-next")
            {
                disabled_block = true;
            }
            if has_directive(&lowercase, "enable") {
                disabled_block = false;
            }
        }
        if disabled_for_line || is_directive_line {
            continue;
        }

        let mut ignored_ranges = url_ranges(line);
        ignored_ranges.extend(email_ranges(line));
        ignored_ranges.extend(base64_ranges(line));
        if path.extension().is_some_and(|extension| extension == "md") {
            ignored_ranges.extend(markdown_link_ranges(line));
        }
        for (possible_byte, possible_word) in possible_words(line) {
            if ignored_ranges.iter().any(|(start, end)| {
                possible_byte < *end && possible_byte + possible_word.len() > *start
            }) {
                continue;
            }
            let (possible_byte, possible_word) = remove_escape_prefix(
                line,
                possible_byte,
                &possible_word,
                dictionary,
                &local_words,
            );
            let possible_core = possible_word.trim_matches(['\'', '’', '`', '.', '+', '-', '_']);
            if possible_word.is_empty()
                || is_ascii_alphabet_sequence(possible_core)
                || is_hex_sequence(possible_core)
                || is_css_hex(line, possible_byte, possible_core)
                || is_random_string(possible_core)
                || is_date_format_string(possible_core)
                || is_accepted(&possible_word, dictionary, &local_words)
                || all_caps_base_with_suffix(possible_core, dictionary, &local_words).is_some()
            {
                continue;
            }
            for (inner_byte, inner_word) in raw_words(&possible_word) {
                let inner_byte = possible_byte + inner_byte;
                if escaped_contraction_is_accepted(
                    line,
                    inner_byte,
                    &inner_word,
                    dictionary,
                    &local_words,
                ) || is_accepted(&inner_word, dictionary, &local_words)
                {
                    continue;
                }
                let mut quote_offset = 0;
                for quote_part in inner_word.split_inclusive(['\'', '’', '`']) {
                    let part_byte = inner_byte + quote_offset;
                    quote_offset += quote_part.len();
                    let quote_part = quote_part.trim_end_matches(['\'', '’', '`']);
                    for (byte, word) in camel_parts(quote_part, part_byte) {
                        if word.chars().count() < 4
                            || is_repeating(&word)
                            || is_accepted(&word, dictionary, &local_words)
                        {
                            continue;
                        }
                        issues.push(Issue {
                            path: path.to_string_lossy().replace('\\', "/"),
                            row: index + 1,
                            col: byte_to_column(line, byte),
                            word,
                        });
                    }
                }
            }
        }
    }
    issues
}

fn usage() -> &'static str {
    "usage: diagonal-spellcheck [--config PATH|--no-config] [--dictionary PATH] [--words PATH]... [--exclude GLOB]... [--file-list PATH|-] [PATHS...]"
}

fn walk(directory: &Path, filter: &Arc<Filter>, inputs: &mut Vec<Input>) -> Result<(), String> {
    let entry_filter = Arc::clone(filter);
    let walker = WalkBuilder::new(directory)
        .require_git(false)
        .filter_entry(move |entry| {
            let is_dir = entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir());
            entry.depth() == 0 || !entry_filter.is_excluded(entry.path(), is_dir)
        })
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    for entry in walker {
        let entry =
            entry.map_err(|error| format!("could not walk {}: {error}", directory.display()))?;
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            && filter.selects_file(entry.path())
        {
            let path = entry.into_path();
            inputs.push(Input {
                path: path
                    .strip_prefix("./")
                    .map_or_else(|_| path.clone(), Path::to_path_buf),
                discovered: true,
            });
        }
    }
    Ok(())
}

/// Work shared between the scan workers and the writer in `scan_all`.
struct ScanState {
    next: usize,
    emitted: usize,
    done: HashMap<usize, thread::Result<Result<Vec<Issue>, String>>>,
    stopped: bool,
}

/// Stops the scan workers when the writer in `scan_all` finishes, returns early, or unwinds.
struct StopOnDrop<'a> {
    state: &'a Mutex<ScanState>,
    changed: &'a Condvar,
}

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .stopped = true;
        self.changed.notify_all();
    }
}

/// Scans `inputs` in parallel and passes each file's issues to `emit` in input order, stopping
/// at the first file error or when `emit` returns `false`. Workers stay at most a few files per
/// thread ahead of the next file to emit, so completed results waiting behind a slow file stay
/// bounded.
fn scan_all(
    inputs: &[Input],
    dictionary: &Dictionary,
    mut emit: impl FnMut(Vec<Issue>) -> bool,
) -> Result<(), String> {
    let workers = thread::available_parallelism()
        .map_or(1, usize::from)
        .min(inputs.len().max(1));
    let window = workers * 4;
    let state = Mutex::new(ScanState {
        next: 0,
        emitted: 0,
        done: HashMap::new(),
        stopped: false,
    });
    let changed = Condvar::new();
    let lock = || state.lock().unwrap_or_else(PoisonError::into_inner);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut guard = lock();
                loop {
                    while !guard.stopped
                        && guard.next < inputs.len()
                        && guard.next >= guard.emitted + window
                    {
                        guard = changed.wait(guard).unwrap_or_else(PoisonError::into_inner);
                    }
                    if guard.stopped || guard.next >= inputs.len() {
                        break;
                    }
                    let index = guard.next;
                    guard.next += 1;
                    drop(guard);
                    let result = panic::catch_unwind(AssertUnwindSafe(|| {
                        scan_file(&inputs[index], dictionary)
                    }));
                    guard = lock();
                    guard.done.insert(index, result);
                    changed.notify_all();
                }
            });
        }
        let _stop = StopOnDrop {
            state: &state,
            changed: &changed,
        };
        let mut guard = lock();
        while guard.emitted < inputs.len() {
            let emitted = guard.emitted;
            let Some(result) = guard.done.remove(&emitted) else {
                guard = changed.wait(guard).unwrap_or_else(PoisonError::into_inner);
                continue;
            };
            guard.emitted += 1;
            changed.notify_all();
            drop(guard);
            match result {
                Ok(Ok(issues)) => {
                    if !emit(issues) {
                        break;
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(payload) => panic::resume_unwind(payload),
            }
            guard = lock();
        }
        Ok(())
    })
}

fn run() -> Result<i32, String> {
    let mut arguments = env::args().skip(1);
    let mut dictionary = None;
    let mut extra_words = Vec::new();
    let mut excludes = Vec::new();
    let mut file_list = None;
    let mut config_path = None;
    let mut no_config = false;
    let mut paths = Vec::new();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--config" if config_path.is_none() && !no_config => {
                config_path = Some(PathBuf::from(
                    arguments
                        .next()
                        .filter(|value| !value.starts_with('-'))
                        .ok_or_else(|| format!("--config requires a path\n{}", usage()))?,
                ));
            }
            "--no-config" if config_path.is_none() && !no_config => no_config = true,
            "--dictionary" if dictionary.is_none() => {
                dictionary = Some(PathBuf::from(
                    arguments
                        .next()
                        .filter(|value| !value.starts_with('-'))
                        .ok_or_else(|| format!("--dictionary requires a path\n{}", usage()))?,
                ));
            }
            "--words" => {
                extra_words.push(PathBuf::from(
                    arguments
                        .next()
                        .filter(|value| !value.starts_with('-'))
                        .ok_or_else(|| format!("--words requires a path\n{}", usage()))?,
                ));
            }
            "--exclude" => {
                excludes.push(
                    arguments
                        .next()
                        .filter(|value| !value.starts_with('-'))
                        .ok_or_else(|| format!("--exclude requires a glob\n{}", usage()))?,
                );
            }
            "--file-list" if file_list.is_none() => {
                file_list = Some(
                    arguments
                        .next()
                        .filter(|value| value == "-" || !value.starts_with('-'))
                        .ok_or_else(|| format!("--file-list requires a path\n{}", usage()))?,
                );
            }
            "--version" => {
                println!("diagonal-spellcheck {}", env!("CARGO_PKG_VERSION"));
                return Ok(0);
            }
            "--help" | "-h" => {
                println!("{}", usage());
                return Ok(0);
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown option {value}\n{}", usage()));
            }
            value => paths.push(PathBuf::from(value)),
        }
    }
    let cwd = env::current_dir()
        .map_err(|error| format!("could not read the working directory: {error}"))?;
    let config_path = if no_config {
        None
    } else {
        config_path.or_else(|| config::discover(&cwd))
    };
    let loaded = config_path.as_deref().map(config::load).transpose()?;

    let reads_list = file_list.is_some();
    if let Some(list) = file_list {
        let reader: Box<dyn BufRead> = if list == "-" {
            Box::new(io::BufReader::new(io::stdin()))
        } else {
            Box::new(io::BufReader::new(fs::File::open(&list).map_err(
                |error| format!("could not read file list {list}: {error}"),
            )?))
        };
        for line in reader.lines() {
            let line = line.map_err(|error| format!("could not read file list: {error}"))?;
            if !line.is_empty() {
                paths.push(PathBuf::from(line));
            }
        }
    }
    if paths.is_empty() {
        if reads_list {
            return Err(format!("no input paths\n{}", usage()));
        }
        // Without explicit paths, check the project the config describes, or the working directory.
        paths.push(
            loaded
                .as_ref()
                .map_or_else(|| PathBuf::from("."), |loaded| loaded.directory.clone()),
        );
    }

    let filter = Arc::new(Filter::new(&cwd, &excludes, loaded.as_ref())?);
    let mut inputs = Vec::new();
    for path in paths {
        if path.is_dir() {
            walk(&path, &filter, &mut inputs)?;
        } else if filter.selects_file(&path) {
            inputs.push(Input {
                path,
                discovered: false,
            });
        }
    }

    let mut dictionary = match dictionary {
        Some(path) => parse_dictionary(&read_word_file(&path)?),
        None => parse_dictionary(BUILTIN_LEXICON),
    };
    if dictionary.words.is_empty() {
        return Err("dictionary contains no accepted words".into());
    }
    if let Some(loaded) = &loaded {
        add_words(&mut dictionary, &loaded.config.words.join("\n"));
        for path in &loaded.config.word_files {
            add_words(
                &mut dictionary,
                &read_word_file(&loaded.directory.join(path))?,
            );
        }
    }
    for path in extra_words {
        add_words(&mut dictionary, &read_word_file(&path)?);
    }

    let mut out = BufWriter::new(io::stdout().lock());
    let mut found = false;
    let mut written = Ok(());
    scan_all(&inputs, &dictionary, |file_issues| {
        found |= !file_issues.is_empty();
        written = write_issues(&mut out, &file_issues);
        written.is_ok()
    })?;
    match written.and_then(|()| out.flush()) {
        // A closed pipe (e.g. `| head`) only means the reader has seen enough.
        Err(error) if error.kind() != io::ErrorKind::BrokenPipe => {
            return Err(format!("could not write output: {error}"));
        }
        _ => {}
    }
    Ok(if found { 1 } else { 0 })
}

fn write_issues(out: &mut impl Write, issues: &[Issue]) -> io::Result<()> {
    for issue in issues {
        writeln!(
            out,
            "{{\"path\":\"{}\",\"row\":{},\"col\":{},\"word\":\"{}\"}}",
            json_escape(&issue.path),
            issue.row,
            issue.col,
            json_escape(&issue.word),
        )?;
    }
    Ok(())
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_camel_case_with_offsets() {
        assert_eq!(
            camel_parts("calculateRecieptTotl", 6),
            vec![
                (6, "calculate".into()),
                (15, "Reciept".into()),
                (22, "Totl".into())
            ]
        );
        assert_eq!(
            camel_parts("InvoiceAddres", 0),
            vec![(0, "Invoice".into()), (7, "Addres".into())]
        );
    }

    #[test]
    fn locates_unicode_columns_by_utf16_code_unit() {
        assert_eq!(byte_to_column("café résumé", "café ".len()), 6);
        assert_eq!(byte_to_column("😀 recieve", "😀 ".len()), 4);
    }

    #[test]
    fn extracts_directive_words() {
        assert_eq!(
            parse_directive_words("// spellcheck:words Zorbulate, LocalThing"),
            ["zorbulate", "localthing"]
        );
        assert_eq!(
            parse_directive_words("İ // spellcheck:words Zorbulate"),
            ["zorbulate"]
        );
    }

    #[test]
    fn identifies_hex_sequences() {
        assert!(is_hex_sequence("f8fafc"));
        assert!(is_hex_sequence("e764e712-30e8-724d-a86f-eadf8dfcd067"));
        assert!(!is_hex_sequence("recieve"));
        assert_eq!(possible_words("'#f8fafc'"), vec![(2, "f8fafc'".into())]);
    }

    #[test]
    fn identifies_base64_ranges() {
        let line = "$png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';";
        let ranges = base64_ranges(line);
        assert_eq!(ranges.len(), 1);
        assert!(line[ranges[0].0..ranges[0].1].starts_with("iVBOR"));
    }

    fn test_dictionary() -> Dictionary {
        Dictionary {
            words: ["hello", "world", "don't", "invoice", "total", "café"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            compound_start: ["rate".to_owned()].into_iter().collect(),
            compound_middle: ["limit".to_owned()].into_iter().collect(),
            compound_end: ["reset".to_owned()].into_iter().collect(),
        }
    }

    #[test]
    fn markdown_targets_at_end_of_line_and_unclosed_targets_do_not_panic() {
        assert_eq!(markdown_link_ranges("[hello](mispeling)"), [(8, 17)]);
        assert_eq!(markdown_link_ranges("[hello](mispeling"), [(8, 17)]);
        assert_eq!(
            markdown_link_ranges("[hello](one)[world](two)"),
            [(8, 11), (20, 23)]
        );
        let issues = scan_text(
            Path::new("sample.md"),
            "recieve [hello](mispeling)",
            &test_dictionary(),
        );
        assert_eq!(
            issues
                .iter()
                .map(|issue| issue.word.as_str())
                .collect::<Vec<_>>(),
            ["recieve"]
        );
    }

    #[test]
    fn unicode_apostrophes_preserve_byte_boundaries_and_columns() {
        let issues = scan_text(
            Path::new("sample.md"),
            "café’\u{e9}rrror 😀 mispeling",
            &test_dictionary(),
        );
        assert_eq!(
            issues
                .iter()
                .map(|issue| (issue.word.as_str(), issue.col))
                .collect::<Vec<_>>(),
            [("érrror", 6), ("mispeling", 16)]
        );
    }

    #[test]
    fn url_ranges_use_the_earliest_scheme_and_keep_adjacent_words() {
        let text = "https://example.test http://example.test recieve";
        assert_eq!(url_ranges(text), [(0, 20), (21, 40)]);
        let issues = scan_text(Path::new("sample.ts"), text, &test_dictionary());
        assert_eq!(
            issues
                .iter()
                .map(|issue| issue.word.as_str())
                .collect::<Vec<_>>(),
            ["recieve"]
        );
    }

    #[test]
    fn email_ranges_start_after_multi_byte_whitespace() {
        let text = "\u{2003}a@b.c recieve";
        assert_eq!(email_ranges(text), [(3, 8)]);
        let issues = scan_text(Path::new("sample.md"), text, &test_dictionary());
        assert_eq!(
            issues
                .iter()
                .map(|issue| issue.word.as_str())
                .collect::<Vec<_>>(),
            ["recieve"]
        );
    }

    #[test]
    fn scan_all_emits_files_in_input_order_and_stops_early() {
        let directory = env::temp_dir().join(format!("scan-all-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let mut inputs: Vec<Input> = (0..200)
            .rev()
            .map(|index| {
                let path = directory.join(format!("{index}.md"));
                fs::write(&path, "hello recieve\n").unwrap();
                Input {
                    path,
                    discovered: false,
                }
            })
            .collect();
        let dictionary = test_dictionary();
        let mut paths = Vec::new();
        scan_all(&inputs, &dictionary, |issues| {
            paths.extend(issues.into_iter().map(|issue| issue.path));
            true
        })
        .unwrap();
        let expected: Vec<String> = inputs
            .iter()
            .map(|input| input.path.display().to_string())
            .collect();
        assert_eq!(paths, expected);

        let mut emitted = 0;
        scan_all(&inputs, &dictionary, |_| {
            emitted += 1;
            emitted < 3
        })
        .unwrap();
        assert_eq!(emitted, 3);

        inputs.insert(
            100,
            Input {
                path: directory.join("missing.md"),
                discovered: false,
            },
        );
        let mut emitted = 0;
        let error = scan_all(&inputs, &dictionary, |_| {
            emitted += 1;
            true
        })
        .unwrap_err();
        fs::remove_dir_all(&directory).unwrap();
        assert!(error.contains("missing.md"));
        assert_eq!(emitted, 100);
    }

    #[test]
    fn compounds_require_a_valid_start_and_end() {
        let dictionary = test_dictionary();
        assert!(is_compound("ratelimitreset", &dictionary));
        for invalid in ["ratelimit", "limitreset", "resetlimit", "raterecieve"] {
            assert!(!is_compound(invalid, &dictionary), "{invalid}");
        }
    }

    #[test]
    fn directives_do_not_leak_next_line_state_past_one_line() {
        let issues = scan_text(
            Path::new("sample.php"),
            "// spellcheck:disable-next-line\r\nrecieve\r\nmispeling\r\n",
            &test_dictionary(),
        );
        assert_eq!(
            issues
                .iter()
                .map(|issue| (issue.word.as_str(), issue.row))
                .collect::<Vec<_>>(),
            [("mispeling", 3)]
        );
    }

    #[test]
    fn block_directives_disable_until_enabled() {
        let issues = scan_text(
            Path::new("sample.md"),
            "<!-- spellcheck:disable -->\nrecieve\n<!-- spellcheck:enable -->\nmispeling\n",
            &test_dictionary(),
        );
        assert_eq!(
            issues
                .iter()
                .map(|issue| (issue.word.as_str(), issue.row))
                .collect::<Vec<_>>(),
            [("mispeling", 4)]
        );
    }

    #[test]
    fn builtin_lexicon_accepts_english_and_coding_compounds() {
        let dictionary = parse_dictionary(BUILTIN_LEXICON);
        for word in ["receive", "definitely", "javascript", "typescript"] {
            assert!(is_accepted(word, &dictionary, &HashSet::new()), "{word}");
        }
        for word in ["recieve", "definately", "misspeling"] {
            assert!(!is_accepted(word, &dictionary, &HashSet::new()), "{word}");
        }
        assert!(!dictionary.compound_start.is_empty());
    }

    #[test]
    fn seeded_token_boundaries_preserve_each_inserted_misspelling() {
        let dictionary = test_dictionary();
        let mut state = 0x5eed_u32;
        let boundaries = [" ", "_", ".", "-", "/", "😀", "\t", ":"];
        for _ in 0..128 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let boundary = boundaries[state as usize % boundaries.len()];
            let text = format!("hello{boundary}recieve{boundary}world");
            let issues = scan_text(Path::new("sample.ts"), &text, &dictionary);
            assert_eq!(issues.len(), 1, "{text}");
            assert_eq!(issues[0].word, "recieve", "{text}");
            assert_eq!(issues[0].col, 6 + boundary.encode_utf16().count(), "{text}");
        }
    }
}
