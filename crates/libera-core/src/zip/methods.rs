//! Which method each ZIP entry is written with. The archive picks one, and
//! expert mode can name another for a file or for everything under a folder.

use std::path::{Path, PathBuf};

use crate::LiberaError;
use crate::deflate::DeflateStrategy;
use crate::safety::paths::absolute_normalized;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ZipMethod {
    #[default]
    Deflate,
    Store,
    Lzma,
    Zstd,
}

/// Whether a per-file rule covers one file or a whole folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OverrideScope {
    File,
    Tree,
}

/// A method chosen for one source path, by the per-file dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ZipMethodOverride {
    pub source_path: String,
    pub scope: OverrideScope,
    pub method: ZipMethod,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub deflate_strategy: Option<DeflateStrategy>,
    /// zlib's working-memory level, 1-9. Only Deflate uses it.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub mem_level: Option<u8>,
    /// The entry's strength, 1-9. Store has none.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub level: Option<u8>,
}

/// The method an entry ends up with, and what tunes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedMethod {
    pub method: ZipMethod,
    /// Whether a rule named it, rather than the archive.
    pub explicit: bool,
    pub deflate_strategy: Option<DeflateStrategy>,
    pub mem_level: Option<u8>,
    pub level: Option<u8>,
}

/// A source path in the form rules and entries are compared in: absolute,
/// with the links above it resolved the way the input walk resolves them.
pub(crate) fn comparable_path(path: &Path) -> PathBuf {
    let resolved = match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
            parent.canonicalize().map(|parent| parent.join(name)).ok()
        }
        _ => None,
    };
    let resolved = resolved.or_else(|| absolute_normalized(path).ok()).unwrap_or_else(|| path.to_path_buf());
    if cfg!(windows) { PathBuf::from(resolved.to_string_lossy().to_lowercase()) } else { resolved }
}

