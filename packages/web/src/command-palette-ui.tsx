import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CommandPaletteEntry } from "./api-client-contracts.js";

export type PaletteRequest = {
  id: number;
  entries: CommandPaletteEntry[];
  onSelect: (entry: CommandPaletteEntry) => void;
};

type CommandPaletteUiProps = { request: PaletteRequest | null };

export function CommandPaletteUi({ request }: CommandPaletteUiProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (request?.entries || []).filter(entry => `${entry.label} ${entry.hint}`.toLocaleLowerCase().includes(normalized));
  }, [query, request]);
  const safeIndex = entries.length ? selectedIndex % entries.length : 0;

  useEffect(() => {
    if (!request) return;
    setQuery("");
    setSelectedIndex(0);
    setOpen(true);
  }, [request?.id]);

  useLayoutEffect(() => {
    const dialog = document.getElementById("command-palette") as HTMLDialogElement | null;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      input.current?.focus();
    } else if (dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = document.getElementById("command-palette");
    if (!dialog) return;
    const close = () => setOpen(false);
    const cancel = (event: Event) => { event.preventDefault(); close(); };
    const backdropClick = (event: MouseEvent) => { if (event.target === dialog) close(); };
    const nativeClose = () => close();
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", backdropClick);
    dialog.addEventListener("close", nativeClose);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", backdropClick);
      dialog.removeEventListener("close", nativeClose);
    };
  }, []);

  useLayoutEffect(() => {
    if (open && entries.length) document.getElementById(`command-palette-option-${safeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [entries, open, safeIndex]);

  function select(entry: CommandPaletteEntry) {
    setOpen(false);
    request?.onSelect(entry);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((safeIndex + delta + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      const selected = entries[safeIndex];
      if (selected) { event.preventDefault(); select(selected); }
    }
  }

  return (
    <>
      <div className="section-title">
        <h3 id="command-palette-title">快速导航与操作</h3>
        <button type="button" className="text-button" aria-label="关闭快速导航" onClick={() => setOpen(false)}>关闭</button>
      </div>
      <label className="sr-only" htmlFor="command-palette-query">搜索页面和操作</label>
      <input
        ref={input}
        id="command-palette-query"
        type="search"
        autoComplete="off"
        placeholder="搜索页面、计划或操作…"
        value={query}
        aria-controls="command-palette-results"
        aria-activedescendant={entries.length ? `command-palette-option-${safeIndex}` : undefined}
        onChange={event => { setQuery(event.currentTarget.value); setSelectedIndex(0); }}
        onKeyDown={onInputKeyDown}
      />
      <div id="command-palette-results" className="command-palette-results" role="listbox" aria-label="可用页面和操作">
        {entries.length ? entries.map((entry, index) => (
          <button
            key={`${entry.label}:${entry.hint}:${index}`}
            type="button"
            id={`command-palette-option-${index}`}
            className="command-palette-option"
            role="option"
            aria-selected={index === safeIndex}
            onClick={() => select(entry)}
          >
            <span>{entry.label}</span>
            <small>{entry.hint}</small>
          </button>
        )) : <p className="command-palette-empty">没有匹配的页面或操作。</p>}
      </div>
      <p className="command-palette-help">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
    </>
  );
}
