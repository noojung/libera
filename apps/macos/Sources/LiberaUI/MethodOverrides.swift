import Foundation
import LiberaCore

/// A setting a folder row shows: one value, or several among its contents.
enum Selection<Value: Hashable>: Hashable {
    case value(Value)
    case mixed
}

/// How rules name paths: a folder rule covers everything below it, and the
/// most specific rule wins.
enum RulePaths {
    static func comparable(_ path: String) -> String {
        var path = path.replacingOccurrences(of: "\\", with: "/")
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        return path
    }

    static func same(_ a: String, _ b: String) -> Bool { comparable(a) == comparable(b) }

    static func isDescendant(_ parent: String, of candidate: String) -> Bool {
        comparable(candidate).hasPrefix(comparable(parent) + "/")
    }
}

/// The rules shared by both per-file dialogs, which differ only in what a
/// rule carries.
protocol MethodRule {
    associatedtype Method: Hashable
    var sourcePath: String { get set }
    var scope: OverrideScope { get set }
    var method: Method { get set }
    var level: UInt8? { get set }
}

extension ZipMethodOverride: MethodRule {}
extension SevenZipMethodOverride: MethodRule {}

extension Array where Element: MethodRule {
    /// The newest rule naming exactly this path and scope.
    func direct(_ path: String, _ scope: OverrideScope) -> Element? {
        last { $0.scope == scope && RulePaths.same($0.sourcePath, path) }
    }

    /// The deepest folder rule above `path` that `include` accepts.
    func containing(_ path: String, where include: (Element) -> Bool = { _ in true }) -> Element? {
        var winner: Element?
        for rule in self where rule.scope == .tree && include(rule) && RulePaths.isDescendant(rule.sourcePath, of: path) {
            if winner == nil || RulePaths.comparable(rule.sourcePath).count >= RulePaths.comparable(winner!.sourcePath).count {
                winner = rule
            }
        }
        return winner
    }

    /// The rules below a folder, which its row advertises.
    func nested(under path: String) -> [Element] {
        filter { RulePaths.isDescendant(path, of: $0.sourcePath) }
    }

    func removingDirect(_ path: String, _ scope: OverrideScope) -> [Element] {
        filter { !($0.scope == scope && RulePaths.same($0.sourcePath, path)) }
    }

    /// A folder's value, or `.mixed` when a rule below it says otherwise.
    func selection<Value: Hashable>(_ base: Value, under path: String, isDirectory: Bool, _ value: (Element) -> Value?) -> Selection<Value> {
        guard isDirectory else { return .value(base) }
        var values: Set<Value> = [base]
        for rule in nested(under: path) {
            if let value = value(rule) { values.insert(value) }
        }
        return values.count > 1 ? .mixed : .value(base)
    }
}

private func scope(_ isDirectory: Bool) -> OverrideScope { isDirectory ? .tree : .file }

/// ZIP's per-file rules: a method for each entry, and for Deflate its
/// strategy, memory level and strength, as ZipMethodOverridesModal.tsx edits them.
struct ZipOverrideEditor {
    static let defaultMethod = ZipMethod.deflate
    static let defaultMemLevel: UInt8 = 8

    var rules: [ZipMethodOverride]
    let defaultLevel: UInt8

    func method(_ path: String, isDirectory: Bool) -> ZipMethod {
        rules.direct(path, scope(isDirectory))?.method ?? rules.containing(path)?.method ?? Self.defaultMethod
    }

    func methodSelection(_ path: String, isDirectory: Bool) -> Selection<ZipMethod> {
        rules.selection(method(path, isDirectory: isDirectory), under: path, isDirectory: isDirectory) { $0.method }
    }

    /// Nil when the entry is not written with Deflate, or its methods are mixed.
    func strategySelection(_ path: String, isDirectory: Bool) -> Selection<DeflateStrategy>? {
        guard deflateOnly(path, isDirectory) else { return nil }
        let base = rules.direct(path, scope(isDirectory))?.deflateStrategy
            ?? rules.containing(path, where: { $0.deflateStrategy != nil })?.deflateStrategy ?? .default
        return rules.selection(base, under: path, isDirectory: isDirectory) { $0.method == .deflate ? $0.deflateStrategy : nil }
    }

    func memorySelection(_ path: String, isDirectory: Bool) -> Selection<UInt8>? {
        guard deflateOnly(path, isDirectory) else { return nil }
        let base = rules.direct(path, scope(isDirectory))?.memLevel
            ?? rules.containing(path, where: { $0.memLevel != nil })?.memLevel ?? Self.defaultMemLevel
        return rules.selection(base, under: path, isDirectory: isDirectory) { $0.method == .deflate ? $0.memLevel : nil }
    }

    /// Nil for a stored entry, which has no strength.
    func levelSelection(_ path: String, isDirectory: Bool) -> Selection<UInt8>? {
        guard methodSelection(path, isDirectory: isDirectory) != .mixed, method(path, isDirectory: isDirectory) != .store else { return nil }
        let base = rules.direct(path, scope(isDirectory))?.level
            ?? rules.containing(path, where: { $0.level != nil })?.level ?? defaultLevel
        return rules.selection(base, under: path, isDirectory: isDirectory) { $0.level }
    }

    private func deflateOnly(_ path: String, _ isDirectory: Bool) -> Bool {
        methodSelection(path, isDirectory: isDirectory) != .mixed && method(path, isDirectory: isDirectory) == .deflate
    }

