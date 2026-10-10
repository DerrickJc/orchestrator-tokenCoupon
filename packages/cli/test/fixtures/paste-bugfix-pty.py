"""Verify a real PTY does not submit partial multiline requirements."""
import json, os, pty, re, select, signal, sys, time
from pathlib import Path
node, cli, workspace = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.environ['TERM']='xterm-256color'
    os.execv(node,[node,cli,'planner','chat','--planner','mock','--runner','mock','--workspace',workspace])
transcript=bytearray(); exited=False
request='使用 Node.js 和 .mjs 文件，不安装第三方依赖。\n\n计划只包含三个任务：\n1. 实现问候接口\n2. HTTP 回归测试\n3. 最终验证'
def wait(marker):
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        plain=re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]',b'',transcript).rstrip(b'\r')
        if plain.endswith(marker):return
        ready,_,_=select.select([master],[],[],.1)
        if ready:transcript.extend(os.read(master,65536))
    raise AssertionError(repr(marker))
try:
    wait(b'request> ')
    os.write(master,b'/help\r'); transcript.clear();wait(b'request> ')
    os.write(master,b'\x1b');os.write(master,b'[200~'+request.encode()+b'\x1b[201~')
    time.sleep(.15)
    assert not Path(workspace,'.token-coupon','planners').exists(),'Paste submitted before Enter'
    os.write(master,b'\r');transcript.clear();wait(b'planner> ')
    snapshots=list(Path(workspace,'.token-coupon','planners').glob('*/conversation.json'))
    snapshot=json.loads(snapshots[0].read_text())
    assert [m['content'] for m in snapshot['messages'] if m['role']=='user']==[request]
    os.write(master,b'/exit\r')
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        done,status=os.waitpid(pid,os.WNOHANG)
        if done:exited=True;assert os.waitstatus_to_exitcode(status)==0;break
        ready,_,_=select.select([master],[],[],.05)
        if ready:
            try:transcript.extend(os.read(master,65536))
            except OSError:pass
    assert exited
    Path(workspace,'paste-transcript.txt').write_bytes(transcript)
    print(json.dumps({'completeMessage':True,'noEarlyApi':True,'preservedBlankLines':True,'exitCode':0}))
finally:
    if not exited:
        try:os.kill(pid,signal.SIGKILL)
        except ProcessLookupError:pass
        os.waitpid(pid,0)
    os.close(master)
