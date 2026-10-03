# Review saved learning

Use `scripts/context.py` beside this reference to search project notes without sending the full history into the model context. For project installs, Codex uses `.agents/skills/learn/scripts/context.py` and Claude Code uses `.claude/skills/learn/scripts/context.py`; for a global install, resolve it beside the loaded `SKILL.md`.

1. The **first project command** for Review is `python3 <skill>/scripts/context.py review-index --limit 3`. Run it before reading repository files. It returns compact candidates, prioritizing unchecked gaps and then older concepts; answers are omitted from this index. Do not reread `SKILL.md` or `notes.md` from disk.
2. Use the documented helper syntax directly; do not spend a call on `--help`. Read only the first candidate using `python3 <skill>/scripts/context.py review-entry --line <line-number>`. If its evidence is stale or unusable, try the next candidate; do not preload all three. Do not `cat` `.learning/notes.md` or load unrelated entries.
3. Verify the selected source against current code or its cited documentation. If the source changed, close the old gap as `STALE` and skip it or find a current entry; never grade against an obsolete answer.
4. Start with the question batch, without teaching the mechanism or exposing the stored correction first. Use the selected level's question total and same-type batching from `SKILL.md`. Base questions on the selected record and verified evidence; expand another candidate only when needed, without preloading every note. Do not pad a small record to meet the minimum. After the learner responds, grade each provided answer, update only the relevant records, and include the next batch when the current one is complete. End with the count of questions not yet shown.
5. If no active gaps or concepts exist, say so. Do not invent a question from current code and present it as a review of saved learning.
6. When saving an answer or adding a gap, check whether `.learning/notes.md` exists and inspect only the relevant section or selected record. Apply a targeted edit that preserves all other entries. After the write succeeds, do not reread the whole file to verify it.

If Python 3 or the helper is unavailable, do not search other skill directories or install another copy. Use `rg -n '^- \[ \]' .learning/notes.md | head -n 12` to list open gaps, followed by `rg -n '^- \[[xX]\] \[CONCEPT ' .learning/notes.md | head -n 12` for concepts. These commands return title lines only; select one candidate, then use `awk -v n=42 'NR==n {printing=1} printing && NR>n && /^[-*] \[[ xX]\]/ {exit} printing {print}' .learning/notes.md` to read only that entry, replacing `42` with its line number. If an old title itself contains its answer, skip it.

When the selected entry's evidence is missing, changed, or does not support its claim, mark that exact entry `[x]` and append `STALE` before moving to another candidate. Do not leave an unusable gap open or ask a question based on it.

New records should be easy to index and should not put the answer on the same line as the title:

```markdown
- [ ] [GAP G-20260928-cache-fallback] Redis fallback | 2026-09-28
  Question: If Redis is unavailable, what does this call do?
  Correction: The current path propagates the Redis exception; it does not fall back to the database.
  Source: `src/cache.py:8` (commit `abc1234`)
  Last reviewed: never
```

Use `[x]` for a gap understood during review, and append `STALE` when code evidence is obsolete. Use `[x] [CONCEPT C-...]` for concepts. Preserve all unrelated records and headings; edit only the selected bullet. When adding a record, check for an existing topic ID and insert it under the matching section without rewriting the file.
