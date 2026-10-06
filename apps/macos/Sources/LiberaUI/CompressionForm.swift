import Foundation
import LiberaCore

/// The compression panel's settings and the rules CompressionPanel.tsx applies
/// to them: which controls a format shows, which a per-file dialog takes over,
/// and the options a start hands to the core.
@MainActor final class CompressionForm: ObservableObject {
    static let minimumSplitSize: UInt64 = 1024 * 1024
    static let defaultDictionarySize: UInt32 = 16 * 1024 * 1024
    static let defaultWordSize: UInt32 = 32
    static let defaultSearchCycles: UInt32 = 32
    static let defaultMemLevel: UInt8 = 8
    static let defaultZstdStrategy = ZstdStrategy.lazy2
    static let defaultZstdWindowSize: UInt32 = 8 * 1024 * 1024
    /// Stands in for a setting the per-file dialog has taken over.
    static let clearedValue = "—"

    static let dictionarySizes: [(label: String, value: UInt32)] = [
        ("64 KB", 64 << 10), ("1 MB", 1 << 20), ("2 MB", 2 << 20), ("4 MB", 4 << 20), ("8 MB", 8 << 20),
        ("16 MB", 16 << 20), ("32 MB", 32 << 20), ("64 MB", 64 << 20), ("128 MB", 128 << 20),
    ]
    static let wordSizes: [UInt32] = [32, 64, 128, 273]
    /// A reader refuses a window past its own limit, which is 128 MB by default.
    static let zstdWindowSizes: [(label: String, value: UInt32)] = [
        ("1 MB", 1 << 20), ("2 MB", 2 << 20), ("4 MB", 4 << 20), ("8 MB", 8 << 20),
        ("16 MB", 16 << 20), ("32 MB", 32 << 20), ("64 MB", 64 << 20), ("128 MB", 128 << 20),
    ]
    static let zstdWorkerChoices: [UInt8] = [0, 2, 4, 8]

    enum SplitPreset: String, CaseIterable, Identifiable {
        case mb100, mb700, gb1, gb2, gb4, custom

        var id: String { rawValue }

        var bytes: UInt64? {
            switch self {
            case .mb100: 100 << 20
            case .mb700: 700 << 20
            case .gb1: 1 << 30
            case .gb2: 2 << 30
            // The largest volume a FAT32 filesystem can hold.
            case .gb4: 0xFFFF_FFFF
            case .custom: nil
            }
        }

        var labelKey: String {
            switch self {
            case .mb100: "compression.splitPreset100mb"
            case .mb700: "compression.splitPreset700mb"
            case .gb1: "compression.splitPreset1gb"
            case .gb2: "compression.splitPreset2gb"
            case .gb4: "compression.splitPreset4gb"
            case .custom: "compression.splitPresetCustom"
            }
        }
    }

    enum SplitUnit: String, CaseIterable, Identifiable {
        case bytes = "B", kilobytes = "KB", megabytes = "MB", gigabytes = "GB"

        var id: String { rawValue }

        var multiplier: Double {
            switch self {
            case .bytes: 1
            case .kilobytes: 1024
            case .megabytes: 1024 * 1024
            case .gigabytes: 1024 * 1024 * 1024
            }
        }
    }

    /// Mirrors the title bar's switch; the panel keeps it current.
    @Published var expert = false

    @Published private(set) var format = ArchiveFormat.zip
    @Published var level = ArchiveFormat.zip.defaultLevel
    @Published var outputPath = ""
    @Published var password = ""
    @Published var passwordConfirmation = ""
    @Published var encryptFileNames = false
    @Published var splitEnabled = false
    @Published var splitPreset = SplitPreset.mb100
    @Published var splitCustomValue = "100"
    @Published var splitCustomUnit = SplitUnit.megabytes

    @Published var zipEncryption = ZipEncryptionMethod.zipCrypto
    @Published var zipMethod = ZipMethod.deflate
    @Published private(set) var zipPerFile = false
    @Published var zipOverrides: [ZipMethodOverride] = []
    @Published var sevenZipMethod = SevenZipMethod.lzma2
    @Published private(set) var sevenZipPerFile = false
    @Published var sevenZipOverrides: [SevenZipMethodOverride] = []
    @Published var dictionarySize = defaultDictionarySize
    @Published var wordSize = defaultWordSize
    @Published var searchCycles = defaultSearchCycles
    @Published var solid = false
    @Published var deflateStrategy = DeflateStrategy.default
    @Published var memLevel = defaultMemLevel
    @Published var zstdStrategy = defaultZstdStrategy
    @Published var zstdWindowSize = defaultZstdWindowSize
    @Published var zstdLongDistance = false
    @Published var zstdWorkers: UInt8 = 0
    @Published var excludeSymlinks = false
    @Published var excludeMacMetadata = false
    @Published var excludeHiddenFiles = false
    @Published var filterPattern = ""