fn is_same_or_child(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn invalid(message: &str) -> LiberaError {
    LiberaError::invalid_input(message)
}

/// Refuses a rule set the writer could not follow: tuning a method does not
/// use, a level out of range, or a path outside every input.
pub(crate) fn validate_overrides(overrides: &[ZipMethodOverride], input_paths: &[String]) -> Result<(), LiberaError> {
    let roots: Vec<PathBuf> = input_paths.iter().map(|input| comparable_path(Path::new(input))).collect();
    for rule in overrides {
        if rule.source_path.is_empty() {
            return Err(invalid("Each ZIP method override must name a source path."));
        }
        if rule.deflate_strategy.is_some() && rule.method != ZipMethod::Deflate {
            return Err(invalid("ZIP Deflate strategy can only be used with the Deflate method."));
        }
        if rule.mem_level.is_some_and(|mem_level| !(1..=9).contains(&mem_level)) {
            return Err(invalid("ZIP memory level override must be between 1 and 9."));
        }
        if rule.mem_level.is_some() && rule.method != ZipMethod::Deflate {
            return Err(invalid("ZIP memory level can only be used with the Deflate method."));
        }
        if rule.level.is_some_and(|level| !(1..=9).contains(&level)) {
            return Err(invalid("ZIP compression level override must be between 1 and 9."));
        }
        if rule.level.is_some() && rule.method == ZipMethod::Store {
            return Err(invalid("ZIP compression level cannot be used with the Store method."));
        }
        let source = comparable_path(Path::new(&rule.source_path));
        if !roots.iter().any(|root| is_same_or_child(root, &source)) {
            return Err(invalid("ZIP method override must be inside a selected input."));
        }
    }
    Ok(())
}

/// Rules with their paths already put in comparable form, so each entry does
/// not resolve them again.
pub(crate) struct MethodRules {
    rules: Vec<(PathBuf, ZipMethodOverride)>,
}

impl MethodRules {
    pub(crate) fn new(overrides: &[ZipMethodOverride]) -> Self {
        Self {
            rules: overrides.iter().map(|rule| (comparable_path(Path::new(&rule.source_path)), rule.clone())).collect(),
        }
    }

    /// The method for one source file. An exact file rule wins over every
    /// folder rule; otherwise the nearest folder above it wins, and of two
    /// rules for the same path the later one. Strength, strategy and memory
    /// level then cascade on their own, so a file can change its method while
    /// a folder above it still supplies the tuning.
    pub(crate) fn resolve(&self, source: &Path, default: ZipMethod) -> ResolvedMethod {
        let unnamed =
            ResolvedMethod { method: default, explicit: false, deflate_strategy: None, mem_level: None, level: None };
        if self.rules.is_empty() {
            return unnamed;
        }
        let mut contenders: Vec<(bool, usize, usize, &ZipMethodOverride)> = self
            .rules
            .iter()
            .enumerate()
            .filter_map(|(index, (path, rule))| {
                let exact = path == source;
                let applies = match rule.scope {
                    OverrideScope::File => exact,
                    OverrideScope::Tree => is_same_or_child(path, source),
                };
                applies.then(|| (rule.scope == OverrideScope::File && exact, path.as_os_str().len(), index, rule))
            })
            .collect();
        contenders.sort_by(|left, right| right.0.cmp(&left.0).then(right.1.cmp(&left.1)).then(right.2.cmp(&left.2)));
        let Some(&(_, _, _, winner)) = contenders.first() else { return unnamed };

        let method = winner.method;
        let rules = || contenders.iter().map(|contender| contender.3);
        let level = if method == ZipMethod::Store { None } else { rules().find_map(|rule| rule.level) };
        let deflate_rules = || rules().filter(|rule| rule.method == ZipMethod::Deflate);
        let (deflate_strategy, mem_level) = if method == ZipMethod::Deflate {
            (deflate_rules().find_map(|rule| rule.deflate_strategy), deflate_rules().find_map(|rule| rule.mem_level))
        } else {
            (None, None)
        };
        ResolvedMethod { method, explicit: true, deflate_strategy, mem_level, level }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(path: &str, scope: OverrideScope, method: ZipMethod) -> ZipMethodOverride {
        ZipMethodOverride {
            source_path: path.into(),
            scope,
            method,
            deflate_strategy: None,
            mem_level: None,
            level: None,
        }
    }

    #[test]
    fn prefers_an_exact_file_rule_then_the_nearest_folder_then_the_later_rule() {
        let rules = MethodRules::new(&[
            rule("/in", OverrideScope::Tree, ZipMethod::Lzma),
            rule("/in/deep", OverrideScope::Tree, ZipMethod::Zstd),
            rule("/in/deep/file.txt", OverrideScope::File, ZipMethod::Store),
            rule("/in/deep", OverrideScope::Tree, ZipMethod::Deflate),
        ]);
        let resolve = |path: &str| rules.resolve(Path::new(path), ZipMethod::Deflate).method;
        assert_eq!(resolve("/in/deep/file.txt"), ZipMethod::Store);
        assert_eq!(resolve("/in/deep/other.txt"), ZipMethod::Deflate);
        assert_eq!(resolve("/in/top.txt"), ZipMethod::Lzma);
        assert!(!rules.resolve(Path::new("/elsewhere/a"), ZipMethod::Zstd).explicit);
    }

    #[test]
    fn cascades_tuning_from_a_folder_onto_a_file_that_only_changes_its_method() {
        let folder = ZipMethodOverride {
            level: Some(9),
            deflate_strategy: Some(DeflateStrategy::Rle),
            mem_level: Some(2),
            ..rule("/in", OverrideScope::Tree, ZipMethod::Deflate)
        };
        let lzma_file = rule("/in/a.txt", OverrideScope::File, ZipMethod::Lzma);
        let deflate_file = rule("/in/b.txt", OverrideScope::File, ZipMethod::Deflate);
        let store_file = rule("/in/c.txt", OverrideScope::File, ZipMethod::Store);
        let rules = MethodRules::new(&[folder, lzma_file, deflate_file, store_file]);

        let lzma = rules.resolve(Path::new("/in/a.txt"), ZipMethod::Deflate);
        assert_eq!(
            (lzma.method, lzma.level, lzma.deflate_strategy, lzma.mem_level),
            (ZipMethod::Lzma, Some(9), None, None)
        );
        let deflate = rules.resolve(Path::new("/in/b.txt"), ZipMethod::Deflate);
        assert_eq!(
            (deflate.level, deflate.deflate_strategy, deflate.mem_level),
            (Some(9), Some(DeflateStrategy::Rle), Some(2))
        );
        assert_eq!(rules.resolve(Path::new("/in/c.txt"), ZipMethod::Deflate).level, None);
    }

    #[test]
    fn refuses_rules_the_writer_could_not_follow() {
        let inputs = vec!["/in".to_owned()];
        let refused = [
            ZipMethodOverride {
                deflate_strategy: Some(DeflateStrategy::Rle),
                ..rule("/in/a", OverrideScope::File, ZipMethod::Lzma)
            },
            ZipMethodOverride { mem_level: Some(10), ..rule("/in/a", OverrideScope::File, ZipMethod::Deflate) },
            ZipMethodOverride { mem_level: Some(3), ..rule("/in/a", OverrideScope::File, ZipMethod::Zstd) },
            ZipMethodOverride { level: Some(0), ..rule("/in/a", OverrideScope::File, ZipMethod::Deflate) },
            ZipMethodOverride { level: Some(5), ..rule("/in/a", OverrideScope::File, ZipMethod::Store) },
            rule("/out/a", OverrideScope::File, ZipMethod::Store),
            rule("", OverrideScope::File, ZipMethod::Store),
        ];
        for override_rule in refused {
            assert!(validate_overrides(std::slice::from_ref(&override_rule), &inputs).is_err(), "{override_rule:?}");
        }
        assert!(validate_overrides(&[rule("/in/deep/a", OverrideScope::File, ZipMethod::Store)], &inputs).is_ok());
    }
}
