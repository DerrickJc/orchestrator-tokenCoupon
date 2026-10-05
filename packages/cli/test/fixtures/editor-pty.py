"""Exercise the CLI/editor handoff on a POSIX pseudo-terminal (no model calls)."""

import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import termios
import time
import tty

MOUSE_INPUT = b"\x1b[<32;57;30M\x1b[<0;71;30m"


def editor(mode, plan_path):
    original = termios.tcgetattr(0)
    record = {
        "canonicalAtEntry": bool(original[3] & termios.ICANON),
        "echoAtEntry": bool(original[3] & termios.ECHO),
    }
    captured = bytearray()
    try:
        tty.setraw(0)
        os.write(1, b"\x1b[?1002h\x1b[?1006hEDITOR_READY\r\n")
        deadline = time.monotonic() + 3
        while b"Q" not in captured and time.monotonic() < deadline:
            ready, _, _ = select.select([0], [], [], max(0, deadline - time.monotonic()))
            if ready:
                captured.extend(os.read(0, 4096))
        record["mouseInputIntact"] = bytes(captured) == MOUSE_INPUT + b"Q"
        Path(plan_path).parents[5].joinpath("editor-tty.json").write_text(json.dumps(record))
        if mode == "save":
            plan = json.loads(Path(plan_path).read_text())
            plan["title"] = "Edited with exclusive terminal input"
            Path(plan_path).write_text(json.dumps(plan))
    finally:
        os.write(1, b"\x1b[?1002l\x1b[?1006lEDITOR_DONE\r\n")
        termios.tcsetattr(0, termios.TCSANOW, original)
    sys.exit(7 if mode == "fail" else 0)


def drive(node, cli, workspace, planning_id, mode):
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("VISUAL", None)
        os.environ["EDITOR"] = (
            "/nonexistent/token-coupon-editor"
            if mode == "missing"
            else f'"{sys.executable}" "{Path(__file__).resolve()}" --editor {mode}'
        )
        os.execv(node, [node, cli, "planner", "chat", "--id", planning_id, "--workspace", workspace])

    transcript = bytearray()
    position = 0
    exited = False

    def wait_for(marker):
        nonlocal position
        deadline = time.monotonic() + 8
        while True:
            found = transcript.find(marker, position)
            if found != -1:
                position = found + len(marker)
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"Timeout waiting for {marker!r}")
            ready, _, _ = select.select([master], [], [], remaining)
            if ready:
                chunk = os.read(master, 65536)
                if not chunk:
                    raise AssertionError("CLI terminal closed unexpectedly")
                transcript.extend(chunk)

    try:
        wait_for(b"planner> ")
        os.write(master, b"/edit\n")
        if mode != "missing":
            wait_for(b"EDITOR_READY")
            os.write(master, MOUSE_INPUT + b"Q")
            wait_for(b"EDITOR_DONE")
        wait_for(b"planner> ")
        state = termios.tcgetattr(master)
        chat_raw_restored = not bool(state[3] & (termios.ICANON | termios.ECHO))
        os.write(master, b"/plan\n")
        wait_for(b"planner> ")
        os.write(master, b"/exit\n")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                exited = True
                exit_code = os.waitstatus_to_exitcode(status)
                break
            # Drain terminal output so the child cannot block on its final writes.
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    transcript.extend(os.read(master, 65536))
                except OSError:
                    pass
        if not exited:
            raise AssertionError("CLI did not accept /exit after returning from the editor")
        result = {"chatRawRestored": chat_raw_restored, "exitCode": exit_code}
        if mode != "missing":
            result.update(json.loads(Path(workspace, "editor-tty.json").read_text()))
        result["continuedChat"] = "未知命令" not in transcript.decode(errors="replace")
        print(json.dumps(result))
    except Exception:
        sys.stderr.write(transcript.decode(errors="replace"))
        raise
    finally:
        if not exited:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(master)


if sys.argv[1] == "--editor":
    editor(sys.argv[2], sys.argv[3])
else:
    drive(*sys.argv[1:])
