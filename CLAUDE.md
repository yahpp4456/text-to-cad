@AGENTS.md

# Fork-local overrides (Windows self-use fork — these win over AGENTS.md)

This is a self-use fork (origin=yahpp4456, upstream=earthtojake), not PR'd upstream.

**This fork's primary work is `apps/cad-chat`** — a local web "conversational
CAD" app: browser chat → Claude Agent SDK (subscription OAuth or API key) drives
the repo's existing text-to-cad pipeline → real STEP/GLB + geometry validation,
iterated by text / geometry picks / parameter sliders. The rest of the repo
(`skills/`, `packages/cadpy*`, `packages/cadjs`, `models/`) is the CAD pipeline
and viewer runtime that cad-chat *drives* — it is not the day-to-day deliverable
here (that framing in AGENTS.md describes upstream). `apps/` is fork-local and
absent upstream, so keep cad-chat guidance in this file, not in AGENTS.md.

- Deep docs for the app live in `apps/cad-chat/README.md` (architecture,
  endpoints, MOTION contract, file-type/import/merge flows, view chrome). There
  is a nested `apps/cad-chat/CLAUDE.md` that Claude Code auto-loads inside that
  subtree.
- **Before editing cad-chat, load the `cad-chat-verify` skill**
  (`.claude/skills/cad-chat-verify/SKILL.md`) — it owns the layered verify
  pyramid (L0 build → L4 LLM), the "changed area → must-run layer" table, and
  the "new feature → which test" decision tree. Every layer runs LLM-free to the
  end; a real LLM turn is the last, most expensive, gated layer.

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
