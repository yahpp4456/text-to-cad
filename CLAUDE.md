@AGENTS.md

# Fork-local overrides (Windows self-use fork — these win over AGENTS.md)

This is a self-use fork (origin=yahpp4456, upstream=earthtojake), not PR'd upstream.

- **NEVER commit unless the user explicitly asks for it.** Do all work in the
  working tree and leave it uncommitted; the user decides when to commit. This
  overrides the "Commit directly to it" note below — that describes *where* to
  commit (the `開發` branch) once the user has asked, not permission to commit
  on your own. Auto-commit, "commit when done", and committing as a convenience
  are all forbidden without an explicit request.
- Work branch is `開發` (main-derived). Commit directly to it (only when the user
  asks — see the rule above); no PR, no feature branch. Never push (Sam pushes),
  never touch `main` (kept as a clean upstream mirror; pull updates via
  `git fetch upstream main` then merge into `開發`).
- No symlinks here (core.symlinks=false); every vendored path is an independent
  copy. Sync shared Python packages with `scripts/dev/sync-vendored.sh`, NOT
  `bundle.sh` (Git Bash has no rsync) and NOT `setup-symlinks.sh`. Never hand-roll
  a broad `find|cp` — it clobbers the tracked `tests/python/packages/` unit tests.
- The `Release` / `Deploy` / `Upload Models` workflows are N/A (they target the
  original author's hosted resources). "Releasing" here is just a commit.
- Python interpreter is `.venv/Scripts/python.exe` (Windows; venv in `Scripts/`,
  not `bin/`). Run repo `*.sh` scripts under Git Bash, not PowerShell.
