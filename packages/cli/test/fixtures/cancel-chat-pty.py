"""Run real CLI children and interrupt input, review and native Runner waits."""
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
from pathlib import Path

node, cli, workspace, planning_id, mode = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    args = [node, cli, 'planner', 'chat', '--workspace', workspace]
    args += ['--planner', 'mock', '--runner', 'mock'] if planning_id == '-' else ['--id', planning_id]
    os.execv(node, args)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 40, 0, 0))
transcript = bytearray(); position = 0; exited = False
def wait(marker):
    global position
    end = time.monotonic() + 12
    while time.monotonic() < end:
        found = transcript.find(marker, position)
        if found >= 0:
            position = found + len(marker); return
        ready, _, _ = select.select([master], [], [], .05)
        if ready:
            try: transcript.extend(os.read(master, 65536))
            except OSError: break
    raise AssertionError('Timeout: ' + repr(marker))
try:
    wait(b'request> ' if planning_id == '-' else b'planner> ')
    if mode == 'prompt': os.write(master, '尚未提交的需求'.encode())
    elif mode == 'review':
        os.write(master, b'/review\r'); wait('Ctrl-C 退出会话'.encode())
    else:
        os.write(master, b'/run\r'); wait('输入选项编号/ID：'.encode())
        if mode == 'approval':
            os.write(master, b'1\r'); wait('请选择本次工具调用的处理方式'.encode()); wait('Ctrl-C 退出会话'.encode())
    os.write(master, b'\x03')
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exited = True; assert os.waitstatus_to_exitcode(status) == 130; break
        ready, _, _ = select.select([master], [], [], .05)
        if ready:
            try: transcript.extend(os.read(master, 65536))
            except OSError: pass
    assert exited, 'Ctrl-C did not exit the CLI'
    while select.select([master], [], [], .02)[0]:
        try: transcript.extend(os.read(master, 65536))
        except OSError: break
    assert '[会话已退出]' in transcript.decode(errors='replace')
    attrs = termios.tcgetattr(master)
    assert attrs[3] & termios.ICANON and attrs[3] & termios.ECHO, 'Raw terminal mode leaked'
    Path(workspace, 'cancel-transcript.txt').write_bytes(transcript)
    print(json.dumps({'mode': mode, 'exitCode': 130, 'terminalRestored': True}))
except Exception:
    sys.stderr.write(transcript.decode(errors='replace')); raise
finally:
    if not exited:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(master)
