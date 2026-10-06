//! The glob syntax both sides of the app share. Extraction filters the entries
//! an archive already holds; compression filters the files that would go into
//! one.

const MAX_PATTERNS: usize = 100;
const MAX_PATTERN_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Token {
    Literal(char),
    /// `*`, which stops at a folder boundary.
    Star,
    /// `**`, which crosses folder boundaries.
    DoubleStar,
    /// `?`, exactly one character other than a slash.
    Question,
}

#[derive(Debug, Clone)]
struct Pattern {
    has_slash: bool,
    tokens: Vec<Token>,
}

impl Pattern {
    fn parse(pattern: &str) -> Self {
        let chars: Vec<char> = pattern.chars().collect();
        let mut tokens = Vec::with_capacity(chars.len());
        let mut index = 0;
        while index < chars.len() {
            let token = match chars[index] {
                '*' if chars.get(index + 1) == Some(&'*') => {
                    index += 1;
                    Token::DoubleStar
                }
                '*' => Token::Star,
                '?' => Token::Question,
                // Windows compares names without case, as its filesystem does.
                character if cfg!(windows) => Token::Literal(character.to_lowercase().next().unwrap_or(character)),
                character => Token::Literal(character),
            };
            tokens.push(token);
            index += 1;
        }
        Self { has_slash: pattern.contains('/'), tokens }
    }

    /// Whether the whole of `text` matches, worked out over a table rather than
    /// by backtracking, so a pattern full of stars stays linear in each input.
    fn matches(&self, text: &str) -> bool {
        let text: Vec<char> =
            if cfg!(windows) { text.to_lowercase().chars().collect() } else { text.chars().collect() };
        // `next[j]` says whether the tokens after the current one match text[j..].
        let mut next = vec![false; text.len() + 1];
        next[text.len()] = true;
        for token in self.tokens.iter().rev() {
            let mut current = vec![false; text.len() + 1];
            for start in (0..=text.len()).rev() {
                current[start] = match token {
                    Token::Literal(expected) => text.get(start) == Some(expected) && next[start + 1],
                    Token::Question => text.get(start).is_some_and(|&c| c != '/') && next[start + 1],
                    Token::Star => next[start] || (text.get(start).is_some_and(|&c| c != '/') && current[start + 1]),
                    Token::DoubleStar => next[start] || (start < text.len() && current[start + 1]),
                };
            }
            next = current;
        }
        next[0]
    }
}

/// A matcher built from a comma, semicolon, or newline separated pattern list.
/// A leading `!` excludes; a pattern holding a slash is matched against the
/// whole path, and one without it against the entry's own name. With no
/// include patterns everything is included, so a list of exclusions alone
/// subtracts from the full set rather than matching nothing.
#[derive(Debug, Clone, Default)]
pub(crate) struct EntryFilter {
    includes: Vec<Pattern>,
    excludes: Vec<Pattern>,
}

impl EntryFilter {
    pub(crate) fn new(pattern_text: Option<&str>) -> Self {
        let mut filter = Self::default();
        let patterns = pattern_text
            .unwrap_or("")
            .split([',', ';', '\n'])
            .map(str::trim)
            .filter(|pattern| !pattern.is_empty())
            .take(MAX_PATTERNS);
        for pattern in patterns {
            let (exclude, body) = match pattern.strip_prefix('!') {
                Some(body) => (true, body),
                None => (false, pattern),
            };
            // Backslashes become slashes before anything reads the pattern, so
            // `docs\*.md` is a path pattern exactly as `docs/*.md` is.
            let body: String = body.chars().take(MAX_PATTERN_CHARS).collect::<String>().replace('\\', "/");
            if body.is_empty() {
                continue;
            }
            let parsed = Pattern::parse(&body);
            if exclude { filter.excludes.push(parsed) } else { filter.includes.push(parsed) }
        }
        filter
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.includes.is_empty() && self.excludes.is_empty()
    }

    pub(crate) fn allows(&self, entry_path: &str) -> bool {
        let normalized = entry_path.replace('\\', "/");
        let normalized = normalized.strip_prefix("./").unwrap_or(&normalized).trim_end_matches('/');
        let name = match normalized.rsplit('/').next() {
            Some(name) if !name.is_empty() => name,
            _ => normalized,
        };
        let matches = |pattern: &Pattern| pattern.matches(if pattern.has_slash { normalized } else { name });
        (self.includes.is_empty() || self.includes.iter().any(matches)) && !self.excludes.iter().any(matches)
    }
}

#[cfg(test)]
mod tests {
    use super::EntryFilter;

