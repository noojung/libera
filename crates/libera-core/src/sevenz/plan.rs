//! How each 7z entry is compressed, and which entries share a stream. The
//! writer and the solid-block preview both ask this, so the preview always
//! answers with what a write would do.

use std::path::{Path, PathBuf};

use crate::LiberaError;
use crate::zip::OverrideScope;
use crate::zip::methods::comparable_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum SevenZipMethod {
    #[default]
    Lzma2,
    Copy,
}

/// A rule's dictionary: sized to the data it covers, or a fixed size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum SevenZipDictionary {
    Auto,
    Bytes { size: u32 },
}

/// A method chosen for one source path, by the per-file dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SevenZipMethodOverride {
    pub source_path: String,
    pub scope: OverrideScope,
    pub method: SevenZipMethod,
    /// One of 7-Zip's -mx steps: 1, 3, 5, 7 or 9.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub level: Option<u8>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub dictionary_size: Option<SevenZipDictionary>,
    /// The longest match the encoder looks for: 32, 64, 128 or 273.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub match_finder_word_size: Option<u32>,
    /// How many candidate matches the encoder tries, 1-1024.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub search_cycles: Option<u32>,
}

pub const MIN_DICTIONARY_SIZE: u32 = 64 << 10;
pub const MAX_DICTIONARY_SIZE: u32 = 128 << 20;
const MATCH_FINDER_WORD_SIZES: [u32; 4] = [32, 64, 128, 273];
pub(crate) const SEVEN_ZIP_LEVELS: [u8; 6] = [0, 1, 3, 5, 7, 9];

/// 7-Zip's -mx scale is 0/1/3/5/7/9, so the app's 0-9 slider lands on the
/// nearest real step at or below it, as the Electron engine maps it.
pub(crate) fn seven_zip_level(level: u8) -> u8 {
    match level.min(9) {
        0 => 0,
        1..=2 => 1,
        3..=4 => 3,
        5..=6 => 5,
        7..=8 => 7,
        _ => 9,
    }
}

/// The dictionary each level caps itself at.
fn level_dictionary(level: u8) -> u32 {
    match level {
        0 | 1 => 1 << 20,
        3 => 4 << 20,
        5 => 16 << 20,
        7 => 32 << 20,
        _ => 64 << 20,
    }
}

/// How hard the match finder works at each level. The top level trades time
/// for ratio without reservation; the lower ones stay quick.
fn level_encoder(level: u8) -> (u32, u32) {
    match level {
        0 | 1 => (8, 32),
        3 => (16, 32),
        5 => (32, 32),
        7 => (128, 128),
        _ => (512, 273),
    }
}

/// The smallest power of two from 64 KiB that holds `input_size`, capped at
/// what `level` allows: a dictionary larger than its data buys nothing.
pub(crate) fn automatic_dictionary(input_size: u64, level: u8) -> u32 {
    let cap = level_dictionary(level);
    let target = input_size.min(u64::from(cap));
    (16..=27).map(|shift| 1u32 << shift).find(|size| u64::from(*size) >= target).unwrap_or(cap)
}

/// The LZMA2 property byte for a dictionary of at least `size` bytes.
pub(crate) fn dictionary_property(size: u32) -> u8 {
    (0..40u8).find(|&property| dictionary_size_from_property(property) >= size).unwrap_or(40)
}

pub(crate) fn dictionary_size_from_property(property: u8) -> u32 {
    if property >= 40 {
        return u32::MAX;
    }
    (2 | u32::from(property & 1)) << (property / 2 + 11)
}

fn invalid(message: &str) -> LiberaError {
    LiberaError::invalid_input(message)
}

pub(crate) fn validate_dictionary(size: u32) -> Result<(), LiberaError> {
    if (MIN_DICTIONARY_SIZE..=MAX_DICTIONARY_SIZE).contains(&size) {
        Ok(())
    } else {
        Err(invalid("7Z dictionary size must be between 64 KiB and 128 MiB."))
    }
}

pub(crate) fn validate_word_size(word_size: u32) -> Result<(), LiberaError> {
    if MATCH_FINDER_WORD_SIZES.contains(&word_size) {
        Ok(())
    } else {
        Err(invalid("7Z match finder word size is unsupported."))
    }
}

pub(crate) fn validate_search_cycles(cycles: u32) -> Result<(), LiberaError> {
    if (1..=1024).contains(&cycles) { Ok(()) } else { Err(invalid("7Z search cycles must be between 1 and 1024.")) }
}

