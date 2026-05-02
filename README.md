# kissclaw-tools

Shared release-engineering tooling for [KissClaw](https://github.com/MachineWisdomAI/KissClaw) and [KissClawJJ](https://github.com/MachineWisdomAI/KissClawJJ).

## kc-check-imports

TypeScript-aware cherry-pick validation. Catches the failure mode where a backported test (or source file) imports a symbol that does not exist at the chosen baseline because the supporting commit was not also backported.

### Why this exists

ProdClaw PR #4 cherry-picked 24 commits from upstream OpenClaw onto a v2026.4.20 baseline. Several of those commits referenced symbols introduced by adjacent upstream commits that were not in the backport batch — the result was 70+ skipped tests, three runtime `ReferenceError`s after merge, and a missing helper file. Regex/grep cannot catch these — they need real TypeScript module resolution.

`kc-check-imports` simulates a cherry-pick onto a disposable baseline worktree, then runs the TypeScript Compiler API against the touched test files to surface unresolved imports/symbols.

### Usage

```bash
node kc-check-imports.mjs --baseline <ref> [mode-flag]
```

Three operational modes:

```bash
# Per-candidate: simulate each cherry-pick individually onto baseline.
# Use this in CI to attribute failures to specific commits.
node kc-check-imports.mjs --baseline v2026.4.20 \
  --candidates origin/ga/1.0..HEAD

# Final-tree: apply the FULL accumulated diff at once.
# Catches the case where a later cherry-pick depends on an earlier same-RC backport.
node kc-check-imports.mjs --baseline v2026.4.20 \
  --final-tree origin/ga/1.0..HEAD

# Staged: validate the staged patch in the current repo.
# Use this in pre-commit hooks.
node kc-check-imports.mjs --baseline v2026.4.20 --staged
```

### Verdicts

- `pass`: TypeScript pass returned no diagnostics in the configured filter set
- `fail`: TypeScript pass returned diagnostics; JSON includes file/symbol/code/message
- `needs-conflict-resolution`: cherry-pick or patch did not apply cleanly; the candidate is not evaluated and is reported for manual review

Filtered diagnostic codes: TS2304 (Cannot find name), TS2305 (no exported member), TS2307 (Cannot find module), TS2724 (no exported member, did you mean).

### Output

JSON to stdout, progress to stderr. Exit 0 on all-pass, 1 otherwise.

### CI integration

Both KissClaw and KissClawJJ run `kc-check-imports` on every PR targeting `ga/**` or `lts/**` branches. See `.github/workflows/kc-check-imports.yml` in either repo.

The workflow checks out this repo via `actions/checkout` (using `KISSCLAW_TOOLS_TOKEN` PAT or the default `GITHUB_TOKEN` if the calling repo has read access to this private repo).

### Pre-commit integration

```bash
# .git/hooks/pre-commit (or via husky/lefthook):
node /path/to/kissclaw-tools/kc-check-imports.mjs \
  --baseline v2026.4.20 --staged --repo "$PWD"
```

## Repo layout

```
.
├── kc-check-imports.mjs   # The validator (~250 LOC ESM Node.js, no build step)
├── package.json
└── README.md
```

## License

MIT.