    fn kept<'a>(pattern: Option<&str>, paths: &[&'a str]) -> Vec<&'a str> {
        let filter = EntryFilter::new(pattern);
        paths.iter().copied().filter(|path| filter.allows(path)).collect()
    }

    #[test]
    fn keeps_everything_when_there_is_no_pattern() {
        let paths = ["a.txt", "dir/b.log", ".hidden"];
        for pattern in [None, Some(""), Some("   "), Some(",;\n")] {
            assert_eq!(kept(pattern, &paths), paths);
        }
    }

    #[test]
    fn matches_a_pattern_without_a_slash_against_the_name_in_any_folder() {
        assert_eq!(kept(Some("*.txt"), &["a.txt", "deep/down/b.txt", "c.log", "txt"]), ["a.txt", "deep/down/b.txt"]);
    }

    #[test]
    fn matches_a_pattern_with_a_slash_against_the_whole_path() {
        assert_eq!(kept(Some("docs/*.md"), &["docs/a.md", "other/docs/a.md", "a.md"]), ["docs/a.md"]);
    }

    #[test]
    fn stops_a_single_star_at_a_folder_and_lets_a_double_star_cross_them() {
        let paths = ["src/a.ts", "src/lib/b.ts", "src/lib/deep/c.ts"];
        assert_eq!(kept(Some("src/*.ts"), &paths), ["src/a.ts"]);
        assert_eq!(kept(Some("src/**.ts"), &paths), paths);
        assert_eq!(kept(Some("src/**/*.ts"), &paths), ["src/lib/b.ts", "src/lib/deep/c.ts"]);
    }

    #[test]
    fn matches_exactly_one_character_with_a_question_mark() {
        assert_eq!(kept(Some("file?.txt"), &["file1.txt", "file12.txt", "file.txt"]), ["file1.txt"]);
        assert_eq!(kept(Some("a?b"), &["a/b", "axb"]), ["axb"]);
    }

    #[test]
    fn treats_regular_expression_characters_literally() {
        assert_eq!(kept(Some("a.txt"), &["a.txt", "abtxt"]), ["a.txt"]);
        let literal = "c++ (v2) [x]{1}|$^.cpp";
        assert_eq!(kept(Some(literal), &[literal, "cc (v2) x1.cpp"]), [literal]);
    }

    #[test]
    fn subtracts_exclusions_from_everything_when_no_include_is_given() {
        assert_eq!(kept(Some("!*.log"), &["a.txt", "b.log", "dir/c.log"]), ["a.txt"]);
    }

    #[test]
    fn lets_an_exclusion_override_an_include() {
        assert_eq!(kept(Some("*.txt, !secret*"), &["a.txt", "secret.txt", "b.log"]), ["a.txt"]);
    }

    #[test]
    fn splits_on_commas_semicolons_and_newlines_and_trims_each_pattern() {
        let paths = ["a.txt", "b.md", "c.log", "d.bin"];
        assert_eq!(kept(Some(" *.txt ;*.md\n  *.log  "), &paths), ["a.txt", "b.md", "c.log"]);
    }

    #[test]
    fn ignores_a_lone_exclamation_mark_rather_than_excluding_everything() {
        assert_eq!(kept(Some("!"), &["a.txt"]), ["a.txt"]);
    }

    #[test]
    fn reads_backslashes_in_paths_and_patterns_as_separators() {
        assert_eq!(kept(Some("docs\\*.md"), &["docs/a.md", "docs\\b.md", "c.md"]), ["docs/a.md", "docs\\b.md"]);
    }

    #[test]
    fn ignores_a_leading_dot_slash_and_a_trailing_slash_on_the_entry() {
        assert_eq!(kept(Some("docs/*.md"), &["./docs/a.md", "docs/b.md/"]), ["./docs/a.md", "docs/b.md/"]);
        assert_eq!(kept(Some("dir"), &["dir/", "parent/dir/"]), ["dir/", "parent/dir/"]);
    }

    #[test]
    fn reads_at_most_100_patterns() {
        let mut patterns: Vec<String> = (0..100).map(|index| format!("f{index}.txt")).collect();
        patterns.push("late.txt".into());
        let filter = EntryFilter::new(Some(&patterns.join(",")));
        assert!(filter.allows("f99.txt"));
        assert!(!filter.allows("late.txt"));
    }

    #[test]
    fn ignores_letter_case_on_windows_only() {
        let expected: &[&str] = if cfg!(windows) { &["a.txt", "B.TXT"] } else { &["B.TXT"] };
        assert_eq!(kept(Some("*.TXT"), &["a.txt", "B.TXT"]), expected);
    }
}