pub(crate) fn validate_overrides(
    overrides: &[SevenZipMethodOverride],
    input_paths: &[String],
) -> Result<(), LiberaError> {
    let roots: Vec<PathBuf> = input_paths.iter().map(|input| comparable_path(Path::new(input))).collect();
    for rule in overrides {
        if rule.source_path.is_empty() {
            return Err(invalid("Each 7Z method override must name a source path."));
        }
        let tuned = rule.level.is_some()
            || rule.dictionary_size.is_some()
            || rule.match_finder_word_size.is_some()
            || rule.search_cycles.is_some();
        if rule.method == SevenZipMethod::Copy && tuned {
            return Err(invalid("Copy cannot use 7Z compression tuning."));
        }
        if rule.level.is_some_and(|level| level == 0 || !SEVEN_ZIP_LEVELS.contains(&level)) {
            return Err(invalid("7Z compression level override is unsupported."));
        }
        if let Some(SevenZipDictionary::Bytes { size }) = rule.dictionary_size {
            validate_dictionary(size).map_err(|_| invalid("7Z dictionary size override is unsupported."))?;
        }
        if let Some(word_size) = rule.match_finder_word_size {
            validate_word_size(word_size).map_err(|_| invalid("7Z match finder word size override is unsupported."))?;
        }
        if let Some(cycles) = rule.search_cycles {
            validate_search_cycles(cycles).map_err(|_| invalid("7Z search cycles override is unsupported."))?;
        }
        let source = comparable_path(Path::new(&rule.source_path));
        if !roots.iter().any(|root| source.starts_with(root)) {
            return Err(invalid("7Z method override must be inside a selected input."));
        }
    }
    Ok(())
}

/// The archive's own settings, before any rule.
#[derive(Debug, Clone)]
pub(crate) struct ArchiveSettings {
    pub method: SevenZipMethod,
    /// The -mx step the archive uses for compressed entries.
    pub level: u8,
    pub dictionary_size: Option<u32>,
    pub match_finder_word_size: Option<u32>,
    pub search_cycles: Option<u32>,
    pub solid: bool,
}

impl ArchiveSettings {
    /// Settings from the slider level and expert options. Level 0 alone means
    /// Copy; with a method named, its entries compress at the lowest step.
    pub(crate) fn new(
        slider_level: u8,
        method: Option<SevenZipMethod>,
        dictionary_size: Option<u32>,
        match_finder_word_size: Option<u32>,
        search_cycles: Option<u32>,
        solid: bool,
    ) -> Self {
        let level = seven_zip_level(slider_level);
        Self {
            method: method.unwrap_or(if level == 0 { SevenZipMethod::Copy } else { SevenZipMethod::Lzma2 }),
            level: level.max(1),
            dictionary_size,
            match_finder_word_size,
            search_cycles,
            solid,
        }
    }
}

/// An entry's compression before its dictionary is settled: an automatic
/// dictionary depends on everything that shares the entry's stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingDictionary {
    Automatic(u8),
    Fixed(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingCompression {
    method: SevenZipMethod,
    dictionary: PendingDictionary,
    search_depth: u32,
    nice_length: u32,
}

impl PendingCompression {
    fn can_share_stream(&self, other: &Self) -> bool {
        self.method == SevenZipMethod::Lzma2 && other == self
    }
}

/// The settled LZMA2 settings an entry is encoded with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Lzma2Settings {
    /// The dictionary as settled; the header declares the next size LZMA2
    /// can name, which is at least this.
    pub dictionary_size: u32,
    pub search_depth: u32,
    pub nice_length: u32,
}

impl Lzma2Settings {
    pub(crate) fn dictionary_property(&self) -> u8 {
        dictionary_property(self.dictionary_size)
    }
}

pub(crate) struct Rules {
    rules: Vec<(PathBuf, SevenZipMethodOverride)>,
}

impl Rules {
    pub(crate) fn new(overrides: &[SevenZipMethodOverride]) -> Self {
        Self {
            rules: overrides.iter().map(|rule| (comparable_path(Path::new(&rule.source_path)), rule.clone())).collect(),
        }
    }