    /// A new format starts from scratch: nothing chosen for the last one
    /// carries over.
    func select(_ format: ArchiveFormat) {
        guard format != self.format else { return }
        self.format = format
        level = format.defaultLevel
        outputPath = ""
        password = ""
        passwordConfirmation = ""
        encryptFileNames = false
        splitEnabled = false
        splitPreset = .mb100
        splitCustomValue = "100"
        splitCustomUnit = .megabytes
        zipEncryption = .zipCrypto
        zipMethod = .deflate
        zipPerFile = false
        zipOverrides = []
        sevenZipMethod = .lzma2
        sevenZipPerFile = false
        sevenZipOverrides = []
        dictionarySize = Self.defaultDictionarySize
        wordSize = Self.defaultWordSize
        searchCycles = Self.defaultSearchCycles
        solid = false
        deflateStrategy = .default
        memLevel = Self.defaultMemLevel
        zstdStrategy = Self.defaultZstdStrategy
        zstdWindowSize = Self.defaultZstdWindowSize
        zstdLongDistance = false
        zstdWorkers = 0
    }

    /// The per-file switch hands the settings between two owners, so the side
    /// left behind goes back to what the format starts with.
    func setPerFile(_ enabled: Bool) {
        if format == .zip { zipPerFile = enabled }
        if format == .sevenZip { sevenZipPerFile = enabled }
        level = format.defaultLevel
        if format == .zip {
            zipMethod = .deflate
            deflateStrategy = .default
            memLevel = Self.defaultMemLevel
        }
        if format == .sevenZip {
            sevenZipMethod = .lzma2
            dictionarySize = Self.defaultDictionarySize
            wordSize = Self.defaultWordSize
            searchCycles = Self.defaultSearchCycles
        }
    }

    /// Drops the rules for paths no longer among the inputs.
    func pruneOverrides(to items: [SelectedItem]) {
        func normalized(_ path: String) -> String {
            var path = path
            while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            return path
        }
        let inputs = items.map { (path: normalized($0.path), isDirectory: $0.isDirectory) }
        func belongs(_ source: String) -> Bool {
            let rule = normalized(source)
            return inputs.contains { rule == $0.path || ($0.isDirectory && rule.hasPrefix($0.path + "/")) }
        }
        zipOverrides.removeAll { !belongs($0.sourcePath) }
        sevenZipOverrides.removeAll { !belongs($0.sourcePath) }
    }

    // MARK: What the panel shows

    var levels: [UInt8] { Libera.levels(for: format) }
    var supportsLevel: Bool { !levels.isEmpty }
    var supportsPassword: Bool { LiberaCore.supportsPassword(format: format) }
    var supportsSplit: Bool { LiberaCore.supportsSplit(format: format) }
    var supportsHeaderEncryption: Bool { LiberaCore.supportsHeaderEncryption(format: format) }

    var zipPerFileActive: Bool { expert && zipPerFile }
    var sevenZipPerFileActive: Bool { expert && sevenZipPerFile }
    var perFileActive: Bool { format == .zip ? zipPerFileActive : format == .sevenZip && sevenZipPerFileActive }
    /// The archive-wide rows stay on screen while per-file mode owns them, but
    /// they hold no value of their own.
    var zipSettingsCleared: Bool { format == .zip && zipPerFileActive }
    var sevenZipSettingsCleared: Bool { format == .sevenZip && sevenZipPerFileActive }

    var storeSelected: Bool {
        expert && !perFileActive && ((format == .zip && zipMethod == .store) || (format == .sevenZip && sevenZipMethod == .copy))
    }

    var compressedMethodSelected: Bool {
        expert && !perFileActive && ((format == .zip && zipMethod != .store) || (format == .sevenZip && sevenZipMethod == .lzma2))
    }

    /// Storing pins the level at 0; a compressing method cannot store, so it
    /// lifts 0 to 1.
    var effectiveLevel: UInt8 {
        if storeSelected { return 0 }
        return compressedMethodSelected && level == 0 ? 1 : level
    }

    var levelLabelKey: String {
        let names: [UInt8: String] = format == .sevenZip
            ? [0: "levelStore", 1: "levelFastest", 3: "levelFast", 5: "levelNormal", 7: "levelMaximum", 9: "levelUltra"]
            : [0: "levelStore", 1: "levelFastest", 6: "levelNormal", 9: "levelMaximum"]
        return "compression.\(names[effectiveLevel] ?? "levelPlain")"
    }

    private var deflateTuned: Bool {
        (format == .zip && !zipPerFileActive && zipMethod == .deflate) || format == .tgz || format == .gz
    }