    /// A folder's method replaces every rule below it; the tuning it already
    /// had carries over where the new method takes it.
    mutating func setMethod(_ path: String, isDirectory: Bool, _ method: ZipMethod) {
        let scope = scope(isDirectory)
        let direct = rules.direct(path, scope)
        var remaining = rules.removingDirect(path, scope)
        if isDirectory { remaining.removeAll { RulePaths.isDescendant(path, of: $0.sourcePath) } }
        remaining.append(ZipMethodOverride(
            sourcePath: path, scope: scope, method: method,
            deflateStrategy: method == .deflate ? direct?.deflateStrategy : nil,
            memLevel: method == .deflate ? direct?.memLevel : nil,
            level: method != .store ? direct?.level : nil
        ))
        rules = remaining
    }

    /// A folder's value replaces the same setting on every rule below it.
    mutating func setStrategy(_ path: String, isDirectory: Bool, _ strategy: DeflateStrategy) {
        update(path, isDirectory: isDirectory, requires: { $0 == .deflate }) { $0.deflateStrategy = strategy } clear: { $0.deflateStrategy = nil }
    }

    mutating func setMemory(_ path: String, isDirectory: Bool, _ memLevel: UInt8) {
        update(path, isDirectory: isDirectory, requires: { $0 == .deflate }) { $0.memLevel = memLevel } clear: { $0.memLevel = nil }
    }

    mutating func setLevel(_ path: String, isDirectory: Bool, _ level: UInt8) {
        update(path, isDirectory: isDirectory, requires: { $0 != .store }) { $0.level = level } clear: { $0.level = nil }
    }

    private mutating func update(
        _ path: String, isDirectory: Bool, requires: (ZipMethod) -> Bool,
        set: (inout ZipMethodOverride) -> Void, clear: (inout ZipMethodOverride) -> Void
    ) {
        let scope = scope(isDirectory)
        let direct = rules.direct(path, scope)
        let method = direct?.method ?? self.method(path, isDirectory: isDirectory)
        guard requires(method) else { return }
        var remaining = rules.removingDirect(path, scope).map { rule -> ZipMethodOverride in
            guard isDirectory, RulePaths.isDescendant(path, of: rule.sourcePath) else { return rule }
            var rule = rule
            clear(&rule)
            return rule
        }
        var rule = direct ?? ZipMethodOverride(sourcePath: path, scope: scope, method: method)
        rule.sourcePath = path
        rule.method = method
        set(&rule)
        remaining.append(rule)
        rules = remaining
    }
}

/// 7z's per-file rules: LZMA2 or Copy for each entry, and LZMA2's strength.
struct SevenZipOverrideEditor {
    static let defaultMethod = SevenZipMethod.lzma2
    static let levels: [UInt8] = [1, 3, 5, 7, 9]

    var rules: [SevenZipMethodOverride]
    let defaultLevel: UInt8

    func method(_ path: String, isDirectory: Bool) -> SevenZipMethod {
        rules.direct(path, scope(isDirectory))?.method ?? rules.containing(path)?.method ?? Self.defaultMethod
    }

    func methodSelection(_ path: String, isDirectory: Bool) -> Selection<SevenZipMethod> {
        rules.selection(method(path, isDirectory: isDirectory), under: path, isDirectory: isDirectory) { $0.method }
    }

    /// Nil for a copied entry, or a folder of mixed methods.
    func levelSelection(_ path: String, isDirectory: Bool) -> Selection<UInt8>? {
        guard methodSelection(path, isDirectory: isDirectory) != .mixed, method(path, isDirectory: isDirectory) != .copy else { return nil }
        let base = rules.direct(path, scope(isDirectory))?.level
            ?? rules.containing(path, where: { $0.level != nil })?.level ?? defaultLevel
        return rules.selection(base, under: path, isDirectory: isDirectory) { $0.level }
    }

    mutating func setMethod(_ path: String, isDirectory: Bool, _ method: SevenZipMethod) {
        let scope = scope(isDirectory)
        let direct = rules.direct(path, scope)
        var remaining = rules.removingDirect(path, scope)
        if isDirectory { remaining.removeAll { RulePaths.isDescendant(path, of: $0.sourcePath) } }
        let keeps = method != .copy
        remaining.append(SevenZipMethodOverride(
            sourcePath: path, scope: scope, method: method,
            level: keeps ? direct?.level : nil, dictionarySize: keeps ? direct?.dictionarySize : nil,
            matchFinderWordSize: keeps ? direct?.matchFinderWordSize : nil, searchCycles: keeps ? direct?.searchCycles : nil
        ))
        rules = remaining
    }

    mutating func setLevel(_ path: String, isDirectory: Bool, _ level: UInt8) {
        let scope = scope(isDirectory)
        let direct = rules.direct(path, scope)
        let method = direct?.method ?? self.method(path, isDirectory: isDirectory)
        guard method != .copy else { return }
        var remaining = rules.removingDirect(path, scope).map { rule -> SevenZipMethodOverride in
            guard isDirectory, RulePaths.isDescendant(path, of: rule.sourcePath) else { return rule }
            var rule = rule
            rule.level = nil
            return rule
        }
        var rule = direct ?? SevenZipMethodOverride(sourcePath: path, scope: scope, method: method)
        rule.sourcePath = path
        rule.method = method
        rule.level = level
        remaining.append(rule)
        rules = remaining
    }
}
