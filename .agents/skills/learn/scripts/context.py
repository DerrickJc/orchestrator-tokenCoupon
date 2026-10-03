#!/usr/bin/env python3
"""Return bounded Git diff or learning-note context for the learn skill."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path.cwd().resolve()
MAX_FILES = 3
MAX_CHARS = 12_000
MAX_ENTRY_CHARS = 4_000
TEXT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js",
    ".jsx", ".kt", ".md", ".php", ".py", ".rb", ".rs", ".scala", ".sh",
    ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
SKIP_PARTS = {
    ".git", ".learning", ".next", ".venv", "build", "dist", "generated", "node_modules",
    "vendor", "__pycache__", "coverage",
}
SKIP_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock"}


def run_git(args: list[str]) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(message or f"git {' '.join(args)} failed")
    return result.stdout


def clean_path(path: str) -> bool:
    candidate = Path(path)
    name = candidate.name.lower()
    return (
        not any(part.lower() in SKIP_PARTS for part in candidate.parts)
        and name not in SKIP_NAMES
        and candidate.suffix.lower() != ".lock"
        and not name.endswith((".min.js", ".min.css", ".map"))
    )


@dataclass
class Change:
    path: str
    status: str
    staged_add: int = 0
    staged_del: int = 0
    work_add: int = 0
    work_del: int = 0
    untracked_lines: int = 0
    untracked_bytes: int = 0

    @property
    def changed_lines(self) -> int:
        return self.staged_add + self.staged_del + self.work_add + self.work_del + self.untracked_lines


def parse_status() -> dict[str, str]:
    raw = run_git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    pieces = raw.split(b"\0")
    result: dict[str, str] = {}
    index = 0
    while index < len(pieces):
        record = pieces[index]
        index += 1
        if not record:
            continue
        status = record[:2].decode("ascii", "replace")
        path = record[3:].decode("utf-8", "replace")
        if "R" in status or "C" in status:
            if index < len(pieces) and pieces[index]:
                path = pieces[index].decode("utf-8", "replace")
                index += 1
        if clean_path(path):
            result[path] = status
    return result


def numstat(path: str, cached: bool) -> tuple[int, int]:
    args = ["diff", "--numstat"]
    if cached:
        args.append("--cached")
    args.extend(["--", path])
    output = run_git(args).decode("utf-8", "replace")
    additions = deletions = 0
    for row in output.splitlines():
        columns = row.split("\t", 2)
        if len(columns) != 3:
            continue
        try:
            additions += int(columns[0])
            deletions += int(columns[1])
        except ValueError:  # Binary file.
            continue
    return additions, deletions


def changes() -> list[Change]:
    result: list[Change] = []
    for path, status in parse_status().items():
        change = Change(path=path, status=status)
        change.staged_add, change.staged_del = numstat(path, cached=True)
        change.work_add, change.work_del = numstat(path, cached=False)
        if status == "??":
            file_path = (ROOT / path).resolve()
            try:
                file_path.relative_to(ROOT)
                if file_path.is_file() and file_path.suffix.lower() in TEXT_SUFFIXES:
                    change.untracked_bytes = file_path.stat().st_size
                    with file_path.open("rb") as stream:
                        sample = stream.read(min(change.untracked_bytes, MAX_CHARS))
                    if b"\0" not in sample[:4096] and change.untracked_bytes <= MAX_CHARS:
                        change.untracked_lines = sample.count(b"\n") + bool(sample and not sample.endswith(b"\n"))
            except (OSError, ValueError):
                pass
        result.append(change)
    return sorted(result, key=lambda item: (-path_priority(item.path), -item.changed_lines, item.path.lower()))


def path_priority(path: str) -> int:
    candidate = Path(path)
    parts = {part.lower() for part in candidate.parts}
    suffix = candidate.suffix.lower()
    if any(part in {"vendor", "node_modules", "dist", "build", "generated"} for part in parts):
        return 0
    if candidate.name.lower().startswith(("readme", "changelog", "license")) or suffix in {".lock"}:
        return 1
    if any(part in {"test", "tests", "spec", "specs"} for part in parts) or candidate.name.lower().startswith(("test_", "spec_")):
        return 4
    if candidate.name.lower() in {"dockerfile", "makefile", "justfile"} or suffix in {".toml", ".yaml", ".yml", ".xml", ".ini", ".cfg", ".properties"}:
        return 3
    if suffix in TEXT_SUFFIXES and suffix not in {".md", ".txt"}:
        return 5
    if suffix in {".md", ".txt"}:
        return 2
    return 1


def command_diff_summary(args: argparse.Namespace) -> int:
    items = changes()
    total_lines = sum(item.staged_add + item.staged_del + item.work_add + item.work_del for item in items)
    print(f"Changed paths: {len(items)}; tracked added/deleted lines (estimate): {total_lines}")
    if not items:
        print("No staged, unstaged, or untracked source changes found.")
        return 0
    shown = items[: args.limit]
    for item in shown:
        details = []
        if item.staged_add or item.staged_del:
            details.append(f"staged +{item.staged_add}/-{item.staged_del}")
        if item.work_add or item.work_del:
            details.append(f"unstaged +{item.work_add}/-{item.work_del}")
        if item.status == "??":
            size = f"{item.untracked_bytes} bytes" if item.untracked_bytes else "source file"
            if item.untracked_lines:
                size += f", ~{item.untracked_lines} lines"
            details.append(f"untracked {size}")
        print(f"{item.status} {item.path} ({', '.join(details) or 'changed'})")
    if len(items) > len(shown):
        print(f"... {len(items) - len(shown)} more paths omitted")
    print("Select at most 3 relevant paths, then run diff-read with those paths.")
    return 0


def safe_truncate(text: str, remaining: int) -> tuple[str, int]:
    if remaining <= 0:
        return "", 0
    if len(text) <= remaining:
        return text, remaining - len(text)
    marker = "\n[truncated at the configured context limit]\n"
    if remaining < len(marker):
        return text[:remaining], 0
    room = remaining - len(marker)
    return text[:room] + marker, 0


def read_untracked(path: str, cap: int) -> str:
    target = (ROOT / path).resolve()
    target.relative_to(ROOT)
    if not target.is_file() or target.suffix.lower() not in TEXT_SUFFIXES:
        return f"[untracked file omitted: not a supported text source: {path}]\n"
    with target.open("rb") as stream:
        data = stream.read(cap)
    if b"\0" in data[:4096]:
        return f"[untracked binary file omitted: {path}]\n"
    text = data.decode("utf-8", "replace")
    if target.stat().st_size > len(data):
        text += "\n[untracked file excerpt truncated]\n"
    return text


def render_diff(paths: list[str], limit: int, status: dict[str, str]) -> str:
    output: list[str] = []
    remaining = limit
    for path in paths:
        if path not in status:
            raise RuntimeError(f"Path is not currently changed: {path}")
        if not clean_path(path):
            raise RuntimeError(f"Generated or learning-state path is excluded: {path}")
        header = f"\n===== {path} [{status[path]}] =====\n"
        header, remaining = safe_truncate(header, remaining)
        output.append(header)
        if remaining <= 0:
            break
        if status[path] == "??":
            try:
                body = read_untracked(path, remaining)
            except (OSError, ValueError) as exc:
                body = f"[could not read safely: {exc}]\n"
            body, remaining = safe_truncate(body, remaining)
            output.append(body)
            continue
        for label, cached in (("staged", True), ("unstaged", False)):
            cmd = ["diff", "--no-ext-diff", "--unified=3"]
            if cached:
                cmd.append("--cached")
            cmd.extend(["--", path])
            diff = run_git(cmd).decode("utf-8", "replace")
            if not diff:
                continue
            section = f"--- {label} ---\n{diff}"
            section, remaining = safe_truncate(section, remaining)
            output.append(section)
            if remaining <= 0:
                break
        if remaining <= 0:
            break
    return "".join(output)


def command_diff_read(args: argparse.Namespace) -> int:
    paths = list(dict.fromkeys(args.files))
    if not paths:
        raise RuntimeError("Pass one to three paths selected from diff-summary.")
    if len(paths) > MAX_FILES:
        raise RuntimeError(f"At most {MAX_FILES} paths may be read at once.")
    limit = min(max(args.max_chars, 1), MAX_CHARS)
    sys.stdout.write(render_diff(paths, limit, parse_status()))
    return 0


def choose_diff_sample(items: list[Change]) -> list[Change]:
    if not items:
        return []
    sources = [item for item in items if path_priority(item.path) >= 5]
    tests = [item for item in items if path_priority(item.path) == 4]
    configs = [item for item in items if path_priority(item.path) == 3]
    selected: list[Change] = []
    for pool in (sources, tests, configs):
        if pool and len(selected) < MAX_FILES:
            selected.append(pool[0])
    remaining = [item for item in items if item not in selected]
    remaining.sort(key=lambda item: (-path_priority(item.path), -item.changed_lines, item.path.lower()))
    for item in remaining:
        if len(selected) >= MAX_FILES:
            break
        selected.append(item)
    return selected


def command_diff_bundle(_: argparse.Namespace) -> int:
    items = changes()
    summary_lines = [
        f"Changed paths: {len(items)}; tracked added/deleted lines (estimate): "
        f"{sum(item.staged_add + item.staged_del + item.work_add + item.work_del for item in items)}"
    ]
    for item in items[:25]:
        detail = []
        if item.staged_add or item.staged_del:
            detail.append(f"staged +{item.staged_add}/-{item.staged_del}")
        if item.work_add or item.work_del:
            detail.append(f"unstaged +{item.work_add}/-{item.work_del}")
        if item.status == "??":
            size = f"{item.untracked_bytes} bytes" if item.untracked_bytes else "source file"
            if item.untracked_lines:
                size += f", ~{item.untracked_lines} lines"
            detail.append(f"untracked {size}")
        summary_lines.append(f"{item.status} {item.path} ({', '.join(detail) or 'changed'})")
    if len(items) > 25:
        summary_lines.append(f"... {len(items) - 25} more paths omitted from summary")
    if not items:
        sys.stdout.write("\n".join(summary_lines) + "\nNo staged, unstaged, or untracked source changes found.\n")
        return 0

    selected = choose_diff_sample(items)
    summary_lines.append(f"\nBounded sample: {len(selected)} of {len(items)} changed paths; maximum total output is {MAX_CHARS} characters.")
    summary = "\n".join(summary_lines) + "\nSelected paths: " + ", ".join(item.path for item in selected) + "\n"
    summary, _ = safe_truncate(summary, 2_500)
    remaining = max(0, MAX_CHARS - len(summary))
    sample = render_diff([item.path for item in selected], remaining, parse_status())
    sys.stdout.write(summary + sample)
    return 0


@dataclass
class NoteEntry:
    line: int
    section: str
    text: str
    active_gap: bool
    sort_date: str


DATE_PATTERN = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
ANSWER_PATTERN = re.compile(
    r"(?:\s*[|;—-]?\s*)(?:correct(?:ed)? answer|answer|答案|正确答案|修正答案)\s*[:：].*$",
    re.IGNORECASE,
)


def note_entries(lines: list[str]) -> list[NoteEntry]:
    section = ""
    starts: list[tuple[int, str, str, bool]] = []
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("## "):
            section = stripped[3:].strip().lower()
            continue
        if section not in {"gaps", "concepts"}:
            continue
        if not stripped.startswith(("- [ ]", "- [x]", "- [X]", "* [ ]", "* [x]", "* [X]")):
            continue
        status_open = "[ ]" in stripped[:6]
        if section == "gaps" and not status_open:
            continue
        if "stale" in stripped.lower() and not status_open:
            continue
        dates = DATE_PATTERN.findall(stripped)
        text = re.sub(r"^[-*]\s+\[[ xX]\]\s*", "", stripped)
        text = ANSWER_PATTERN.sub("", text)
        text = re.split(r"\s+(?:source|来源)\s*[:：]", text, maxsplit=1, flags=re.IGNORECASE)[0]
        text = re.sub(r"\s+last reviewed\s*[:：].*$", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s+最后复习\s*[:：].*$", "", text)
        text = " ".join(text.split())
        starts.append((number, section, text, status_open))

    found: list[NoteEntry] = []
    for index, (number, entry_section, text, status_open) in enumerate(starts):
        if entry_section == "gaps" and not status_open:
            continue
        start = number - 1
        end = len(lines)
        for next_number, _, _, _ in starts[index + 1 :]:
            end = next_number - 1
            break
        for cursor in range(start + 1, end):
            if lines[cursor].strip().startswith("## "):
                end = cursor
                break
        block = "\n".join(lines[start:end])
        review_match = re.search(r"(?:last reviewed|最后复习)\s*[:：]\s*(20\d{2}-\d{2}-\d{2}|never|从未)", block, re.IGNORECASE)
        dates = DATE_PATTERN.findall(lines[start])
        if entry_section == "gaps":
            sort_date = dates[0] if dates else "9999-99-99"
        elif review_match:
            reviewed = review_match.group(1)
            sort_date = "0000-00-00" if reviewed.lower() in {"never", "从未"} else reviewed
        else:
            sort_date = dates[-1] if dates else "9999-99-99"
        found.append(NoteEntry(number, entry_section, text, entry_section == "gaps", sort_date))
    # Open gaps first, oldest first; then the least recently reviewed concepts.
    found.sort(key=lambda item: (not item.active_gap, item.sort_date, item.line))
    return found


def command_review_index(args: argparse.Namespace) -> int:
    path = ROOT / ".learning" / "notes.md"
    if not path.is_file():
        print("No learning notes found at .learning/notes.md")
        return 0
    entries = note_entries(path.read_text(encoding="utf-8", errors="replace").splitlines())
    if not entries:
        print("No reviewable gap or concept entries found.")
        return 0
    limit = min(max(args.limit, 1), 12)
    for entry in entries[:limit]:
        kind = "gap" if entry.active_gap else "concept"
        preview = entry.text[:160]
        if len(entry.text) > 160:
            preview += "…"
        print(f"line {entry.line} | {kind} | {entry.sort_date} | {preview}")
    print("Read only the first candidate with review-entry; try the next only if its evidence is stale or unusable.")
    return 0


def command_review_entry(args: argparse.Namespace) -> int:
    path = ROOT / ".learning" / "notes.md"
    if not path.is_file():
        raise RuntimeError("No learning notes found at .learning/notes.md")
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    entries = note_entries(lines)
    selected = next((entry for entry in entries if entry.line == args.line), None)
    if selected is None:
        raise RuntimeError(f"Line {args.line} is not a reviewable gap or concept entry.")
    start = selected.line - 1
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index].strip()
        if line.startswith("## ") or re.match(r"^[-*]\s+\[[ xX]\]", line):
            end = index
            break
    block = "\n".join(lines[start:end]).strip()
    if len(block) > MAX_ENTRY_CHARS:
        block = block[:MAX_ENTRY_CHARS] + "\n[entry truncated at 4 KB]"
    print(f"Selected {selected.section} entry at line {selected.line}:\n{block}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    summary = commands.add_parser("diff-summary", help="list changed paths and bounded size metadata")
    summary.add_argument("--limit", type=int, default=50)
    summary.set_defaults(func=command_diff_summary)
    bundle = commands.add_parser("diff-bundle", help="summarize changes and return an automatically sampled bounded diff")
    bundle.set_defaults(func=command_diff_bundle)
    read = commands.add_parser("diff-read", help="read selected diff paths within hard limits")
    read.add_argument("--file", dest="files", action="append", default=[])
    read.add_argument("--max-chars", type=int, default=MAX_CHARS)
    read.set_defaults(func=command_diff_read)
    index = commands.add_parser("review-index", help="list bounded note candidates without answers")
    index.add_argument("--limit", type=int, default=8)
    index.set_defaults(func=command_review_index)
    entry = commands.add_parser("review-entry", help="read one selected note entry")
    entry.add_argument("--line", type=int, required=True)
    entry.set_defaults(func=command_review_entry)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.func(args)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"context helper: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