    /// An exact file rule wins; otherwise the nearest folder rule above the
    /// path, and of two for the same path the later one. Each setting the
    /// winner leaves unset is inherited from the next rule that sets it.
    fn pending(&self, source: &Path, archive: &ArchiveSettings) -> PendingCompression {
        let mut contenders: Vec<(bool, usize, usize, &SevenZipMethodOverride)> = self
            .rules
            .iter()
            .enumerate()
            .filter_map(|(index, (path, rule))| {
                let exact = path == source;
                let applies = match rule.scope {
                    OverrideScope::File => exact,
                    OverrideScope::Tree => source.starts_with(path),
                };
                applies.then(|| (rule.scope == OverrideScope::File && exact, path.as_os_str().len(), index, rule))
            })
            .collect();
        contenders.sort_by(|left, right| right.0.cmp(&left.0).then(right.1.cmp(&left.1)).then(right.2.cmp(&left.2)));
        let method = contenders.first().map_or(archive.method, |contender| contender.3.method);
        let rules = || contenders.iter().map(|contender| contender.3);
        let level = rules().find_map(|rule| rule.level).unwrap_or(archive.level);
        let (default_depth, default_nice) = level_encoder(level);
        let dictionary = match rules().find_map(|rule| rule.dictionary_size) {
            Some(SevenZipDictionary::Bytes { size }) => PendingDictionary::Fixed(size),
            Some(SevenZipDictionary::Auto) => PendingDictionary::Automatic(level),
            None => archive.dictionary_size.map_or(PendingDictionary::Automatic(level), PendingDictionary::Fixed),
        };
        PendingCompression {
            method,
            dictionary,
            search_depth: rules()
                .find_map(|rule| rule.search_cycles)
                .or(archive.search_cycles)
                .unwrap_or(default_depth),
            nice_length: rules()
                .find_map(|rule| rule.match_finder_word_size)
                .or(archive.match_finder_word_size)
                .unwrap_or(default_nice),
        }
    }
}

/// One entry that carries data, as the planner sees it.
pub(crate) struct PlanInput<'a> {
    pub source: &'a Path,
    pub size: u64,
}

/// A run of entries written as one stream: an LZMA2 solid block, or a lone
/// entry on its own settings. Indices point into the planner's input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Run {
    pub entries: Vec<usize>,
    /// `None` is Copy.
    pub lzma2: Option<Lzma2Settings>,
}

