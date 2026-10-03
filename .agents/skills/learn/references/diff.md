# Learn from Git diff

Use the skill's `scripts/context.py` helper from the repository root. For project installs, the entry paths are `.agents/skills/learn/scripts/context.py` in Codex and `.claude/skills/learn/scripts/context.py` in Claude Code; for a global install, resolve the script beside the loaded `SKILL.md`.

1. On every diff request, immediately run this as the **first workspace command**, before reading this reference, running another shell command, or inspecting project files:

   ```sh
   python3 <skill>/scripts/context.py diff-bundle
   ```

   This one command summarizes staged, unstaged, and untracked changes, then returns a sample of no more than 3 representative paths. It excludes generated, vendor, lock, and `.learning/` material, and caps the full output at 12,000 characters. It identifies omitted paths. Do not run `git diff`, `git status`, or another source-reading command before it.
2. The helper ranks source, test, and config paths, and includes both staged and unstaged hunks for selected tracked files. Review the listed coverage, then verify selected claims and line numbers against current files. If the key path is beyond the bundle's 25-path summary, run `python3 <skill>/scripts/context.py diff-summary --limit 100` to inspect more path metadata; then run `python3 <skill>/scripts/context.py diff-read --file <path>` for a replacement path, still within the same 3-file and 12,000-character caps. Repeat `--file` at most three times if needed. Use these exact flags; do not call `--help` to discover syntax. Do not read every diff just to build a larger index.
3. Explain at most 2–3 important mechanisms. For repeated mechanical edits, explain one representative pattern and state how many similar files were omitted. Do not imply the sample covers the whole change.

If Python 3 or the helper is unavailable, do not search other skill directories or install another copy. Use `git status --short`, `git diff --stat`, `git diff --cached --stat`, and `git diff --numstat` only for preflight. Then read path-limited diffs for at most 3 files and relevant untracked-file excerpts. Never fall back to a full diff for a large change.