    /// Strategy and memory level are Deflate's own knobs.
    var deflateTuningShown: Bool {
        (format == .zip && (zipPerFileActive || zipMethod == .deflate)) || format == .tgz || format == .gz
    }

    private var sevenZipGlobalTuning: Bool { format == .sevenZip && !sevenZipPerFileActive && sevenZipMethod == .lzma2 }
    var sevenZipTuningShown: Bool { format == .sevenZip && (sevenZipPerFileActive || sevenZipMethod == .lzma2) }

    /// The formats that are a Zstandard stream, and ZIP written with it. The
    /// per-file dialog carries no codec options, so these stay out of its way.
    var zstdTuningShown: Bool {
        expert && (format == .zst || format == .tzst || (format == .zip && !zipPerFileActive && zipMethod == .zstd))
    }

    /// GZ and ZST wrap one file handed over whole, so there is no walk to filter.
    var sourceFiltersShown: Bool { expert && format != .gz && format != .zst }
    var solidShown: Bool { format == .sevenZip && (sevenZipPerFileActive || sevenZipMethod == .lzma2) }

    /// ZST has nothing for the card but the level above it.
    var expertCardShown: Bool {
        expert && (format == .zip || format == .sevenZip || deflateTuningShown || zstdTuningShown || sourceFiltersShown || solidShown)
    }

    var passwordMismatch: Bool { supportsPassword && password != passwordConfirmation }

    /// The message under a confirmed password.
    var passwordNoticeKey: String {
        if format == .sevenZip { return "compression.passwordNotice7z" }
        switch zipEncryption {
        case .aes256: return "compression.passwordNoticeZipAes"
        case .aes128: return "compression.passwordNoticeZipAes128"
        case .zipCrypto: return "compression.passwordNoticeZip"
        }
    }

    /// The chosen volume size, or nil for a custom size that is no number.
    var splitSize: UInt64? {
        if let bytes = splitPreset.bytes { return bytes }
        guard let value = Double(splitCustomValue.trimmingCharacters(in: .whitespaces)), value.isFinite, value > 0 else { return nil }
        return UInt64((value * splitCustomUnit.multiplier).rounded(.down))
    }

    var splitInvalid: Bool {
        supportsSplit && splitEnabled && (splitSize ?? 0) < Self.minimumSplitSize
    }

    /// Where the archive lands: the picked path, or `archive` plus the
    /// format's extension in the default folder.
    func resolvedOutputPath(defaultDirectory: String) -> String {
        guard outputPath.isEmpty else { return outputPath }
        return (defaultDirectory as NSString).appendingPathComponent("archive\(format.fileExtension)")
    }

    /// What the core is asked to do, or nil while the form cannot start.
    func options(inputs: [String], defaultDirectory: String) -> CompressionOptions? {
        guard !inputs.isEmpty, !passwordMismatch, !splitInvalid else { return nil }
        var options = CompressionOptions(
            inputPaths: inputs, outputPath: resolvedOutputPath(defaultDirectory: defaultDirectory), format: format,
            level: effectiveLevel
        )
        if supportsPassword && !password.isEmpty {
            options.password = password
            if expert && supportsHeaderEncryption { options.encryptFileNames = encryptFileNames }
        }
        if supportsSplit && splitEnabled { options.splitSize = splitSize }
        guard expert else { return options }

        if format == .zip {
            options.encryptionMethod = zipEncryption
            if zipPerFileActive {
                options.zipMethodOverrides = zipOverrides.isEmpty ? nil : zipOverrides
            } else {
                options.zipMethod = zipMethod
            }
        }
        if format == .sevenZip {
            if sevenZipPerFileActive {
                options.sevenZipMethodOverrides = sevenZipOverrides.isEmpty ? nil : sevenZipOverrides
            } else {
                options.sevenZipMethod = sevenZipMethod
            }
        }
        if sevenZipGlobalTuning {
            options.dictionarySize = dictionarySize
            options.matchFinderWordSize = wordSize
            options.searchCycles = searchCycles
        }
        if solidShown { options.solidArchive = solid }
        if deflateTuned {
            options.deflateStrategy = deflateStrategy
            options.memLevel = memLevel
        }
        if zstdTuningShown {
            options.zstdStrategy = zstdStrategy
            options.zstdWindowSize = zstdWindowSize
            options.zstdLongDistance = zstdLongDistance
            options.zstdWorkers = zstdWorkers
        }
        if sourceFiltersShown {
            options.excludeSymlinks = excludeSymlinks
            options.excludeMacMetadata = excludeMacMetadata
            options.excludeHiddenFiles = excludeHiddenFiles
            let pattern = filterPattern.trimmingCharacters(in: .whitespacesAndNewlines)
            options.filterPattern = pattern.isEmpty ? nil : pattern
        }
        return options
    }
}