/// Settles every entry's compression and groups them into the streams a
/// write lays down. Solid mode joins adjacent LZMA2 entries whose settings
/// match; a Copy entry, a change of settings, or solid mode being off leaves
/// an entry on its own. An automatic dictionary is sized to everything in its
/// run, since a solid stream shares one dictionary.
pub(crate) fn plan_runs(inputs: &[PlanInput], rules: &Rules, archive: &ArchiveSettings) -> Vec<Run> {
    let pending: Vec<PendingCompression> = inputs.iter().map(|input| rules.pending(input.source, archive)).collect();
    let mut settled: Vec<Option<Lzma2Settings>> = vec![None; inputs.len()];
    let mut index = 0;
    while index < inputs.len() {
        let head = pending[index];
        let mut end = index + 1;
        if head.method == SevenZipMethod::Lzma2 && archive.solid {
            while end < inputs.len() && head.can_share_stream(&pending[end]) {
                end += 1;
            }
        }
        if head.method == SevenZipMethod::Lzma2 {
            let size = match head.dictionary {
                PendingDictionary::Fixed(size) => size,
                PendingDictionary::Automatic(level) => {
                    automatic_dictionary(inputs[index..end].iter().map(|input| input.size).sum(), level)
                }
            };
            let settings =
                Lzma2Settings { dictionary_size: size, search_depth: head.search_depth, nice_length: head.nice_length };
            settled[index..end].fill(Some(settings));
        }
        index = end;
    }

    // Runs settled apart can end up on identical settings, and a solid write
    // joins those too.
    let mut runs: Vec<Run> = Vec::new();
    for (index, settings) in settled.into_iter().enumerate() {
        match runs.last_mut() {
            Some(run) if archive.solid && settings.is_some() && run.lzma2 == settings => run.entries.push(index),
            _ => runs.push(Run { entries: vec![index], lzma2: settings }),
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(level: u8, solid: bool) -> ArchiveSettings {
        ArchiveSettings::new(level, None, None, None, None, solid)
    }

    fn rule(path: &str, scope: OverrideScope, method: SevenZipMethod) -> SevenZipMethodOverride {
        SevenZipMethodOverride {
            source_path: path.into(),
            scope,
            method,
            level: None,
            dictionary_size: None,
            match_finder_word_size: None,
            search_cycles: None,
        }
    }

    #[test]
    fn maps_the_slider_onto_seven_zips_steps() {
        assert_eq!((0..=9).map(seven_zip_level).collect::<Vec<_>>(), [0, 1, 1, 3, 3, 5, 5, 7, 7, 9]);
        assert_eq!(settings(0, false).method, SevenZipMethod::Copy);
        assert_eq!(settings(6, false).method, SevenZipMethod::Lzma2);
    }

    #[test]
    fn sizes_an_automatic_dictionary_to_the_data_up_to_the_levels_cap() {
        assert_eq!(automatic_dictionary(1000, 9), 64 << 10);
        assert_eq!(automatic_dictionary(3 << 20, 9), 4 << 20);
        assert_eq!(automatic_dictionary(1 << 30, 5), 16 << 20);
        assert_eq!(automatic_dictionary(1 << 30, 1), 1 << 20);
    }

    #[test]
    fn encodes_dictionary_sizes_as_lzma2_properties() {
        assert_eq!(dictionary_size_from_property(0), 4 << 10);
        assert_eq!(dictionary_property(1 << 20), 16);
        assert_eq!(dictionary_size_from_property(dictionary_property(3 << 20)), 3 << 20);
        assert_eq!(dictionary_size_from_property(dictionary_property(5 << 20)), 6 << 20);
    }

    #[test]
    fn joins_matching_entries_into_solid_runs_and_leaves_copy_alone() {
        let paths: Vec<PathBuf> = ["/in/a", "/in/b", "/in/c.jpg", "/in/d"].iter().map(PathBuf::from).collect();
        let inputs: Vec<PlanInput> = paths.iter().map(|source| PlanInput { source, size: 100 }).collect();
        let rules = Rules::new(&[rule("/in/c.jpg", OverrideScope::File, SevenZipMethod::Copy)]);

        let solid = plan_runs(&inputs, &rules, &settings(9, true));
        assert_eq!(solid.iter().map(|run| run.entries.clone()).collect::<Vec<_>>(), [vec![0, 1], vec![2], vec![3]]);
        assert_eq!(solid[1].lzma2, None);
        assert_eq!(solid[0].lzma2.unwrap().dictionary_size, 64 << 10);

        let apart = plan_runs(&inputs, &rules, &settings(9, false));
        assert_eq!(apart.len(), 4);
    }

    #[test]
    fn starts_a_new_block_where_a_rule_changes_the_strength() {
        let paths: Vec<PathBuf> = ["/in/a", "/in/b", "/in/c"].iter().map(PathBuf::from).collect();
        let inputs: Vec<PlanInput> = paths.iter().map(|source| PlanInput { source, size: 10 }).collect();
        let strong =
            SevenZipMethodOverride { level: Some(9), ..rule("/in/b", OverrideScope::File, SevenZipMethod::Lzma2) };

        let runs = plan_runs(&inputs, &Rules::new(&[strong]), &settings(5, true));

        assert_eq!(runs.iter().map(|run| run.entries.clone()).collect::<Vec<_>>(), [vec![0], vec![1], vec![2]]);
        assert_eq!(runs[1].lzma2.unwrap().nice_length, 273);
    }

    #[test]
    fn refuses_rules_the_writer_could_not_follow() {
        let inputs = vec!["/in".to_owned()];
        let refused = [
            SevenZipMethodOverride { level: Some(5), ..rule("/in/a", OverrideScope::File, SevenZipMethod::Copy) },
            SevenZipMethodOverride { level: Some(4), ..rule("/in/a", OverrideScope::File, SevenZipMethod::Lzma2) },
            SevenZipMethodOverride {
                dictionary_size: Some(SevenZipDictionary::Bytes { size: 1024 }),
                ..rule("/in/a", OverrideScope::File, SevenZipMethod::Lzma2)
            },
            SevenZipMethodOverride {
                match_finder_word_size: Some(100),
                ..rule("/in/a", OverrideScope::File, SevenZipMethod::Lzma2)
            },
            SevenZipMethodOverride {
                search_cycles: Some(0),
                ..rule("/in/a", OverrideScope::File, SevenZipMethod::Lzma2)
            },
            rule("/out/a", OverrideScope::File, SevenZipMethod::Copy),
        ];
        for override_rule in refused {
            assert!(validate_overrides(std::slice::from_ref(&override_rule), &inputs).is_err(), "{override_rule:?}");
        }
    }
}
