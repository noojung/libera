//! The format-agnostic core of extraction: the safety checks every archive
//! format has to pass, the transaction that undoes a failed job, and the meter
//! that keeps one honest about size and disk budget. A format reader lists its
//! entries into a [`plan::Plan`], and writes only what the plan lets through.

pub(crate) mod meter;
pub(crate) mod paths;
pub(crate) mod plan;
pub(crate) mod target;
pub(crate) mod transaction;
pub(crate) mod write;

/// The limits an extraction is held to. The defaults are the Electron
/// engine's; tests narrow them through [`crate::ExtractionContext`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractionPolicy {
    pub max_entries: u64,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub minimum_reserve_bytes: u64,
    pub reserve_ratio_percent: u64,
}

pub const MAX_ARCHIVE_ENTRIES: u64 = 100_000;
pub const MAX_TOTAL_EXTRACTED_BYTES: u64 = 1 << 40;
pub const MAX_FILE_EXTRACTED_BYTES: u64 = 1 << 40;
pub const MINIMUM_DISK_RESERVE_BYTES: u64 = 1 << 30;
pub const DISK_RESERVE_RATIO_PERCENT: u64 = 5;

impl Default for ExtractionPolicy {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_total_bytes: MAX_TOTAL_EXTRACTED_BYTES,
            max_file_bytes: MAX_FILE_EXTRACTED_BYTES,
            minimum_reserve_bytes: MINIMUM_DISK_RESERVE_BYTES,
            reserve_ratio_percent: DISK_RESERVE_RATIO_PERCENT,
        }
    }
}

impl ExtractionPolicy {
    /// What an extraction may write into a filesystem with `available` bytes
    /// free: everything but 5% of it, or 1 GiB if that is more, and never past
    /// the total limit.
    pub fn usable_bytes(&self, available: u64) -> u64 {
        let ratio_reserve = (u128::from(available) * u128::from(self.reserve_ratio_percent) / 100) as u64;
        let reserve = ratio_reserve.max(self.minimum_reserve_bytes);
        available.saturating_sub(reserve).min(self.max_total_bytes)
    }
}

/// `1 TiB`, `100 MiB` - the way the limits are named in their messages.
pub(crate) fn format_binary_bytes(bytes: u64) -> String {
    for (unit, size) in [("TiB", 1u64 << 40), ("GiB", 1 << 30), ("MiB", 1 << 20)] {
        if bytes >= size {
            let whole = bytes / size;
            let rest = bytes % size;
            return if rest == 0 {
                format!("{whole} {unit}")
            } else {
                format!("{} {unit}", trim_decimal(bytes as f64 / size as f64))
            };
        }
    }
    format!("{bytes} bytes")
}

fn trim_decimal(value: f64) -> String {
    let text = format!("{value:.6}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// `100,000`, for the entry limit's message.
pub(crate) fn format_count(count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_1_tib_file_and_archive_limits_with_100000_entries() {
        let policy = ExtractionPolicy::default();
        assert_eq!(policy.max_entries, 100_000);
        assert_eq!(policy.max_total_bytes, 1024u64.pow(4));
        assert_eq!(policy.max_file_bytes, 1024u64.pow(4));
    }

    #[test]
    fn reserves_five_percent_or_at_least_1_gib_and_clamps_the_result_to_1_tib() {
        let policy = ExtractionPolicy::default();
        let gib = 1u64 << 30;
        assert_eq!(policy.usable_bytes(10 * gib), 9 * gib);
        assert_eq!(policy.usable_bytes(100 * gib), 95 * gib);
        assert_eq!(policy.usable_bytes(gib / 2), 0);
        assert_eq!(policy.usable_bytes(10 * 1024 * gib), 1024 * gib);
    }

    #[test]
    fn names_sizes_and_counts_as_the_messages_do() {
        assert_eq!(format_binary_bytes(1 << 40), "1 TiB");
        assert_eq!(format_binary_bytes(3 << 29), "1.5 GiB");
        assert_eq!(format_binary_bytes(100 << 20), "100 MiB");
        assert_eq!(format_binary_bytes(512), "512 bytes");
        assert_eq!(format_count(100_000), "100,000");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }
}
