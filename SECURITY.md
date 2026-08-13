# Security Policy

## Supported Scope

We prioritize vulnerabilities that affect archive compression, extraction, or inspection in the current default branch and latest release. Please report issues involving path traversal, symbolic link handling, privilege escalation, arbitrary file overwrite, or denial of service.

## Extraction Safeguards

Libera applies the following defense-in-depth measures when processing untrusted archives:

- Verifies that the final extraction path remains inside the selected destination directory.
- Rejects absolute paths, parent-directory paths, and symbolic or hard link entries.
- Does not overwrite existing files or follow symbolic links in the destination path.
- Limits archives to 100,000 entries, 1 TiB total extracted size, and 1 TiB per file.
- Requires extraction to leave at least 5% of the destination filesystem, or 1 GiB, free.
- Enforces output limits while streaming and cleans up files created by failed or cancelled extraction jobs.

ZIP passwords use ZipCrypto for compatibility. This is not a strong confidentiality mechanism and should not be the only protection for sensitive data.

## Reporting a Vulnerability

Do not post vulnerability details in a public issue. Use GitHub's [Private Vulnerability Reporting](https://github.com/noojung/libera/security/advisories/new) to report them confidentially. Include reproduction steps, impact, and any suggested mitigation when possible.

If Private Vulnerability Reporting is not enabled in the repository settings, maintainers must enable it under **Settings → Code security and analysis** in GitHub.
