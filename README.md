# Libera

Libera is a desktop compression utility built with Electron, TypeScript, and React. It can compress files and folders, safely extract supported archives, and browse their contents.

[Website & user guide](https://noojung.github.io/libera/) · [Download the latest release](https://github.com/noojung/libera/releases/latest)

## Development Requirements

- Git
- Node.js 24.19.0 LTS (includes npm 11.17.0)
- macOS or Windows for local development

These requirements apply only when running Libera from source. Installing a
prebuilt release does not require Node.js or npm.

## Getting Started

Clone the repository and enter the project directory:

```bash
git clone https://github.com/noojung/libera.git
cd libera
```

Confirm that the required tools are available:

```bash
node --version
npm --version
```

Install the locked dependencies and start the Electron development app:

```bash
npm ci
npm run dev
```

Use `npm ci` for routine setup on every platform. Run `npm install` only when
intentionally adding or updating a dependency, and commit the resulting
`package.json` and `package-lock.json` changes together. The project rejects
other Node.js and npm versions so macOS, Windows, and CI produce the same lockfile.

The Electron window opens after Vite finishes its initial build. Press
<kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal to stop the development process.

Before submitting a change, run the same validation commands used by CI:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Installation Notes

The macOS app bundle is ad-hoc signed to keep Electron and its nested helpers
internally consistent, but it is not signed with a paid Apple Developer ID or
notarized. Gatekeeper therefore displays a warning after download. After the
first launch attempt, trusted users can allow the app from **System Settings →
Privacy & Security → Open Anyway**. Intel iMacs should use the `x64` installer;
Apple Silicon iMacs should use the `arm64` installer.

The Windows installer is also unsigned, so Windows SmartScreen may display a
warning. Developer code-signing credentials should be added before distributing
the application to a broad audience.

## Development Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite/Electron development server |
| `npm run lint` | Run ESLint static analysis |
| `npm run lint:fix` | Automatically fix supported ESLint issues |
| `npm run typecheck` | Run TypeScript type checking |
| `npm test` | Run Vitest service and React component tests |
| `npm run test:coverage` | Run tests and generate text and HTML coverage reports |
| `npm run build` | Type-check and create a production bundle |
| `npm run dist` | Create distributable files with electron-builder |

`npm run dist` writes artifacts to `release/<version>`. The project is configured to build DMG/ZIP files for macOS (x64 and arm64) and an NSIS installer for Windows (x64).

Build macOS installers on macOS and Windows installers on Windows. The GitHub
Actions release workflow builds each installer on its matching operating
system.

## Native macOS App

Libera is being rewritten as a native macOS app. Its archive engine is the Rust
crate `crates/libera-core`, which `crates/libera-ffi` exposes to Swift through
[UniFFI](https://github.com/mozilla/uniffi-rs), and its interface is the SwiftUI
app in `apps/macos`. The Electron app is maintained alongside it until the
native app reaches parity, and releases still ship the Electron build.

Building the native app requires:

- macOS 13 or later with Xcode 16 or later (the full Xcode, not only the Command Line Tools)
- [rustup](https://rustup.rs/), which installs the toolchain and both Mac targets pinned in `rust-toolchain.toml`
- Node.js and `npm ci`, as above, for the resource scripts

Build the engine for SwiftPM, then run or test the app:

```bash
apps/macos/scripts/build-core.sh
swift run --package-path apps/macos LiberaMacUI
swift test --package-path apps/macos
cargo test --workspace
```

For day-to-day work there are two ways to see changes as they are made:

- **Xcode previews.** Open `apps/macos/Package.swift` in Xcode, choose the
  `LiberaUI` scheme, and open any view file: the canvas redraws its `#Preview`
  as you type, with sample files, jobs and archives from `PreviewSupport.swift`.
  The code itself can be edited in any editor.
- **Rebuild and relaunch on save.** `npm run dev:macos` (or
  `node apps/macos/scripts/dev.mjs`) runs the app and restarts it whenever a
  file under `apps/macos/Sources` changes, rebuilding `libera-core` first when
  `crates/` does. Arguments go to the app, so a restart can open where you are
  working, for example `npm run dev:macos -- --screen inspect --expert`.
  Swift has no hot reload, so each change takes a few seconds and a fresh launch.

| Script | Description |
| --- | --- |
| `apps/macos/scripts/build-core.sh` | Build `libera-core` for both architectures and generate its Swift bindings. Run it again after changing `crates/` or the version |
| `apps/macos/scripts/build-app.sh [arm64] [x64]` | Build `Libera.app` and `Libera-<version>-mac-<arch>.dmg` in `apps/macos/dist` for each architecture named, or both |
| `apps/macos/scripts/sync-resources.mjs` | Copy the renderer's translations and icons into the app. Run it after changing either |
| `apps/macos/scripts/generate-licenses.mjs` | Regenerate the Licenses dialog's list after changing a Rust dependency |
| `apps/macos/scripts/subset-fonts.py` | Cut the Korean fonts in `apps/macos/fonts` down to the characters the app uses. Run it after changing the translations; it needs `pip install fonttools` |

`build-app.sh` signs ad hoc, so Gatekeeper treats the app as the Installation
Notes above describe. To sign with a Developer ID and the hardened runtime, set
`LIBERA_SIGN_IDENTITY` to the identity's name; to also notarize and staple the
disk image, set `LIBERA_NOTARY_PROFILE` to a profile saved with
`xcrun notarytool store-credentials`.

The `native-macos.yml` GitHub Actions workflow checks Rust formatting and lints,
runs both test suites, fails if the generated resources are out of date, and
uploads the disk image as a build artifact.

## Site Development

The project website lives in `site/` and is built with [Hugo](https://gohugo.io/) using the [PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme. Building the site locally requires:

- Go 1.26
- Hugo Extended 0.165.0

Start a local preview server with live reload:

```bash
npm run site:dev
```

Generate the production site into `site/public/`:

```bash
npm run site:build
```

The `pages.yml` GitHub Actions workflow builds and deploys the site to GitHub
Pages automatically when changes under `site/` are pushed to `main`.

## Supported Formats

<!-- begin generated format table -->
| Format | Extensions | Supported features | Codec support | Notes |
| --- | --- | --- | --- | --- |
| ZIP | .zip | Compress · Extract · Preview · Password create/extract · Split volumes | Write: Store, Deflate, LZMA, Zstandard<br>Read: Store, Deflate, Deflate64, LZMA, Zstandard<br>Encryption: ZipCrypto, AES-128, AES-256 | Expert mode picks the method: Deflate (8) by default, or Store (0), LZMA (14), Zstandard (93). Choosing Deflate or Zstandard brings that codec's own options with it. Password creation uses ZipCrypto by default; expert mode switches it to WinZip AES-256 or AES-128. Split sets use `.z01 … .zip`, with `.zip` as the representative file |
| 7Z | .7z | Compress · Extract · Preview · Password create/extract · Split volumes | Write: Copy, LZMA2<br>Read: Copy, LZMA, LZMA2, PPMd7, Deflate, Deflate64, BZip2<br>Encryption: AES-256<br>(Read) Filters: Delta, BCJ, BCJ2, ARM64, RISC-V, Swap2/4, PPC, IA64, ARM/Thumb, SPARC | Reads solid archives and AES-encrypted data or headers. Password creation uses AES-256 and can optionally encrypt the header, which hides the file names. Split sets use `.7z.001 …`, with `.7z.001` as the representative file |
| TAR | .tar | Compress · Extract · Preview | None | Stores multiple files without a compression codec |
| TAR.GZ | .tar.gz .tgz | Compress · Extract · Preview | Deflate | Stores multiple files through TAR |
| TAR.XZ | .tar.xz .txz | Extract · Preview | Read: LZMA2 | Read-only. Reads every integrity check the container defines, streams cut into several blocks, and concatenated streams. A filter ahead of LZMA2 — BCJ or delta — is refused rather than misread |
| TAR.BZ2 | .tar.bz2 .tbz2 .tbz | Extract · Preview | Read: BZip2 | Read-only |
| TAR.ZST | .tar.zst .tzst | Compress · Extract · Preview | Zstandard | Stores multiple files through TAR. Expert mode picks the search strategy, the window size, long distance matching, and the thread count |
| GZ | .gz | Compress · Extract · Preview | Deflate | Supports one file per stream. Expanded size and compression ratio remain unknown until extraction |
| XZ | .xz | Extract · Preview | Read: LZMA2 | Read-only. One file per stream |
| BZ2 | .bz2 | Extract · Preview | Read: BZip2 | Read-only. One file per stream |
| ZST | .zst | Compress · Extract · Preview | Zstandard | Supports one file per stream, with the same expert codec options as TAR.ZST. Expanded size and compression ratio remain unknown until extraction |
| JAR | .jar | Extract · Preview | Read: Store, Deflate, Deflate64 | Read-only ZIP container |
| WAR | .war | Extract · Preview | Read: Store, Deflate, Deflate64 | Read-only ZIP container |
<!-- end generated format table -->

XZ and BZ2 are read but not written, whether they wrap a tarball or a lone
file: LZMA2 and BZip2 both decode here, and only LZMA2 encodes, so writing
either would offer one of them alone. 7Z already writes LZMA2, and at a better
ratio than either wrapper reaches. Zstandard goes both ways, since Node's zlib
bindings carry an encoder as well as a decoder.

The compression level slider keeps its ten steps for Zstandard and the writer
maps them onto the codec's own 1-19 scale, so level 6 - the default everywhere
but 7Z - lands on Zstandard 13, which finishes a mixed payload in about the
time `gzip -6` takes and smaller.

Expert mode sets what the level would otherwise decide: the search strategy
(Fast through Binary Tree Ultra2), the window size, long distance matching, and
how many threads the encoder may use. The same four apply to a ZIP whose method
is Zstandard, since it is the same encoder writing its entries.

The window stops at 128 MB because a decoder allocates the whole window before
it reads and refuses a frame asking for more than its own limit, which is
128 MB by default everywhere - a wider window would write archives only a
specially configured reader could open. Long distance matching widens the reach
on its own, but it can never look past the window, so pinning a window narrower
than the gap between two repeats cancels it.

Threads change only how fast an archive is written, never what it decodes to,
and are off unless asked for. Node's binding loses a Zstandard stream outright -
no output, and no error to say so - when a single write past about 16 MiB
reaches an encoder running them, so the encoder splits its own input and no
caller can reach that.

Preview includes archive browsing and search, 1 MiB text previews, and PNG,
JPEG, WebP, and GIF image previews. For split ZIP and 7Z archives, selecting
any volume discovers the complete set in the same folder; every volume must
remain together. Volume details are collapsed by default and can be expanded.

## Compression Source Filters
Expert mode decides what the input tree contributes to an archive. Every filter
applies to ZIP, TAR, TAR.GZ, TAR.ZST, and 7Z; GZ and ZST compress a single stream the user
picked themselves, so it offers none of them. Excluded files are left out of the
progress total as well, so the percentage still ends on 100.

- Symbolic links are stored as link entries, pointing at the same target the
  original does, and are never followed during the walk. **Exclude symbolic
  links** leaves them out of the archive entirely.
- **Exclude macOS metadata** drops `.DS_Store`, `__MACOSX` folders, and `._name`
  AppleDouble sidecars, in the input roots and every folder below them.
- **Exclude hidden files** drops dot-prefixed names. A hidden folder is dropped
  whole, so nothing below `.git` is walked in the first place.
- **File filter pattern** takes the same glob list the extraction panel does:
  `*.txt, *.pdf` keeps only what matches, a `!` prefix excludes, and a pattern
  holding a slash matches the whole archive path rather than the name alone. It
  decides files, not folders - a folder matches no pattern of its own yet still
  carries the files that do.

The extraction panel has the mirror of these: **Restore symbolic links**,
**Filter out macOS metadata**, and its own **File filter pattern**.

## Safe Extraction Policy
The following checks are applied before and during extraction:

- Rejects absolute paths and paths that escape the destination directory (Zip Slip).
- Restores a symbolic link only when its target resolves inside the destination, and rejects hard links outright. Symbolic links in the destination path are always rejected. On Windows, where creating a link needs a privilege the app cannot assume, link entries are rejected instead.
- Never overwrites existing files by default. Expert mode offers three rules for
  a clash instead: overwrite (the replaced file is kept aside and restored if the
  job fails), skip, or keep both, which writes the extracted file beside the
  original under the first free numbered name (`report (1).txt`,
  `backup (1).tar.gz`). Folders are merged under every rule.
- Limits archives to 100,000 entries, 1 TiB total extracted size, and 1 TiB per file.
- Verifies that extraction leaves at least 5% of the destination filesystem, or 1 GiB, free.
- Streams extracted data and removes files created by a failed or cancelled extraction.

7Z entries are streamed through the TypeScript reader. Filesystem writes stay
inside the same validation and transaction layer, and content that disagrees
with the sizes or CRCs declared by the archive is rejected.

XZ and BZ2 are decoded through the same reader as they are read, so the
limits above count the expansion as it lands rather than after it. Both verify
the integrity check their container carries and stop on a mismatch instead of
handing back what decoded before it. The one difference is where the compressed
bytes sit: xz declares how long each of its chunks is, so nothing is held, while
bzip2 gives no way to find the end of a block without decoding it and so is read
in full first. What that holds is the archive as it already exists on disk - the
expansion, which is where a decompression bomb does its damage, is still handed
on a block at a time.

GZ stores its uncompressed size modulo 4 GiB, so the inspector reports the
expanded size and compression ratio as unknown until extraction completes.

Text previews are decoded as UTF-8 or BOM-marked UTF-16 and are read directly
from the archive without creating temporary files. Libera stops after the first
1 MiB of expanded content and rejects binary data. Encrypted entries are
previewed too: a ZIP lists without a password, so the prompt appears when the
entry itself is opened.

PNG, JPEG, WebP, and GIF previews are detected from their file signatures rather
than their names. Image data is limited to 10 MiB, 16,384 pixels on either axis,
and 25 megapixels in total. SVG and other image formats are never rendered as
images, and encrypted ZIP entries remain unavailable without extraction.

Treat untrusted archives with care even when they pass these checks. See [SECURITY.md](SECURITY.md) for the complete security policy and vulnerability reporting instructions.

## License

[MIT](LICENSE)
