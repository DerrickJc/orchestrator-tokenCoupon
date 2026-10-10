import { StringDecoder } from "node:string_decoder";
import { commandCandidates, CHAT_COMMANDS } from "./chat-commands.js";

export class InputCancelled extends Error { constructor() { super("输入已取消"); } }
type TerminalStream = NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
interface Choice { id: string; label: string; disabled?: boolean; }
interface HistoryEntry { text: string; literal: boolean; }
type HistoryDraft = Pick<Pending, "text" | "cursor" | "literal" | "rowPasted">;
interface Pending {
  prompt: string; text: string; cursor: number; mode: "message" | "text" | "choice"; literal: boolean; explicit: boolean; rowPasted: boolean;
  choices?: Choice[]; selected: number; candidate: number; hidden: boolean; localCancel: boolean;
  resolve: (value: string | null) => void; reject: (e: unknown) => void; cleanup: () => void;
}
/** One stdin owner for editing, menus, cancellation and external editor handoff. */
export class TerminalInput {
  private readonly decoder = new StringDecoder("utf8");
  private pending: Pending | undefined;
  private incoming = "";
  private paste = false;
  private pasteCR = false;
  private rendered = 0;
  private plainView = "";
  private oldRaw: boolean;
  private suspended = false;
  private closed = false;
  private interrupt: (() => void) | undefined;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private readonly history: HistoryEntry[] = [];
  private historyIndex = 0;
  private historyDraft: HistoryDraft | undefined;
  lastLiteral = false;
  initial = true;
  readonly ansi: boolean;
  readonly color: boolean;
  constructor(private readonly input: TerminalStream, private readonly output: NodeJS.WritableStream, private readonly options: { onCancel?: () => void; onClose?: () => void } = {}) {
    this.oldRaw = Boolean(input.isRaw);
    this.ansi = typeof input.setRawMode === "function" && process.env.TERM !== "dumb";
    this.color = this.ansi && process.env.NO_COLOR === undefined;
    input.setRawMode?.(true);
    if (this.ansi) output.write("\x1b[?2004h");
    input.on("data", this.onData); input.once("end", this.onEnd); input.resume();
  }
  private onEnd = () => { this.close(); this.options.onClose?.(); };
  private onData = (data: Buffer | string) => {
    if (this.suspended || this.closed) return;
    clearTimeout(this.escapeTimer);
    this.incoming += typeof data === "string" ? data : this.decoder.write(data);
    this.consume();
  };
  private consume(): void {
    while (this.incoming) {
      if (this.incoming.startsWith("\x1b")) {
        const sequences = ["\x1b[200~", "\x1b[201~", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[H", "\x1b[F", "\x1b[3~", "\x1b\r", "\x1b\n"];
        const token = sequences.find((s) => this.incoming.startsWith(s));
        if (token) { this.incoming = this.incoming.slice(token.length); this.key(token); continue; }
        if (sequences.some((s) => s.startsWith(this.incoming)) && this.incoming.length > 1) return;
        // An isolated Escape is allowed to dismiss hints; partial CSI sequences are retained.
        if (this.incoming === "\x1b") { this.escapeTimer = setTimeout(() => { if (this.incoming === "\x1b") { this.incoming = ""; this.key("escape"); } }, 40); return; }
        const mouse = /^\x1b\[<?[0-9;]+[mM]/.exec(this.incoming);
        if (mouse) { this.incoming = this.incoming.slice(mouse[0].length); continue; }
        if (/^\x1b\[(?:<|[0-9;])*$/.test(this.incoming)) return;
        this.incoming = this.incoming.slice(1); continue;
      }
      const char = String.fromCodePoint(this.incoming.codePointAt(0)!);
      this.incoming = this.incoming.slice(char.length);
      this.key(char);
    }
  }
  private key(key: string): void {
    const p = this.pending;
    if (key === "\x03") {
      this.paste = false; this.pasteCR = false; this.incoming = "";
      this.options.onCancel?.(); this.interrupt?.(); this.close(); return;
    }
    if (!p) return; // No type-ahead becomes a later approval or new request.
    if (key === "\x1b[200~") { this.paste = true; this.pasteCR = false; return; }
    if (key === "\x1b[201~") { this.paste = false; this.pasteCR = false; if (p.mode === "message" && p.text.trim().includes("\n")) p.literal = true; this.render(); return; }
    if (this.paste) {
      if (p.mode === "choice") return;
      if (key === "\r") { this.insert("\n"); p.rowPasted = false; this.pasteCR = true; }
      else if (key === "\n" && this.pasteCR) this.pasteCR = false;
      else { this.pasteCR = false; if (!key.startsWith("\x1b")) { this.insert(key); p.rowPasted = key !== "\n"; } }
      return;
    }
    if (key === "escape") { if (p.localCancel) { this.finish(undefined, new InputCancelled()); return; } p.hidden = true; this.render(); return; }
    if (p.mode === "choice") {
      if (key === "\x1b[A") p.selected = (p.selected + p.choices!.length - 1) % p.choices!.length;
      else if (key === "\x1b[B") p.selected = (p.selected + 1) % p.choices!.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= p.choices!.length) p.selected = Number(key) - 1;
      else if (key === "\r" || key === "\n") { const choice = p.choices![p.selected]!; if (!choice.disabled) this.finish(choice.id); return; }
      this.render(); return;
    }
    const candidates = !p.literal && p.mode === "message" ? commandCandidates(p.text.split(/\s/)[0] ?? "", this.initial) : [];
    if (key === "\t" && candidates.length && p.cursor <= (p.text.split(/\s/)[0]?.length ?? 0)) {
      this.resetHistoryNavigation();
      const word = p.text.split(/\s/)[0]!; const name = "/" + candidates[p.candidate % candidates.length]!.name;
      p.text = name + p.text.slice(word.length); p.cursor = name.length; p.hidden = false; this.render(); return;
    }
    if ((key === "\x1b[A" || key === "\x1b[B") && p.mode === "message" && !p.explicit) { this.recallHistory(key === "\x1b[A" ? -1 : 1); return; }
    if (key === "\x1b[D") p.cursor -= graphemes(p.text.slice(0, p.cursor)).at(-1)?.length ?? 0;
    else if (key === "\x1b[C") p.cursor += graphemes(p.text.slice(p.cursor))[0]?.length ?? 0;
    else if (key === "\x1b[H") p.cursor = 0;
    else if (key === "\x1b[F") p.cursor = p.text.length;
    else if (key === "\x7f" || key === "\b") { if (p.cursor) { this.resetHistoryNavigation(); const n = graphemes(p.text.slice(0, p.cursor)).at(-1)!.length; p.text = p.text.slice(0, p.cursor - n) + p.text.slice(p.cursor); p.cursor -= n; } }
    else if (key === "\x1b[3~") { this.resetHistoryNavigation(); const n = graphemes(p.text.slice(p.cursor))[0]?.length ?? 0; p.text = p.text.slice(0, p.cursor) + p.text.slice(p.cursor + n); }
    else if (key === "\x1b\r" || key === "\x1b\n") { p.literal = true; this.insert("\n"); }
    else if (key === "\r" || key === "\n") {
      if (p.mode === "message" && p.explicit) {
        const row = p.text.slice(p.text.lastIndexOf("\n") + 1);
        if (row === "/cancel" && !p.rowPasted) { p.text = ""; p.cursor = 0; p.explicit = false; p.literal = false; this.render(); return; }
        if (row === "/send" && !p.rowPasted) { const value = p.text.slice(0, p.text.length - row.length).replace(/\n$/, "").replace(/^\\\/(send|cancel)$/gm, "/$1"); if (Buffer.byteLength(value) > 8192) { this.write("输入超过 8 KiB，请删减后提交。\n"); return; } this.finish(value); return; }
        this.insert("\n"); p.rowPasted = false; this.render(); return;
      }
      if (p.mode === "message" && p.text === "/input" && !p.literal) { p.text = ""; p.cursor = 0; p.explicit = true; p.literal = true; this.write("多行输入：/send 提交，/cancel 放弃。\n"); this.render(); return; }
      if (Buffer.byteLength(p.text, "utf8") > 8192 && p.mode === "message") { this.write("输入超过 8 KiB，请删减后提交。\n"); return; }
      this.finish(p.text); return;
    } else if (key >= " " && !key.startsWith("\x1b")) this.insert(key);
    p.hidden = false; this.render();
  }
  private resetHistoryNavigation(): void { this.historyIndex = this.history.length; this.historyDraft = undefined; }
  private recallHistory(direction: -1 | 1): void {
    const p = this.pending!;
    const next = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    if (next === this.historyIndex) return;
    if (this.historyIndex === this.history.length) this.historyDraft = { text: p.text, cursor: p.cursor, literal: p.literal, rowPasted: p.rowPasted };
    this.historyIndex = next;
    if (next === this.history.length) Object.assign(p, this.historyDraft!);
    else { const entry = this.history[next]!; p.text = entry.text; p.cursor = entry.text.length; p.literal = entry.literal; p.rowPasted = false; }
    p.candidate = 0; p.hidden = false; this.render();
  }
  private insert(value: string): void { this.resetHistoryNavigation(); const p = this.pending!; p.text = p.text.slice(0, p.cursor) + value + p.text.slice(p.cursor); p.cursor += value.length; }
  private emit(text: string): void { this.output.write(this.ansi ? text.replace(/\r?\n/g, "\r\n") : text); }
  private clear(): void { if (this.ansi && this.rendered) { this.output.write("\r" + (this.rendered > 1 ? `\x1b[${this.rendered - 1}A` : "") + "\x1b[J"); } this.rendered = 0; }
  private render(): void {
    const p = this.pending; if (!p) return;
    this.clear();
    const text = `${p.prompt}${p.text}`;
    const columns = Math.max(2, (this.output as NodeJS.WritableStream & { columns?: number }).columns || 80);
    // Reserve a continuation row at an exact right margin, before any hints.
    const inputPadding = terminalPosition(text, columns).column === columns ? "\n" : "";
    const lines = p.mode === "choice" ? [p.prompt, ...p.choices!.map((c, i) => `${i === p.selected ? "❯" : " "} ${i + 1}. ${c.label}${c.disabled ? "（不可用）" : ""}`), `↑/↓ 选择，Enter 确认；${p.localCancel ? "Esc 返回；" : ""}Ctrl-C 退出会话`] : [text + inputPadding];
    if (p.mode === "message" && !p.literal && !p.hidden) {
      const word = p.text.split(/\s/)[0]!;
      const candidates = commandCandidates(word, this.initial);
      if (candidates.length) lines.push(...candidates.map((c, i) => `  ${i === p.candidate ? "❯" : " "} /${c.name}  ${c.description}`), "  Tab 补全，↑/↓ 回看历史，Enter 提交当前输入，Esc 关闭提示");
      else if (/^\/[a-z-]+$/.test(word)) lines.push("  未知或当前阶段不可用的命令；输入 /help 查看。");
      const known = CHAT_COMMANDS.find((c) => "/" + c.name === word);
      if (known && word === p.text) lines.push(`  用法：${known.usage}`);
    }
    if (!this.ansi) {
      const view = p.mode === "choice" ? lines.join("\n") : text;
      if (view === this.plainView) return;
      const previous = this.plainView;
      this.plainView = view;
      if (p.mode === "choice") this.output.write(view + "\n");
      else if (view.startsWith(previous)) this.output.write(view.slice(previous.length));
      else this.output.write("\r" + view + " ".repeat(Math.max(0, displayWidth(previous) - displayWidth(view))) + "\r" + view);
      return;
    }
    const rendered = lines.join("\n");
    const word = p.text.split(/\s/)[0]!;
    const knownCommand = p.mode === "message" && !p.literal && CHAT_COMMANDS.some((c) => "/" + c.name === word);
    const styledInput = knownCommand ? `${p.prompt}\x1b[32;1m${word}\x1b[36;1m${p.text.slice(word.length)}${inputPadding}` : lines[0];
    this.emit("\r" + (this.color ? `\x1b[36;1m${styledInput}\x1b[0m${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}` : rendered));
    const end = terminalPosition(rendered, columns);
    if (end.column === columns) { this.emit("\n"); end.row++; end.column = 0; }
    const cursor = p.mode === "choice" ? { ...end } : terminalPosition(p.prompt + p.text.slice(0, p.cursor), columns);
    if (cursor.column === columns) { cursor.row++; cursor.column = 0; }
    this.output.write("\r" + (end.row > cursor.row ? `\x1b[${end.row - cursor.row}A` : "") + (cursor.column ? `\x1b[${cursor.column}C` : ""));
    this.rendered = cursor.row + 1;
  }
  private finish(value?: string | null, error?: unknown): void {
    const p = this.pending; if (!p) return;
    this.lastLiteral = p.literal;
    if (!error && p.mode === "message" && typeof value === "string" && value.trim()) {
      const previous = this.history.at(-1);
      if (previous?.text !== value || previous.literal !== p.literal) {
        this.history.push({ text: value, literal: p.literal });
        if (this.history.length > 100) this.history.shift();
      }
    }
    this.clear(); this.pending = undefined; p.cleanup();
    this.plainView = "";
    if (value !== null && value !== undefined) this.emit(`${p.prompt}${p.mode === "choice" ? p.choices!.find((c) => c.id === value)?.label ?? value : value}\n`);
    if (error) p.reject(error); else p.resolve(value ?? null);
  }
  private read(prompt: string, mode: Pending["mode"], signal?: AbortSignal, choices?: Choice[], localCancel = false): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) return Promise.reject(new Error("输入已被其他交互占用"));
    return new Promise((resolve, reject) => {
      const abort = () => this.finish(undefined, signal?.reason ?? new InputCancelled());
      this.pending = { prompt, mode, text: "", cursor: 0, literal: false, explicit: false, rowPasted: false, selected: 0, candidate: 0, hidden: false, localCancel, resolve, reject,
        ...(choices ? { choices } : {}), cleanup: () => signal?.removeEventListener("abort", abort) };
      this.resetHistoryNavigation();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else this.render();
    });
  }
  ask = (prompt: string, signal?: AbortSignal) => this.read(prompt, "text", signal);
  text = (prompt: string, signal?: AbortSignal) => this.read(prompt, "text", signal, undefined, true);
  message = (prompt: string) => this.read(prompt, "message");
  choose = (prompt: string, choices: Choice[], signal?: AbortSignal, localCancel = true) => this.read(prompt, "choice", signal, choices, localCancel);
  write(text: string): void { this.clear(); if (!this.ansi && this.plainView) { this.output.write("\n"); this.plainView = ""; } this.emit(text); this.render(); }
  async withInterrupt<T>(cancel: () => void, action: () => Promise<T>): Promise<T> { this.interrupt = cancel; try { return await action(); } finally { this.interrupt = undefined; } }
  pause(): void { this.suspended = true; this.restore(); this.input.pause(); }
  resume(): void { if (this.closed) return; this.suspended = false; this.input.setRawMode?.(true); if (this.ansi) this.output.write("\x1b[?2004h"); this.input.resume(); }
  private restore(): void { if (this.ansi) this.output.write("\x1b[?2004l" + (this.color ? "\x1b[0m" : "") + "\x1b[?25h"); this.input.setRawMode?.(this.oldRaw); }
  close(): void { if (this.closed) return; this.closed = true; clearTimeout(this.escapeTimer); this.finish(null); this.input.removeListener("data", this.onData); this.input.removeListener("end", this.onEnd); this.input.pause(); this.restore(); }
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text: string): string[] { return [...segmenter.segment(text)].map(({ segment }) => segment); }
export function displayWidth(text: string): number { return graphemes(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).reduce((n, c) => n + graphemeWidth(c), 0); }
function graphemeWidth(text: string): number {
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(text)) return 2;
  const base = [...text].find((c) => !/\p{Mark}|\p{Cf}/u.test(c));
  if (!base) return 0;
  const cp = base.codePointAt(0)!;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1b000 && cp <= 0x1b2ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1;
}
function terminalPosition(text: string, columns: number): { row: number; column: number } {
  let row = 0, column = 0;
  for (const c of graphemes(text)) {
    if (c === "\n") { row++; column = 0; continue; }
    const width = graphemeWidth(c);
    if (!width) continue;
    if (column + width > columns) { row++; column = 0; }
    column += width;
  }
  return { row, column };
}
