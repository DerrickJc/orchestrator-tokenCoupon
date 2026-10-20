import { useRef, type KeyboardEvent } from "react";

export type SubmitTextareaProps = {
  id: string;
  rows: number;
  maxLength: number;
  placeholder: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  className?: string;
  initialValue: string;
  onValueChange(value: string): void;
  onSubmit(): void;
};

export function SubmitTextarea({ id, rows, maxLength, placeholder, ariaLabel, ariaDescribedBy, className, initialValue, onValueChange, onSubmit }: SubmitTextareaProps) {
  const composing = useRef(false);
  const recentCompositionEnd = useRef(0);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const native = event.nativeEvent;
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (composing.current || native.isComposing || native.keyCode === 229 || native.which === 229) return;
    event.preventDefault();
    if (event.repeat || (recentCompositionEnd.current && performance.now() - recentCompositionEnd.current < 120)) return;
    onSubmit();
  }

  return (
    <textarea
      id={id}
      className={className}
      rows={rows}
      maxLength={maxLength}
      defaultValue={initialValue}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      onChange={event => onValueChange(event.currentTarget.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        recentCompositionEnd.current = performance.now();
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
