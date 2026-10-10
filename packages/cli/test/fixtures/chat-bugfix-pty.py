"""Drive the real chat process through paste, review choices and execution."""
import json, os, pty, re, select, signal, sys, termios, time
from pathlib import Path

def drive(node, cli, workspace, planning_id):
    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['NO_COLOR'] = '1'
        os.execv(node, [node, cli, 'planner', 'chat', '--id', planning_id, '--workspace', workspace])
    transcript = bytearray(); position = 0; exited = False
    def paste(command):
        # Clipboard bytes never submit; the final Enter is a separate user key.
        os.write(master, b'\x1b[200~' + command.encode() + b'\x1b[201~')
        os.write(master, b'\r')
    def wait(marker, prompt=False):
        nonlocal position
        end = time.monotonic() + 12
        while time.monotonic() < end:
            visible = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', transcript).rstrip(b'\r')
            found = transcript.find(marker, position)
            if found >= 0 and (not prompt or visible.endswith(marker)):
                position = len(transcript) if prompt else found + len(marker); return
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try: transcript.extend(os.read(master, 65536))
                except OSError: break
        raise AssertionError('Timeout: ' + repr(marker))
    try:
        wait(b'planner> ', True)
        paste('/review')
        wait('选择修订方式'.encode()); wait('Ctrl-C 退出会话'.encode())
        os.write(master, b'1\r')
        wait('自定义修订说明'.encode()); wait('Ctrl-C 退出会话'.encode())
        os.write(master, b'2\r')
        wait('修订说明：'.encode())
        os.write(master, '补充正常和空姓名 HTTP 测试\r'.encode())
        wait('暂不处理，保留该问题'.encode()); wait('Ctrl-C 退出会话'.encode())
        os.write(master, b'3\r')
        wait('复审完成'.encode()); wait(b'planner> ', True)
        paste('/approve'); wait(b'[y/N] ')
        os.write(master, b'y\r'); wait(b'planner> ', True)
        paste('/run'); wait('执行状态：[✓ 已完成] succeeded'.encode()); wait(b'planner> ', True)
        paste('/logs'); wait(b'planner> ', True)
        paste('/status'); wait('执行状态：[✓ 已完成] succeeded'.encode()); wait(b'planner> ', True)
        # A command prefix with hints still gives Up to input history, not hints.
        os.write(master, b'/st\x1b[A\r'); wait(b'planner> ', True)
        paste('/logs --follow'); wait('跟随中'.encode())
        os.write(master, b'\x03')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done: exited=True; assert os.waitstatus_to_exitcode(status)==130; break
            ready, _, _ = select.select([master], [], [], .05)
            if ready:
                try: transcript.extend(os.read(master,65536))
                except OSError: pass
        assert exited, 'Chat did not exit'
        Path(workspace, 'chat-transcript.txt').write_bytes(transcript)
        assert '[会话已退出]' in transcript.decode(errors='replace')
        print(json.dumps({'exitCode':130,'noColor':not bool(re.search(rb'\x1b\[[0-9;]*m',transcript)), 'reviewBatch':True,'ctrlCExitedFromFollow':True,'pastedCommands':True,'historyRecall':True,'completionBanner':True}))
    except Exception:
        sys.stderr.write(transcript.decode(errors='replace')); raise
    finally:
        if not exited:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            os.waitpid(pid,0)
        os.close(master)

if __name__ == '__main__': drive(*sys.argv[1:])
