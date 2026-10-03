# Learning depth and focus

Use optional modifiers as natural language; do not require a settings dialog or save a separate configuration file. A source identifies the material (`file`, `session`, `diff`, `topic`, or `review`); a focus selects what to learn from it. For example, `file src/auth.py 深度，聚焦 JWT 原理` still starts from that file. `topic JWT` starts from the subject itself.

## Depth

- **Light / 轻度:** explain 1–2 useful points from the target and only essential related evidence. Use short behavior or application questions. Avoid loading a call chain or browsing merely to lengthen the lesson.
- **Medium / 中度:** connect 2–3 points with relevant callers or tests. Questions may combine behavior, application, and failure cases; inspect only the paths needed for those claims.
- **Deep / 深度:** trace a selected mechanism through callers, tests, configuration, or module boundaries. Include distinct transfer, debugging, or design problems instead of rewording a definition. Read related excerpts in stages, stopping once the selected claims are supported. Show the verified scope and any unanswered architectural assumptions.

All levels preserve the diff helper's three-path and 12,000-character limits per call. Depth does not authorize a complete large diff, entire repository scan, or full note history. Replace sample paths or inspect necessary related excerpts only to resolve a named claim. Session depth uses the relevant work in the visible conversation; do not reconstruct every old turn. Higher levels allow more exploration, but do not promise a fixed time or token cost.

External research is driven by an unsupported claim, a version-sensitive API, or an explicit research request, at any level. Prefer a directly relevant official source and stop when it supports the claim. Deep does not imply automatic web research. If retrieval is unavailable, label uncertainty and do not grade against an unverified claim.

## Focus

- **General / 通用:** select the most useful mechanisms for this source; combine directions only when that helps explain the work.
- **Syntax / 语法规则:** explain actual language or API constructs in the target, then test their behavior with a small variation. Avoid unrelated syntax trivia.
- **Principles / 技术原理:** explain a named concept through the project's implementation and its limits; distinguish the general principle from local behavior.
- **Logic / 功能逻辑:** follow inputs, branches, state changes, outputs, and failure paths. Ask the learner to predict concrete results.
- **Architecture / 整体架构:** verify dependency direction, module responsibilities, and boundaries. Relate these to a tradeoff, labeling inferred intent. With a narrow source, explain the local architectural slice and identify evidence needed for broader claims.

The focus changes explanation and question content; the level controls exploration and the total question count in `SKILL.md`. Keep questions answerable from inspected material, and never increase their count just because another direction is available.
