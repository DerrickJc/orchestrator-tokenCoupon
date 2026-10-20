import { useLayoutEffect } from "react";
import type { CommandPaletteEntry } from "./api-client-contracts.js";

type PaletteResultsProps = {
  entries: CommandPaletteEntry[];
  selectedIndex: number;
  onSelect: (entry: CommandPaletteEntry) => void;
};

export function PaletteResults({ entries, selectedIndex, onSelect }: PaletteResultsProps) {
  useLayoutEffect(() => {
    document.getElementById(`command-palette-option-${selectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [entries, selectedIndex]);

  if (!entries.length) {
    return <p className="command-palette-empty">没有匹配的页面或操作。</p>;
  }

  return entries.map((entry, index) => (
    <button
      key={`${entry.label}:${entry.hint}:${index}`}
      type="button"
      id={`command-palette-option-${index}`}
      className="command-palette-option"
      role="option"
      aria-selected={index === selectedIndex}
      onClick={() => onSelect(entry)}
    >
      <span>{entry.label}</span>
      <small>{entry.hint}</small>
    </button>
  ));
}
