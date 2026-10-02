#!/usr/bin/env bash
# Builds libera-core for both Mac architectures and lays it out for SwiftPM:
# the XCFramework the app links, the Swift bindings UniFFI generates for it,
# and the app info the About dialog reads. Run it again whenever crates/ or
# the version changes.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$root/apps/macos"
work="$root/target/libera-core-swift"
export PATH="$HOME/.cargo/bin:$PATH"
# CI runners point xcode-select at their Xcode; a machine left on the Command
# Line Tools needs the full Xcode for xcodebuild.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(xcode-select -p)"
  [[ "$DEVELOPER_DIR" == *CommandLineTools* ]] && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export DEVELOPER_DIR
# Matches the platform in Package.swift, so the linker has nothing to warn about.
export MACOSX_DEPLOYMENT_TARGET=13.0

cd "$root"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release -p libera-ffi --target "$target"
done

rm -rf "$work"
mkdir -p "$work/headers"
lipo -create \
  target/aarch64-apple-darwin/release/liblibera_ffi.a \
  target/x86_64-apple-darwin/release/liblibera_ffi.a \
  -output "$work/liblibera_ffi.a"

cargo run -q -p uniffi-bindgen -- generate \
  --library target/aarch64-apple-darwin/release/liblibera_ffi.a \
  --language swift --out-dir "$work/bindings"

cp "$work/bindings/LiberaCoreFFI.h" "$work/headers/"
# SwiftPM reads a binary target's module map only under this name.
cp "$work/bindings/LiberaCoreFFI.modulemap" "$work/headers/module.modulemap"
rm -rf "$app/Frameworks/LiberaCoreFFI.xcframework"
xcodebuild -create-xcframework \
  -library "$work/liblibera_ffi.a" -headers "$work/headers" \
  -output "$app/Frameworks/LiberaCoreFFI.xcframework" >/dev/null

mkdir -p "$app/Sources/LiberaCore/Generated"
cp "$work/bindings/libera_core.swift" "$app/Sources/LiberaCore/Generated/"
# The release workflow bumps the version in the renderer's copy alone.
cp "$root/src/renderer/src/generated/appInfo.json" "$app/Sources/LiberaUI/Resources/appInfo.json"
echo "libera-core is ready for SwiftPM"
