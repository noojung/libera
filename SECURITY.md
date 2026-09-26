# Security Policy

## Supported Scope

We prioritize vulnerabilities that affect archive compression, extraction, or inspection in the current default branch and latest release. Please report issues involving path traversal, symbolic link handling, privilege escalation, arbitrary file overwrite, or denial of service.

## Extraction Safeguards

Libera applies the following defense-in-depth measures when processing untrusted archives:

- Verifies that the final extraction path remains inside the selected destination directory.
- Rejects absolute paths, parent-directory paths, and duplicate output paths, and never restores hard links or special files such as devices and FIFOs.
- Restores symbolic link entries on macOS and Linux only when the link target is relative and resolves inside the destination; absolute or escaping targets reject the archive. Link restoration can be turned off, in which case link entries are skipped. On Windows, symbolic links are skipped by default and are not restored.
- Never follows or replaces a symbolic link that already exists in the destination path.
- Handles existing files according to the chosen conflict policy: skip them, or overwrite them after moving the original aside so a failed or cancelled job can restore it.
- Strips setuid, setgid, and sticky bits when restoring Unix permissions.
- On macOS, copies the archive's quarantine attribute onto the extracted top-level items so Gatekeeper still checks them.
- Limits archives to 100,000 entries, 1 TiB total extracted size, and 1 TiB per file.
- Requires extraction to leave at least 5% of the destination filesystem, or 1 GiB, free.
- Enforces output limits while streaming and cleans up files created by failed or cancelled extraction jobs.

## Password Protection

- ZIP archives can be encrypted with ZipCrypto (the default, for compatibility with older tools), AES-128, or AES-256 (WinZip AES). ZipCrypto is weak and should not be the only protection for sensitive data; choose AES-256 when the recipient's tool supports it. ZIP encryption never hides file names.
- 7z archives are encrypted with AES-256, and file names can optionally be encrypted as well.
- TAR, GZ, and ZST formats do not support passwords.

## Reporting a Vulnerability

Do not post vulnerability details in a public issue. Use GitHub's [Private Vulnerability Reporting](https://github.com/noojung/libera/security/advisories/new) to report them confidentially. Include reproduction steps, impact, and any suggested mitigation when possible.

If Private Vulnerability Reporting is not enabled in the repository settings, maintainers must enable it under **Settings → Code security and analysis** in GitHub.
