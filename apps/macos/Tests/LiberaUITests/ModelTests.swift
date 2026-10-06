import LiberaCore
import XCTest

@testable import LiberaUI

final class LocalizerTests: XCTestCase {
    func testInterpolatesAndPicksTheEnglishPlural() {
        let t = Localizer(language: .en)
        XCTAssertEqual(t("queue.compressItems", ["count": 1]), "Compress 1 item")
        XCTAssertEqual(t("queue.compressItems", ["count": 3]), "Compress 3 items")
        XCTAssertEqual(t("queue.extractName", ["name": "a.zip"]), "Extract a.zip")
    }

    func testKoreanHasOnlyTheOtherPlural() {
        let t = Localizer(language: .ko)
        XCTAssertEqual(t("dropZone.selectedItems", ["count": 1]), t("dropZone.selectedItems", ["count": 2]).replacingOccurrences(of: "2", with: "1"))
        XCTAssertNotEqual(t("titleBar.compress"), Localizer(language: .en)("titleBar.compress"))
    }

    func testAnUnknownKeyReadsAsItself() {
        XCTAssertEqual(Localizer(language: .ko)("no.such.key"), "no.such.key")
        XCTAssertFalse(Localizer(language: .en).has("no.such.key"))
    }

    func testFormatsBytesAndDurationsLikeTheRenderer() {
        let t = Localizer(language: .en)
        XCTAssertEqual(t.bytes(UInt64(0)), "0 B")
        XCTAssertEqual(t.bytes(UInt64(1023)), "1,023 B")
        XCTAssertEqual(t.bytes(UInt64(1536)), "1.5 KiB")
        XCTAssertEqual(t.bytes(UInt64(5 * 1024 * 1024)), "5 MiB")
        XCTAssertEqual(t.duration(milliseconds: 12), "12 ms")
        XCTAssertEqual(t.duration(milliseconds: 1250), "1.3 s")
    }

    func testTheSystemLanguagePicksKoreanUnlessAChoiceIsStored() {
        XCTAssertEqual(AppLanguage.initial(stored: nil, preferred: ["ko-KR", "en-US"]), .ko)
        XCTAssertEqual(AppLanguage.initial(stored: nil, preferred: ["fr-FR"]), .en)
        XCTAssertEqual(AppLanguage.initial(stored: "en", preferred: ["ko-KR"]), .en)
    }
}

final class ArchivePathTests: XCTestCase {
    func testNamesFormatsTheWayTheRendererDoes() {
        XCTAssertEqual(ArchiveFormat.tgz.fileExtension, ".tar.gz")
        XCTAssertEqual(ArchiveFormat.tgz.saveDialogExtension, "gz")
        XCTAssertEqual(ArchiveFormat.sevenZip.label, "7Z")
        XCTAssertEqual(ArchivePaths.label("tzst"), "TAR.ZST")
    }

    func testRewritesTheExtensionASavePanelLeaves() {
        XCTAssertEqual(ArchivePaths.withArchiveExtension("/a/b.tgz", format: .tgz), "/a/b.tar.gz")
        XCTAssertEqual(ArchivePaths.withArchiveExtension("/a/b", format: .zip), "/a/b.zip")
        XCTAssertEqual(ArchivePaths.withArchiveExtension("/a/b.TAR.GZ", format: .tgz), "/a/b.TAR.GZ")
    }

    func testReadsAnArchiveName() {
        XCTAssertEqual(ArchivePaths.baseName("photos.tar.gz"), "photos")
        XCTAssertEqual(ArchivePaths.baseName("notes.7z"), "notes")
        XCTAssertEqual(ArchivePaths.baseName(".hidden"), ".hidden")
        XCTAssertEqual(ArchivePaths.format(ofArchiveNamed: "a.TGZ"), "tgz")
        XCTAssertEqual(ArchivePaths.format(ofArchiveNamed: "a.7z.001"), "001")
        XCTAssertTrue(ArchivePaths.isEncryptable("set.z01"))
        XCTAssertTrue(ArchivePaths.isEncryptable("set.7z.002"))
        XCTAssertFalse(ArchivePaths.isEncryptable("a.tar.gz"))
        XCTAssertEqual(ArchivePaths.volumeGroupKey("/x/Set.z02"), ArchivePaths.volumeGroupKey("/x/set.zip"))
    }
}

final class FailureTests: XCTestCase {
    func testMapsCoreErrorsOntoTheRendererCodes() {
        XCTAssertEqual(Failure(LiberaError.WrongPassword, during: .extraction).code, "wrongArchivePassword")
        XCTAssertEqual(Failure(LiberaError.DestinationExists(message: "x"), during: .extraction).code, "destinationExists")
        XCTAssertEqual(Failure(LiberaError.CorruptArchive(message: "x"), during: .extraction).code, "genericExtraction")
        XCTAssertEqual(Failure(LiberaError.Io(message: "x"), during: .compression).code, "genericCompression")
        XCTAssertEqual(Failure(LiberaError.NotText, during: .preview).code, "notText")
        XCTAssertEqual(Failure(LiberaError.DestinationExists(message: "x"), during: .preview).code, "genericPreview")
        XCTAssertEqual(Failure(LiberaError.UnsupportedArchive(message: "x"), during: .inspection).messageKey, "errors.unsupportedArchive")
    }
}

@MainActor final class CompressionFormTests: XCTestCase {
    func testStandardModeSendsOnlyTheBasics() throws {
        let form = CompressionForm()
        form.zipMethod = .zstd
        let options = try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/out"))
        XCTAssertEqual(options.outputPath, "/out/archive.zip")
        XCTAssertEqual(options.level, 6)
        XCTAssertNil(options.zipMethod)
        XCTAssertNil(options.encryptionMethod)
        XCTAssertNil(options.excludeHiddenFiles)
    }

