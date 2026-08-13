# Libera

Libera is a desktop compression utility built with Electron, TypeScript, and React. It can compress files and folders, safely extract supported archives, and browse their contents.

## Requirements

- Node.js 22 LTS or later
- npm

## Getting Started

```bash
npm ci
npm run dev
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
| `npm test` | Run Vitest service tests |
| `npm run build` | Type-check and create a production bundle |
| `npm run dist` | Create distributable files with electron-builder |

`npm run dist` writes artifacts to `release/<version>`. The project is configured to build DMG/ZIP files for macOS (x64 and arm64) and an NSIS installer for Windows (x64).

## Supported Formats

| Feature | Formats | Constraints |
| --- | --- | --- |
| Compression | ZIP, TAR, TGZ, GZ | GZ supports a single file only |
| Extraction | ZIP, TAR, TGZ, TAR.GZ, GZ | Only archive files can be selected; folders are not accepted as input |
| Inspection | ZIP, TAR, TGZ, TAR.GZ, GZ | Supports browsing internal folders and searching descendants of the current location |
| Passwords | ZIP | Uses ZipCrypto for compatibility and does not provide strong confidentiality |

## Safe Extraction Policy

The following checks are applied before and during extraction:

- Rejects absolute paths and paths that escape the destination directory (Zip Slip).
- Rejects symbolic and hard links in archives, as well as symbolic links in the destination path.
- Never overwrites existing files.
- Limits archives to 10,000 entries, 1 GiB total extracted size, and 512 MiB per file.
- Removes partially written output files when GZ extraction fails or exceeds a limit.

Treat untrusted archives with care even when they pass these checks. See [SECURITY.md](SECURITY.md) for the complete security policy and vulnerability reporting instructions.

## License

[MIT](LICENSE)
