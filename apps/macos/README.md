# Libera for macOS

The native macOS app: a SwiftUI interface over `libera-core`, the Rust archive
engine in [`crates/`](../../crates).

## Building

The Swift package links the engine as an XCFramework that is built, not
checked in, so build it first and again whenever `crates/` changes:

```sh
apps/macos/scripts/build-core.sh
```

It needs the Rust toolchain from `rust-toolchain.toml` and Xcode; set
`DEVELOPER_DIR` if Xcode is not at `/Applications/Xcode.app`. Then, from
`apps/macos`:

```sh
swift build
swift test
```

`swift test` also needs Xcode rather than the Command Line Tools, so prefix it
with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if
`xcode-select` points at the latter.
