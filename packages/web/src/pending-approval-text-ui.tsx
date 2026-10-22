import { useState, type SyntheticEvent } from "react";
import type { PendingApprovalTextModel } from "./api-client-contracts.js";

function readFoldState(storageKey: string) {
  try { return sessionStorage.getItem(`tc-approval-fold:${storageKey}`) === "open"; }
  catch { return false; }
}

function writeFoldState(storageKey: string, open: boolean) {
  try { sessionStorage.setItem(`tc-approval-fold:${storageKey}`, open ? "open" : "closed"); }
  catch { /* Session storage is optional. */ }
}

export function PendingApprovalText({ model }: { model: PendingApprovalTextModel }) {
  const lines = model.text.split("\n");
  const isLong = lines.length > model.maxLines || model.text.length > model.maxChars;
  const [open, setOpen] = useState(() => readFoldState(model.storageKey));
  const Body = model.code ? "pre" : "p";

  if (!isLong) {
    return <><strong className="approval-field-label">{model.title}</strong><Body className={model.className}>{model.text}</Body></>;
  }

  const previewText = `${lines.slice(0, model.maxLines).join("\n")}${lines.length > model.maxLines ? "\n…（其余内容已折叠）" : "\n…（部分字符已折叠）"}`;
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    setOpen(next);
    writeFoldState(model.storageKey, next);
  };

  return (
    <details className={`foldout approval-text-foldout ${model.className}-foldout`} open={open} onToggle={onToggle}>
      <summary>{model.title} · {lines.length} 行，点击查看全文</summary>
      {!open && <Body className={`${model.className} approval-text-preview`}>{previewText}</Body>}
      {open && <Body className={`${model.className} approval-text-full`}>{model.text}</Body>}
    </details>
  );
}
