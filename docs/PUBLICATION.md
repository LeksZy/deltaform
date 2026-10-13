# Source archive

The repository is available at [LeksZy/deltaform](https://github.com/LeksZy/deltaform). The source archive contains the application, tests, lockfile, documentation and synthetic screenshots.

## Build the archive

```sh
npm run showcase:package
```

The command writes `releases/deltaform-showcase.zip`, containing a `deltaform/` source folder and `SHOWCASE_MANIFEST.json` with SHA-256 file hashes. Packaging requires the `zip` utility on macOS/Linux. The paper demo uses the Node/npm environment documented in [RUNBOOK.md](RUNBOOK.md).

The packager uses an explicit documentation/image allowlist and accepts source-file extensions in `src/`, `server/`, `tests/` and `scripts/`. It rejects symlinks, checks that example credentials are blank and live execution is disabled, and builds each archive in a fresh temporary directory.

## Contents

The archive includes three synthetic screenshots captured for the 11 October 2026 validation. Their provenance and the package verification results are recorded in [VALIDATION.md](VALIDATION.md). Inactive Derive source and tests provide regression coverage; they are not an alternate live options route.

## Data exclusions

Local environment files, account databases, backups, exports, logs, dependencies, builds, internal notes, historical screenshots and Git history are excluded from the archive. The `.gitignore` also excludes local configuration and account state from ordinary Git staging.

The allowlist controls which files enter the archive. Content checks are still required to prevent credentials, private URLs or account data from appearing inside an allowed source or documentation file. The public images under `docs/showcase/` contain only synthetic paper data and disconnected accounts.
