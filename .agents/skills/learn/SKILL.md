---
name: learn
description: Learn from a coding session, current Git changes, specified code, or a programming topic with evidence-based explanations and interactive recall; review saved gaps and concepts. Use for natural-language learning requests as well as explicit learn commands. For current Git changes, run the bounded helper before any repository inspection. Do not interrupt ordinary coding work.
---

# Learn from coding

Help the user understand a selected piece of work through a concise explanation, active recall, and a small project-local record. Match the user's language. Use the coding agent's existing tools; do not start a separate model client or service.

## Choose the source

The user may choose `session`, `diff`, `file <path>`, `topic <subject>`, or `review`; natural language is fine. If the source is unclear (including a bare `learn` invocation), ask for it once, showing source choices and the depth/focus entry hint below when applicable; wait for the source, but do not require depth or focus choices. Do not inspect project material before the source is selected. Default to a short explanation followed by a quiz; honor explanation-only and quiz-first requests. `review` uses saved records and starts with questions, without a lesson or mechanism hints before the answers unless explanation-only was requested.

Default to **light / 轻度** and **general / 通用** without a mandatory selection dialog. General selects useful mechanisms without covering every focus; principles may name a concept. At the round's entry, if either depth or focus is omitted, use the following line-separated hint (translate to match the user's language). Keep it separate from the lesson and question-count footer; do not merge it into workflow narration.

```text
你可以选择学习深度和学习方向：
- 学习深度：轻度（1–2题）/ 中度（3–4题）/ 深度（5–8题）
- 学习方向：通用 / 语法规则 / 技术原理 / 功能逻辑 / 整体架构
回复“深度：中度，方向：功能逻辑”即可切换，也可以只改其中一项。
默认模式：轻度、通用。
```

Preserve explicit choices, default only omitted fields, and add a short “本轮选择” line if the effective settings differ from the defaults. With a known source, continue immediately; do not wait for confirmation. Show the hint once per round, not again after source clarification or each answer. Accept “深度：中度，方向：功能逻辑” and equivalent natural-language replies as setting changes; do not grade them as quiz answers or reset the source. Read [references/learning-options.md](references/learning-options.md) only for a nondefault level or focus, not merely to display the options.

For a `diff` request, immediately run the bounded helper below as the first workspace command. Do not run `git status`, `git diff`, or read project files first. Then load [references/diff.md](references/diff.md) and verify only the returned sample. For `review`, read [references/review.md](references/review.md) before reading project notes. These are the source references; `session`, `file`, and `topic` need no source reference.

The first project command for `diff` must be `python3 <skill>/scripts/context.py diff-bundle`; it returns the summary and bounded sample together. For `review`, first run `python3 <skill>/scripts/context.py review-index --limit 3`; it returns titles only. Do not first read repository diffs or learning notes. If the selected helper is missing or exits unsuccessfully, do not search other skill installations; load that mode's reference and follow its bounded fallback. Do not reread the skill files from disk; the skill is already loaded. Resolve the script beside this skill; project entry paths are `.agents/skills/learn/scripts/context.py` in Codex and `.claude/skills/learn/scripts/context.py` in Claude Code.

For other sources, inspect only the context needed. `session` uses recent relevant conversation to locate work, then verifies it against current code. `file` reads the named file first (a relevant excerpt for a large file), then searches only for the called symbols in likely source and test directories; avoid repository-wide searches. `topic` prefers a project example; if none exists, label the explanation as general knowledge. Light uses 1–2 useful points and the target plus only an essential related excerpt. Do not scan unrelated files, generated output, or old history.

## Teach and check understanding

- Match the explanation to the selected level and focus. Keep the initial explanation short; deepen selected mechanisms with evidence rather than a broad tutorial.
- Ground each important project claim in a current relative `file:line` pointing at the relevant condition, call, or assertion. Distinguish code facts, general knowledge, and inference. Do not guess author intent.
- Choose an evidence-supported total within the level's range at the start. Plan only the count and question types; generate each batch when needed. Use globally numbered `Q1`, `Q2`, etc. Give all questions of the same type together (prediction, application, debugging, or design tradeoffs); wait for their answers. Do not split one type across batches or reveal answers or targeted hints first. If the source cannot support the minimum without repetition, disclose the smaller total rather than pad it.
- Grade each supplied answer separately. Leave omitted answers pending, list their IDs, and keep the current batch open. When every question in the batch has an answer (including explicit “不知道”), include the next type's batch immediately in the grading response; do not require a separate “continue” request.
- End every learner-facing turn with `后续题目数量为 X`. X counts planned questions **not yet shown**, excluding pending questions already shown. Mention pending IDs separately. Awaiting a source before any questions are planned, explanation-only, an unusable source, a completed round, and an explicit stop all end with X = 0. Reduce the count as batches are shown; revise the plan only for a user change or insufficient evidence, explaining the adjustment.
- Grade against inspected code or a reliable source, accepting equivalent wording. Check the main result and reasoning; mark answers correct, partial, wrong, or uncertain and explain with evidence. If challenged, recheck and correct the grade when needed.
- In quiz-first mode, ask before teaching. In explanation-only mode, do not ask a question. After the last answer, give a brief takeaway and any remaining gap.
- Treat “stop”, “结束学习”, “退出学习”, or a new unrelated task as the end of this round. Do not grade or save an unanswered question.

## Keep a small learning record

Use `.learning/notes.md`; never replace existing notes with a template. Before a write, check this exact path and inspect only the section or entry being changed. Use a path existence check, section headers, a topic search, or `review-entry`; do not `cat` the whole file. After a successful write, do not read the file back; rely on the write result. In a Git repository, ensure `.learning/` is ignored without duplicating the rule. Do not change source code as part of learning.

Keep `## Gaps` and `## Concepts`. Start each concise record with `- [ ] [GAP <id>] <topic> | <date>` or `- [x] [CONCEPT <id>] <topic> | <date>`. Put `Question`, `Correction` or `Takeaway`, `Source` (current `file:line` and commit when available, or documentation), and `Last reviewed` on indented lines below it; the title line must contain no answer, so the review index cannot reveal it. Use unchecked boxes for active gaps and checked boxes for understood or obsolete gaps; label obsolete gaps `STALE`. Preserve unrelated entries. Update a duplicate in place. Save wrong or materially incomplete answers as gaps and at most 2–3 important, nonduplicate concepts per round. Do not save full lessons or unanswered questions. Briefly tell the user what was saved.

Do not imply background monitoring. A large active diff may merit one brief suggestion to learn from that change; several open gaps may merit one brief suggestion to review older learning. Manual `review` is always available.
