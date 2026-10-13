# Public GitHub packaging

The public showcase is published at [LeksZy/deltaform](https://github.com/LeksZy/deltaform). The GitHub repository contains the reviewed source files and synthetic screenshots; local account state and development history remain excluded.

## Prepare a clean source archive

```sh
npm run showcase:package
```

This produces `releases/deltaform-showcase.zip` containing a `deltaform/` source folder and `SHOWCASE_MANIFEST.json` with file hashes. Packaging requires the `zip` utility available on macOS/Linux. The runnable paper demo requires only the documented Node/npm environment.

The packager uses an explicit documentation/image allowlist and accepts only source-file extensions in `src/`, `server/`, `tests/`, and `scripts/`. It rejects symlinks, checks that example credentials are blank and live execution is disabled, and builds a fresh archive in temporary storage. It never copies the working tree wholesale or includes Git history.

The public package includes the app, tests, lockfile, reviewed documentation, and three synthetic screenshots captured for the 11 October 2026 validation. Later documentation updates reuse these images. Inactive Derive source and tests remain for regression coverage; they are not an alternate live route.

## What stays local

Local environment files, account databases, backups, exports, logs, dependencies/builds, internal prompts, previous documentation snapshots, and historical screenshots are excluded. The revised `.gitignore` protects these paths from ordinary Git staging as well.

Original documentation was preserved under ignored `docs/internal/` before public editing. Historical images remain in the ignored `docs/ui-redesign/` directory. The public screenshots under `docs/showcase/` were captured from the isolated synthetic harness with disconnected accounts.

The initial GitHub commit uses only files from the reviewed manifest. The generated archive also provides a clean source snapshot without Git history or private state. Future publication updates should use the same explicit file review.

## Suggested GitHub presentation

- Repository name: `deltaform`.
- Description: `Research workbench for Meteora DLMM impermanent-loss protection, Bybit option fitting, and Hyperliquid delta hedging.`
- Topics: `defi`, `quantitative-finance`, `liquidity-provision`, `options`, `risk-management`, `typescript`, `paper-trading`.
- Landing page: the root README, with deeper mechanics and reproducible demo linked from it.

No license is selected by this packaging step. A GitHub showcase can be visible without granting an open-source license; choose reuse terms explicitly if you later want others to reuse or distribute the code.

New source or documentation added after this review needs a fresh content review. The allowlist prevents unrelated local files from entering the archive; it is not a substitute for checking newly added code for secrets or private data.
