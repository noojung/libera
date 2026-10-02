import Foundation
import LiberaCore

// The naming rules the renderer keeps in utils/archivePaths.ts. What an
// archive can be asked to do comes from the core; these only decide how a
// format is labelled and what its files are called.

extension ArchiveFormat: CaseIterable, Identifiable {
    /// The panel's order, which is also the renderer's `COMPRESSION_FORMATS`.
    public static let allCases: [ArchiveFormat] = [.zip, .tar, .gz, .tgz, .zst, .tzst, .sevenZip]

    /// The renderer's name for the format, which the queue labels a job with.
    public var id: String {
        switch self {
        case .zip: "zip"
        case .tar: "tar"
        case .gz: "gz"
        case .tgz: "tgz"
        case .zst: "zst"
        case .tzst: "tzst"
        case .sevenZip: "7z"
        }
    }

    /// The tar-inside-a-codec formats are named for what they are.
    var fileExtension: String {
        switch self {
        case .tgz: ".tar.gz"
        case .tzst: ".tar.zst"
        default: ".\(id)"
        }
    }

    /// The single extension a save panel filters on; `.tar.gz` filters as `gz`.
    var saveDialogExtension: String {
        String(fileExtension.split(separator: ".").last ?? "")
    }

    var label: String { ArchivePaths.label(id) }

    /// Six is Deflate's own default; 7z's five is its "normal".
    var defaultLevel: UInt8 {
        switch self {
        case .tar: 0
        case .sevenZip: 5
        default: 6
        }
    }

    /// Extensions a save panel may leave behind, rewritten to the canonical one.
    fileprivate var extensionAliases: [String] {
        switch self {
        case .tgz: [".tgz", ".tar", ".gz"]
        case .tzst: [".tzst", ".tar", ".zst"]
        default: []
        }
    }
}

enum ArchivePaths {
    /// How a format is named in the UI, so `tgz` reads as TAR.GZ.
    static func label(_ format: String) -> String {
        switch format {
        case "tgz": "TAR.GZ"
        case "tzst": "TAR.ZST"
        default: format.uppercased()
        }
    }

    /// Forces `path` to carry the format's extension, replacing a known alias.
    static func withArchiveExtension(_ path: String, format: ArchiveFormat) -> String {
        let canonical = format.fileExtension
        let lowered = path.lowercased()
        if lowered.hasSuffix(canonical) { return path }
        for alias in format.extensionAliases where lowered.hasSuffix(alias) {
            return String(path.dropLast(alias.count)) + canonical
        }
        return path + canonical
    }

    /// The format an archive picked for extraction is listed under.
    static func format(ofArchiveNamed name: String) -> String {
        let lowered = name.lowercased()
        if lowered.hasSuffix(".tar.gz") || lowered.hasSuffix(".tgz") { return "tgz" }
        if lowered.hasSuffix(".tar.zst") || lowered.hasSuffix(".tzst") { return "tzst" }
        return lowered.split(separator: ".").last.map(String.init) ?? "zip"
    }

    /// An archive's name without its extension, `.tar.gz` counting as one.
    static func baseName(_ name: String) -> String {
        let lowered = name.lowercased()
        for compound in [".tar.gz", ".tar.xz", ".tar.bz2", ".tar.zst"] where lowered.hasSuffix(compound) {
            return String(name.dropLast(compound.count))
        }
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return name }
        return String(name[..<dot])
    }

    static func isNumberedVolume(_ path: String) -> Bool {
        path.range(of: #"\.z\d{2,}$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func isSevenZipVolume(_ path: String) -> Bool {
        path.range(of: #"\.7z\.\d{3,}$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The archives whose containers define encryption, so only these are
    /// asked whether they need a password before extracting.
    static func isEncryptable(_ path: String) -> Bool {
        let lowered = path.lowercased()
        return [".zip", ".jar", ".war", ".7z"].contains { lowered.hasSuffix($0) }
            || isNumberedVolume(path) || isSevenZipVolume(path)
    }

    /// Every volume of one set shares this key, so a set dragged in whole
    /// collapses to a single job instead of one job per volume.
    static func volumeGroupKey(_ path: String) -> String {
        canonicalArchive(path: path).lowercased()
    }

    /// Extensions the extraction open panel offers, first volumes included.
    static let extractDialogExtensions = [
        "zip", "jar", "war", "z01", "tar", "tgz", "txz", "tbz2", "tbz", "tzst",
        "xz", "bz2", "zst", "gz", "7z", "001",
    ]
}
