#!/usr/bin/env bash
# Builds Libera.app for both Mac architectures and a disk image of it:
#
#   apps/macos/dist/Libera.app
#   apps/macos/dist/Libera-<version>-mac-universal.dmg
#
# The app is signed ad hoc by default, as the Electron build is. Set
# LIBERA_SIGN_IDENTITY to a "Developer ID Application" identity to sign with
# the hardened runtime instead, and LIBERA_NOTARY_PROFILE to a profile saved by
# `xcrun notarytool store-credentials` to notarize and staple the image too.
# LIBERA_SKIP_CORE=1 reuses the libera-core build-core.sh last produced.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$root/apps/macos"
dist="$app/dist"
bundle="$dist/Libera.app"
export PATH="$HOME/.cargo/bin:$PATH"
# CI runners point xcode-select at their Xcode; a machine left on the Command
# Line Tools needs the full Xcode for xcodebuild.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(xcode-select -p)"
  [[ "$DEVELOPER_DIR" == *CommandLineTools* ]] && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export DEVELOPER_DIR
export MACOSX_DEPLOYMENT_TARGET=13.0

if [[ "${LIBERA_SKIP_CORE:-}" != 1 ]]; then
  "$app/scripts/build-core.sh"
fi

resources="$app/Sources/LiberaUI/Resources"
version="$(plutil -extract version raw -o - "$resources/appInfo.json")"
copyright="© $(plutil -extract copyrightYear raw -o - "$resources/appInfo.json") $(plutil -extract copyrightHolder raw -o - "$resources/appInfo.json")"

# One slice at a time: building both in one `swift build` goes through the
# Xcode build system, whose linker trips over the combined objects.
cd "$app"
for arch in arm64 x86_64; do
  swift build -c release --triple "$arch-apple-macosx13.0" --product LiberaMacUI
done

rm -rf "$dist"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
lipo -create \
  .build/arm64-apple-macosx/release/LiberaMacUI \
  .build/x86_64-apple-macosx/release/LiberaMacUI \
  -output "$bundle/Contents/MacOS/Libera"
# The UI reads its files from Contents/Resources (see AppResources.swift), not
# from SwiftPM's resource bundle, which a signed app cannot keep at its root.
cp -R .build/arm64-apple-macosx/release/LiberaMacUI_LiberaUI.bundle/Resources/. "$bundle/Contents/Resources/"

iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/logo.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  # The logo is 512 pixels, so the largest retina size is the logo itself.
  if [[ "$double" -le 512 ]]; then
    sips -z "$double" "$double" "$root/logo.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/AppIcon.icns"

cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Libera</string>
  <key>CFBundleExecutable</key><string>Libera</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.libera.app</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>ko</string></array>
  <key>CFBundleName</key><string>Libera</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>$copyright</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
plutil -lint -s "$bundle/Contents/Info.plist"

xattr -cr "$bundle"
if [[ -n "${LIBERA_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$LIBERA_SIGN_IDENTITY" "$bundle"
else
  codesign --force --sign - "$bundle"
fi
codesign --verify --strict --verbose=1 "$bundle"

dmg="$dist/Libera-$version-mac-universal.dmg"
staging="$(mktemp -d)"
cp -R "$bundle" "$staging/"
ln -s /Applications "$staging/Applications"
hdiutil create -volname "Libera $version" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$dmg" >/dev/null
rm -rf "$staging"

if [[ -n "${LIBERA_SIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$LIBERA_SIGN_IDENTITY" "$dmg"
  if [[ -n "${LIBERA_NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$dmg" --keychain-profile "$LIBERA_NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi
fi

echo "Built ${bundle#"$root/"} and ${dmg#"$root/"}"
