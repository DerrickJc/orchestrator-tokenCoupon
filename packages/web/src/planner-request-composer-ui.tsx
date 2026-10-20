import { useRef, type KeyboardEvent } from "react";

export type PlannerRequestComposerProps = {
  initialValue: string;
  onValueChange(value: string): void;
  onSubmit(): void;
};

export function PlannerRequestComposer({ initialValue, onValueChange, onSubmit }: PlannerRequestComposerProps) {
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
      id="planner-request-input"
      className="planner-request-input"
      rows={4}
      maxLength={8192}
      defaultValue={initialValue}
      placeholder="例如：给现有服务增加课程查询接口，先检查项目约定，再补充测试。"
      aria-label="需求描述"
      aria-describedby="request-shortcuts"
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
