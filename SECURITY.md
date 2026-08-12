# Security Policy

## Supported Scope

We prioritize vulnerabilities that affect archive compression, extraction, or inspection in the current default branch and latest release. Please report issues involving path traversal, symbolic link handling, privilege escalation, arbitrary file overwrite, or denial of service.

## Extraction Safeguards

Libera applies the following defense-in-depth measures when processing untrusted archives:

- Verifies that the final extraction path remains inside the selected destination directory.
- Rejects absolute paths, parent-directory paths, and symbolic or hard link entries.
- Does not overwrite existing files or follow symbolic links in the destination path.
- Limits archives to 10,000 entries, 1 GiB total extracted size, and 512 MiB per file.
- Cleans up partial output files when GZ streaming extraction fails.

ZIP passwords use ZipCrypto for compatibility. This is not a strong confidentiality mechanism and should not be the only protection for sensitive data.

## Reporting a Vulnerability

Do not post vulnerability details in a public issue. Use GitHub's [Private Vulnerability Reporting](https://github.com/noojung/libera/security/advisories/new) to report them confidentially. Include reproduction steps, impact, and any suggested mitigation when possible.

If Private Vulnerability Reporting is not enabled in the repository settings, maintainers must enable it under **Settings → Code security and analysis** in GitHub.
