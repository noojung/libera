#!/usr/bin/env bash
# Builds Libera.app and a disk image of it for each Mac architecture asked for
# (both when none is named), the way the Electron release names them:
#
#   apps/macos/scripts/build-app.sh [arm64] [x64]
#
#   apps/macos/dist/<arch>/Libera.app
#   apps/macos/dist/<arch>/Libera.app.dSYM        symbols for crash reports
#   apps/macos/dist/Libera-<version>-mac-<arch>.dmg
#
# The app is signed ad hoc by default, as the Electron build is. Set
# LIBERA_SIGN_IDENTITY to a "Developer ID Application" identity to sign with
# the hardened runtime instead, and LIBERA_NOTARY_PROFILE to a profile saved by
# `xcrun notarytool store-credentials` to notarize and staple the images too.
# LIBERA_SKIP_CORE=1 reuses the libera-core build-core.sh last produced.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$root/apps/macos"
dist="$app/dist"
export PATH="$HOME/.cargo/bin:$PATH"
# CI runners point xcode-select at their Xcode; a machine left on the Command
# Line Tools needs the full Xcode for xcodebuild.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(xcode-select -p)"
  [[ "$DEVELOPER_DIR" == *CommandLineTools* ]] && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export DEVELOPER_DIR
export MACOSX_DEPLOYMENT_TARGET=13.0

archs=("$@")
[[ ${#archs[@]} -eq 0 ]] && archs=(arm64 x64)
for arch in "${archs[@]}"; do
  [[ "$arch" == arm64 || "$arch" == x64 ]] || { echo "Unknown architecture $arch: use arm64 or x64" >&2; exit 1; }
done

if [[ "${LIBERA_SKIP_CORE:-}" != 1 ]]; then
  "$app/scripts/build-core.sh"
fi

resources="$app/Sources/LiberaUI/Resources"
version="$(plutil -extract version raw -o - "$resources/appInfo.json")"
copyright="© $(plutil -extract copyrightYear raw -o - "$resources/appInfo.json") $(plutil -extract copyrightHolder raw -o - "$resources/appInfo.json")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/logo.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  # The logo is 512 pixels, so the largest retina size is the logo itself.
  if [[ "$double" -le 512 ]]; then
    sips -z "$double" "$double" "$root/logo.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$work/AppIcon.icns"

mkdir -p "$dist"
cd "$app"
for arch in "${archs[@]}"; do
  triple="$([[ "$arch" == arm64 ]] && echo arm64 || echo x86_64)-apple-macosx"
  swift build -c release --triple "$triple$MACOSX_DEPLOYMENT_TARGET" --product LiberaMacUI
  products=".build/$triple/release"

  out="$dist/$arch"
  bundle="$out/Libera.app"
  rm -rf "$out"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  cp "$products/LiberaMacUI" "$bundle/Contents/MacOS/Libera"
  # The symbols are half the executable; they stay beside the app, where a
  # crash report can be read against them, rather than inside it.
  dsymutil "$bundle/Contents/MacOS/Libera" -o "$out/Libera.app.dSYM"
  strip "$bundle/Contents/MacOS/Libera"
  # The UI reads its files from Contents/Resources (see AppResources.swift),
  # not from SwiftPM's resource bundle, which a signed app cannot keep at its root.
  cp -R "$products/LiberaMacUI_LiberaUI.bundle/Resources/." "$bundle/Contents/Resources/"
  cp "$work/AppIcon.icns" "$bundle/Contents/Resources/"

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
  <key>LSMinimumSystemVersion</key><string>$MACOSX_DEPLOYMENT_TARGET</string>
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
  codesign --verify --strict "$bundle"

  dmg="$dist/Libera-$version-mac-$arch.dmg"
  staging="$work/dmg-$arch"
  mkdir -p "$staging"
  cp -R "$bundle" "$staging/"
  ln -s /Applications "$staging/Applications"
  # LZMA, which every macOS the app runs on can open, rather than zlib.
  hdiutil create -volname "Libera $version" -srcfolder "$staging" -fs HFS+ -format ULMO -ov "$dmg" >/dev/null

  if [[ -n "${LIBERA_SIGN_IDENTITY:-}" ]]; then
    codesign --force --timestamp --sign "$LIBERA_SIGN_IDENTITY" "$dmg"
    if [[ -n "${LIBERA_NOTARY_PROFILE:-}" ]]; then
      xcrun notarytool submit "$dmg" --keychain-profile "$LIBERA_NOTARY_PROFILE" --wait
      xcrun stapler staple "$dmg"
    fi
  fi

  echo "Built ${bundle#"$root/"} ($(du -sh "$bundle" | cut -f1)) and ${dmg#"$root/"} ($(du -sh "$dmg" | cut -f1))"
done
