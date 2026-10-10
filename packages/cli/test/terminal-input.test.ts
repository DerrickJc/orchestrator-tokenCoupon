import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalInput, InputCancelled, displayWidth } from "../src/terminal-input.js";
import { commandCandidates, formatChatHelp, CHAT_COMMANDS } from "../src/chat-commands.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.unstubAllEnvs(); });
function fixture(columns = 80) {
  const input = new PassThrough() as PassThrough & { isRaw: boolean; setRawMode: (raw: boolean) => void };
  input.isRaw = false; input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = Object.assign(new PassThrough(), { columns }); const logs: string[] = []; output.on("data", (b: Buffer) => logs.push(b.toString()));
  const cancel = vi.fn();
  const terminal = new TerminalInput(input, output, { onCancel: cancel });
  cleanups.push(() => { terminal.close(); input.destroy(); output.destroy(); });
  return { input, output, terminal, cancel, logs };
}
test("split paste boundaries and UTF-8 preserve the complete request and need explicit Enter", async () => {
  const { terminal, input } = fixture();
  let submitted = false;
  const pending = terminal.message("用户 › ").then((v) => { submitted = true; return v; });
  input.write("\x1b"); input.write("[20"); input.write("0~");
  const text = Buffer.from("使用 Node.js\r\n\r\n三个任务：\n1. 实现\n2. 测试\n3. 验证\n");
  for (const byte of text) input.write(Buffer.from([byte]));
  input.write("\x1b[20"); input.write("1~");
  await Promise.resolve(); expect(submitted).toBe(false);
  input.write("\r");
  expect(await pending).toBe("使用 Node.js\n\n三个任务：\n1. 实现\n2. 测试\n3. 验证\n");
  expect(terminal.lastLiteral).toBe(true);
});
test("multi-line paste stays literal", async () => {
  const { terminal, input, cancel } = fixture();
  const p = terminal.message("request> "); input.write("\x1b[200~/approve\n/run\x1b[201~\r");
  expect(await p).toBe("/approve\n/run"); expect(cancel).not.toHaveBeenCalled(); expect(terminal.lastLiteral).toBe(true);
});
test.each(["/help", "/quit", "/approve", "/run --isolation git-worktree --verification-task final-verify --max-parallel 2", "/status\r\n"])("single-line pasted command %s needs Enter and uses command routing", async (command) => {
  const { terminal, input } = fixture(); terminal.initial = false;
  let submitted = false;
  const p = terminal.message("planner> ").then((value) => { submitted = true; return value; });
  input.write("\x1b[200~" + command + "\x1b[201~");
  await Promise.resolve(); expect(submitted).toBe(false);
  input.write("\r"); expect((await p)!.trim()).toBe(command.trim()); expect(terminal.lastLiteral).toBe(false);
});
test("single-line slash content in explicit multiline mode remains literal", async () => {
  const { terminal, input } = fixture();
  const p = terminal.message("planner> ");
  input.write("/input\r\x1b[200~/run\x1b[201~\r/send\r");
  expect(await p).toBe("/run"); expect(terminal.lastLiteral).toBe(true);
});
test("history arrows preserve drafts, allow editing and do not conflict with command hints", async () => {
  const { terminal, input } = fixture(); terminal.initial = false;
  for (const text of ["/status", "/plan"]) { const p = terminal.message("planner> "); input.write(text + "\r"); await p; }
  let submitted = false;
  const p = terminal.message("planner> ").then((value) => { submitted = true; return value; });
  input.write("scratch\x1b[A\x1b[A\x1b[A\x1b[B\x1b[B");
  await Promise.resolve(); expect(submitted).toBe(false);
  input.write("\r"); expect(await p).toBe("scratch");
  const next = terminal.message("planner> ");
  input.write("/r\x1b[A\x1b[A\x1b[A --task implement\r");
  expect(await next).toBe("/status --task implement"); expect(terminal.lastLiteral).toBe(false);
});
test("history excludes approvals and cancelled input and preserves multiline provenance", async () => {
  const { terminal, input } = fixture();
  const request = terminal.message("request> "); input.write("\x1b[200~/approve\n/run\x1b[201~\r"); await request;
  const approval = terminal.ask("[y/N] "); input.write("y\r"); await approval;
  const custom = terminal.text("修订说明："); input.write("private\x1b"); await expect(custom).rejects.toBeInstanceOf(InputCancelled);
  const recall = terminal.message("planner> "); input.write("\x1b[A\r");
  expect(await recall).toBe("/approve\n/run"); expect(terminal.lastLiteral).toBe(true);
});
test("history restores a Unicode draft cursor and retains at most 100 entries", async () => {
  const { terminal, input } = fixture();
  for (let i = 0; i < 102; i++) { const p = terminal.message("> "); input.write(`entry-${i}\r`); await p; }
  const oldest = terminal.message("> "); input.write("\x1b[A".repeat(105) + "\r"); expect(await oldest).toBe("entry-2");
  const restore = terminal.message("> "); input.write("你好😀\x1b[D\x1b[A\x1b[B!\r"); expect(await restore).toBe("你好!😀");
});
test("explicit multiline handles embedded control words and manual submission", async () => {
  const { terminal, input } = fixture();
  const p = terminal.message("request> ");
  input.write("/input\r内容\r\\/send\r\x1b[200~/send\x1b[201~\r/send\r");
  expect(await p).toBe("内容\n/send\n/send");
});
test("menu default, digits and arrows never submit until Enter; cancellation restores ownership", async () => {
  const { terminal, input } = fixture();
  let done = false;
  const p = terminal.choose("Approve", [{ id: "allow-once", label: "允许" }, { id: "deny", label: "拒绝" }]).then((v) => { done = true; return v; });
  input.write("2"); await Promise.resolve(); expect(done).toBe(false);
  input.write("\r"); expect(await p).toBe("deny");
  const cancelled = terminal.choose("Another", [{ id: "x", label: "X" }]);
  input.write("\x1b"); await expect(cancelled).rejects.toBeInstanceOf(InputCancelled);
  const next = terminal.message("request> "); input.write("next\r"); expect(await next).toBe("next");
  terminal.close(); expect(input.isRaw).toBe(false);
});
test("/st suggests /status, Enter does not silently accept it; Tab preserves arguments", async () => {
  const { terminal, input, logs } = fixture(); terminal.initial = false;
  const p = terminal.message("planner> "); input.write("/st\r"); expect(await p).toBe("/st");
  expect(logs.join("")).toContain("/status");
  const next = terminal.message("planner> "); input.write("/st\t\r"); expect(await next).toBe("/status");
  expect(commandCandidates("/st", true)).toEqual([]);
});
test("missing paste end, EOF and No Color never send incomplete text or leak styles", async () => {
  vi.stubEnv("NO_COLOR", "1");
  const { terminal, input, logs } = fixture();
  const p = terminal.message("request> "); input.write("\x1b[200~未完成\n"); input.end(); expect(await p).toBe(null);
  expect(logs.join("")).not.toMatch(/\x1b\[[0-9;]*m/);
});
test("help covers every registered command, with functions and examples, and initial scope", () => {
  const full = formatChatHelp();
  for (const c of CHAT_COMMANDS) { expect(full).toContain(c.usage); expect(full).toContain(`功能：${c.description}`); expect(full).toContain(`示例：${c.example}`); }
  expect(formatChatHelp(true)).toContain("/input"); expect(formatChatHelp(true)).not.toContain("/approve");
});
test("unsupported renderer is readable without ANSI and typed editing preserves Unicode", async () => {
  vi.stubEnv("TERM", "dumb");
  const { terminal, input, logs } = fixture();
  const p = terminal.message("用户 › "); input.write("你好😀\x1b[D\x7f!\r");
  expect(await p).toBe("你!😀"); expect(logs.join("")).not.toContain("\x1b[");
  const menu = terminal.choose("审批", [{ id: "yes", label: "允许" }, { id: "no", label: "拒绝" }]);
  input.write("2\r"); expect(await menu).toBe("no");
});
test("pending input is exclusive, paste over the limit is not silently truncated, and abort releases ownership", async () => {
  const { terminal, input } = fixture(); const controller = new AbortController();
  const menu = terminal.choose("Choose", [{ id: "a", label: "A" }], controller.signal);
  await expect(terminal.message("request> ")).rejects.toThrow("占用");
  controller.abort(); await expect(menu).rejects.toThrow();
  const next = terminal.message("request> "); let resolved = false; void next.then(() => { resolved = true; });
  input.write("\x1b[200~" + "界".repeat(3000) + "\x1b[201~\r");
  await Promise.resolve(); expect(resolved).toBe(false);
  input.write("\x03"); expect(await next).toBe(null); expect(input.isRaw).toBe(false);
});

test.each(["", "unfinished", "/input\runfinished"])("Ctrl-C exits message input (%s) without submitting", async (text) => {
  const { terminal, input, cancel } = fixture();
  const p = terminal.message("request> "); input.write(text + "\x03more\r");
  expect(await p).toBe(null); expect(cancel).toHaveBeenCalledTimes(1); expect(input.isRaw).toBe(false);
  expect(await terminal.message("request> ")).toBe(null);
});
test("Ctrl-C closes a menu and active follow interrupt; Esc alone cancels local input", async () => {
  const { terminal, input, cancel } = fixture(); const interrupt = vi.fn();
  const p = terminal.choose("Review", [{ id: "x", label: "Fix" }]);
  const action = terminal.withInterrupt(interrupt, async () => { input.write("\x03"); return await p; });
  expect(await action).toBe(null); expect(interrupt).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  expect(input.isRaw).toBe(false);
});

// Emulate delayed right-margin wrapping and LF without implicit carriage return.
// This exercises actual escape output, not the renderer's coordinate helper.
function cursorOf(output: string, columns: number): { row: number; column: number } {
  let row = 0, column = 0, wrap = false;
  for (const token of output.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\r|\n)/)) {
    if (token === "\r") { column = 0; wrap = false; }
    else if (token === "\n") { row++; wrap = false; }
    else if (token.startsWith("\x1b[")) {
      const match = /^\x1b\[(\d*)([ABCD])$/.exec(token);
      if (match) { const n = Number(match[1] || 1); wrap = false;
        if (match[2] === "A") row = Math.max(0, row - n);
        if (match[2] === "B") row += n;
        if (match[2] === "C") column = Math.min(columns - 1, column + n);
        if (match[2] === "D") column = Math.max(0, column - n);
      }
    } else for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)) {
      const width = displayWidth(segment); if (!width) continue;
      if (wrap || column + width > columns) { row++; column = 0; }
      column += width; wrap = column === columns;
      if (wrap) column = columns - 1;
    }
  }
  return { row, column };
}
test.each([
  [40, "/help", 0, 14],
  [16, "/status", 1, 0],
  [16, "/status\x1b[D\x1b[D", 0, 14],
  [12, "/help", 1, 2],
  [20, "/run --max-parallel 2", 1, 10],
  [16, "你好，😀e\u0301", 1, 3],
])("rendered cursor stays at the input for %s columns and %s", (columns, text, row, column) => {
  const { terminal, input, logs } = fixture(columns as number); terminal.initial = false;
  void terminal.message("planner> "); input.write(text as string);
  expect(cursorOf(logs.join(""), columns as number)).toEqual({ row, column });
  expect(logs.join("")).not.toMatch(/(?<!\r)\n/);
});
test("width includes fullwidth punctuation, combining marks and whole emoji graphemes", () => {
  expect(displayWidth("你好，。Ａ")).toBe(10);
  expect(displayWidth("e\u0301👨‍👩‍👧‍👦🇨🇳👍🏽")).toBe(7);
  expect(displayWidth("\x1b[32m✓ 已完成\x1b[0m")).toBe(8);
});
test("left, right and deletion edit complete graphemes instead of half an emoji", async () => {
  const { terminal, input } = fixture(); const p = terminal.message("request> ");
  input.write("Ae\u0301👨‍👩‍👧‍👦B\x1b[D\x1b[D\x7f!\x1b[C\x1b[3~\r");
  expect(await p).toBe("A!👨‍👩‍👧‍👦");
});
