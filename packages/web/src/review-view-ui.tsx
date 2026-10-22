import { useEffect, useState } from "react";
import type { ReviewChoice, ReviewViewModel } from "./api-client-contracts.js";

type ReviewViewProps = {
  model: ReviewViewModel;
  onChoiceChange: (findingId: string, choice: ReviewChoice) => void;
  setErrors: (publish: (findingIds: string[]) => void) => void;
};

const severityLabels: Record<ReviewViewModel["findings"][number]["severity"], { label: string; tone: string }> = {
  error: { label: "阻塞建议", tone: "badge-error" },
  warning: { label: "风险提醒", tone: "badge-warning" },
  info: { label: "可选建议", tone: "badge-neutral" },
};

export function ReviewView({ model, onChoiceChange, setErrors: registerErrorSetter }: ReviewViewProps) {
  const [choices, setChoices] = useState(model.choices);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => registerErrorSetter(setErrors), [registerErrorSetter]);

  function updateChoice(findingId: string, choice: ReviewChoice) {
    setChoices(previous => ({ ...previous, [findingId]: choice }));
    setErrors(previous => previous.filter(id => id !== findingId));
    onChoiceChange(findingId, choice);
  }

  return (
    <>
      <section className={`review-overview${model.isCurrent ? " is-current" : ""}`}>
        <strong>{model.summaryTitle}</strong>
        <p>{model.summaryText}</p>
      </section>
      {model.reviewReadError && <p className="notice notice-warn">审查记录读取失败：{model.reviewReadError}</p>}
      {model.findings.map(finding => {
        const severity = severityLabels[finding.severity] || severityLabels.info;
        const choice = choices[finding.findingId] || { choice: "accept" as const, custom: "" };
        return (
          <article className="finding" key={finding.findingId}>
            <div className="finding-head">
              <span className={`badge ${severity.tone}`}>{severity.label}</span>
              <h4>{finding.findingId} · {finding.description}</h4>
            </div>
            <p className="finding-suggestion">建议：{finding.suggestion}</p>
            <details className="finding-basis"><summary>查看依据</summary><p className="basis">{finding.basis}</p></details>
            {model.canChoose && (
              <div className="finding-choice" data-finding-id={finding.findingId}>
                <label>{finding.findingId} 处理方式
                  <select
                    aria-label={`${finding.findingId} 处理方式`}
                    value={choice.choice}
                    onChange={event => updateChoice(finding.findingId, { ...choice, choice: event.currentTarget.value as ReviewChoice["choice"] })}
                  >
                    <option value="accept">采纳建议（推荐）</option>
                    <option value="custom">自定义修订说明</option>
                    <option value="defer">暂不处理，保留问题</option>
                  </select>
                </label>
                {choice.choice === "custom" && (
                  <textarea
                    rows={3}
                    value={choice.custom}
                    placeholder="写明希望如何修改"
                    aria-label={`${finding.findingId} 自定义修订说明`}
                    onChange={event => updateChoice(finding.findingId, { ...choice, custom: event.currentTarget.value })}
                  />
                )}
                <span className={`field-error${errors.includes(finding.findingId) ? "" : " hidden"}`} role="alert">请填写自定义修订说明</span>
              </div>
            )}
          </article>
        );
      })}
      {model.resolutions.length > 0 && (
        <details className="review-resolutions">
          <summary>上轮问题逐项回顾 · {model.resolutions.filter(item => item.status === "resolved").length}/{model.resolutions.length} 已解决</summary>
          {model.resolutions.map((item, index) => (
            <p className={item.status === "resolved" ? "resolution-resolved" : "resolution-open"} key={`${item.findingId}:${index}`}>
              {item.findingId} · {item.status === "resolved" ? "已解决" : "仍未解决"}：{item.basis}
            </p>
          ))}
        </details>
      )}
      {model.history.length > 0 && (
        <details className="foldout">
          <summary>历史审查与批准（只读，不适用于本版）</summary>
          {model.history.map((entry, index) => <p key={`${index}:${entry}`}>{entry}</p>)}
        </details>
      )}
    </>
  );
}
