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

| Feature | Formats | Constraints |
| --- | --- | --- |
| Compression | ZIP, TAR, TGZ, GZ | GZ supports a single file only |
| Extraction | ZIP, TAR, TGZ, TAR.GZ, GZ | Only archive files can be selected; folders are not accepted as input |
| Inspection | ZIP, TAR, TGZ, TAR.GZ, GZ | Supports browsing, searching, 1 MiB text previews, and image previews for PNG, JPEG, WebP, and GIF files |
| Passwords | ZIP | Uses ZipCrypto for compatibility and does not provide strong confidentiality |

## Safe Extraction Policy

The following checks are applied before and during extraction:

- Rejects absolute paths and paths that escape the destination directory (Zip Slip).
- Rejects symbolic and hard links in archives, as well as symbolic links in the destination path.
- Never overwrites existing files.
- Limits archives to 100,000 entries, 1 TiB total extracted size, and 1 TiB per file.
- Verifies that extraction leaves at least 5% of the destination filesystem, or 1 GiB, free.
- Streams extracted data and removes files created by a failed or cancelled extraction.

GZ stores its uncompressed size modulo 4 GiB, so the inspector reports the
expanded size and compression ratio as unknown until extraction completes.

Text previews are decoded as UTF-8 or BOM-marked UTF-16 and are read directly
from the archive without creating temporary files. Libera stops after the first
1 MiB of expanded content, rejects binary data, and does not preview encrypted
ZIP entries.

PNG, JPEG, WebP, and GIF previews are detected from their file signatures rather
than their names. Image data is limited to 10 MiB, 16,384 pixels on either axis,
and 25 megapixels in total. SVG and other image formats are never rendered as
images, and encrypted ZIP entries remain unavailable without extraction.

Treat untrusted archives with care even when they pass these checks. See [SECURITY.md](SECURITY.md) for the complete security policy and vulnerability reporting instructions.

## License

[MIT](LICENSE)