    func testAFormatChangeStartsOver() {
        let form = CompressionForm()
        form.password = "secret"
        form.splitEnabled = true
        form.select(.sevenZip)
        XCTAssertEqual(form.level, 5)
        XCTAssertEqual(form.password, "")
        XCTAssertFalse(form.splitEnabled)
        XCTAssertEqual(form.levelLabelKey, "compression.levelNormal")
    }

    func testStoringPinsTheLevelAndACodecLiftsZero() throws {
        let form = CompressionForm()
        form.expert = true
        form.zipMethod = .store
        XCTAssertEqual(form.effectiveLevel, 0)
        XCTAssertFalse(form.deflateTuningShown)
        form.zipMethod = .lzma
        form.level = 0
        XCTAssertEqual(form.effectiveLevel, 1)
        let options = try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/out"))
        XCTAssertEqual(options.zipMethod, .lzma)
        XCTAssertNil(options.deflateStrategy)
        XCTAssertEqual(options.encryptionMethod, .zipCrypto)
    }

    func testPerFileModeClearsTheArchiveWideSettings() throws {
        let form = CompressionForm()
        form.expert = true
        form.select(.sevenZip)
        form.dictionarySize = 64 << 20
        form.setPerFile(true)
        XCTAssertTrue(form.sevenZipSettingsCleared)
        XCTAssertEqual(form.dictionarySize, CompressionForm.defaultDictionarySize)
        let options = try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/out"))
        XCTAssertNil(options.sevenZipMethod)
        XCTAssertNil(options.dictionarySize)
        XCTAssertNil(options.sevenZipMethodOverrides)
        XCTAssertEqual(options.solidArchive, false)
    }

    func testRefusesToStartOnAMismatchOrATinyVolume() {
        let form = CompressionForm()
        form.password = "a"
        form.passwordConfirmation = "b"
        XCTAssertNil(form.options(inputs: ["/in"], defaultDirectory: "/out"))
        form.passwordConfirmation = "a"
        form.splitEnabled = true
        form.splitPreset = .custom
        form.splitCustomValue = "512"
        form.splitCustomUnit = .kilobytes
        XCTAssertTrue(form.splitInvalid)
        form.splitCustomValue = "1.5"
        form.splitCustomUnit = .megabytes
        XCTAssertEqual(form.options(inputs: ["/in"], defaultDirectory: "/out")?.splitSize, 1_572_864)
    }

    func testHidesNamesOnlyInExpertModeWithAPassword() throws {
        let form = CompressionForm()
        form.select(.sevenZip)
        form.encryptFileNames = true
        XCTAssertNil(try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/o")).encryptFileNames)
        form.expert = true
        XCTAssertNil(try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/o")).encryptFileNames)
        form.password = "p"
        form.passwordConfirmation = "p"
        XCTAssertEqual(try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/o")).encryptFileNames, true)
    }

    func testFiltersStayOutOfTheSingleFileFormats() throws {
        let form = CompressionForm()
        form.expert = true
        form.select(.zst)
        form.filterPattern = "*.txt"
        XCTAssertFalse(form.sourceFiltersShown)
        XCTAssertTrue(form.zstdTuningShown)
        let options = try XCTUnwrap(form.options(inputs: ["/in"], defaultDirectory: "/o"))
        XCTAssertNil(options.filterPattern)
        XCTAssertEqual(options.zstdStrategy, .lazy2)
    }

    func testPrunesRulesForInputsNoLongerPicked() {
        let form = CompressionForm()
        form.zipOverrides = [
            ZipMethodOverride(sourcePath: "/docs/a.txt", scope: .file, method: .store),
            ZipMethodOverride(sourcePath: "/gone.txt", scope: .file, method: .store),
        ]
        form.pruneOverrides(to: [SelectedItem(path: "/docs/", name: "docs", isDirectory: true, size: 0)])
        XCTAssertEqual(form.zipOverrides.map(\.sourcePath), ["/docs/a.txt"])
    }
}

final class ExtractionRequestTests: XCTestCase {
    func testNamesTheSubfolderAfterTheArchive() {
        let item = SelectedItem(path: "/in/photos.tar.gz", name: "photos.tar.gz", isDirectory: false, size: 1)
        var request = ExtractionRequest(targetDir: "/out", createSubfolder: true)
        var options = request.options(for: item, password: "pw")
        XCTAssertEqual(options.targetDir, "/out/photos")
        XCTAssertTrue(options.rejectExistingTarget)
        XCTAssertEqual(options.password, "pw")

        request.options.overwritePolicy = .skip
        options = request.options(for: item, password: nil)
        XCTAssertFalse(options.rejectExistingTarget)

        request.createSubfolder = false
        XCTAssertEqual(request.options(for: item, password: nil).targetDir, "/out")
    }
}

final class LicenseTests: XCTestCase {
    func testListsTheLinkedCratesBesideTheBundledFontsAndIcons() throws {
        let names = LicenseEntry.all.map(\.name)
        XCTAssertTrue(names.contains("Gaegu"))
        XCTAssertTrue(names.contains("Lucide"))
        XCTAssertTrue(names.contains("zstd-sys"))
        let uniffi = try XCTUnwrap(LicenseEntry.all.first { $0.name == "uniffi" })
        XCTAssertTrue(uniffi.text.contains("Mozilla Public License Version 2.0"))
        XCTAssertFalse(names.contains { $0.hasPrefix("libera") })
    }
}
