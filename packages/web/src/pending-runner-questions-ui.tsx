import { useState } from "react";
import type {
  PendingRunnerQuestion,
  PendingRunnerQuestionAnswer,
  PendingRunnerQuestionDraft,
  PendingRunnerQuestionsModel,
} from "./api-client-contracts.js";

function optionInputId(requestId: string, questionId: string, optionId: string) {
  return `interaction-option:${requestId}:${questionId}:${optionId}`;
}

function customInputId(requestId: string, questionId: string) {
  return `interaction-custom:${requestId}:${questionId}`;
}

function answerInputId(requestId: string, questionId: string) {
  return `interaction-answer:${requestId}:${questionId}`;
}

function readAnswer(
  requestId: string,
  question: PendingRunnerQuestion,
  drafts: Record<string, PendingRunnerQuestionDraft>,
): PendingRunnerQuestionAnswer | undefined {
  const options = question.options || [];
  const custom = options.length > 0 && drafts[customInputId(requestId, question.id)]?.checked;
  if (!options.length || custom) {
    const text = drafts[answerInputId(requestId, question.id)]?.value.trim();
    return text ? { questionId: question.id, text } : undefined;
  }
  const optionIds = options.filter(option => drafts[optionInputId(requestId, question.id, option.id)]?.checked).map(option => option.id);
  return optionIds.length ? { questionId: question.id, optionIds } : undefined;
}

export function PendingRunnerQuestions({ model }: { model: PendingRunnerQuestionsModel }) {
  const [drafts, setDrafts] = useState(model.drafts);
  const answers = model.questions.map(question => readAnswer(model.requestId, question, drafts));
  const incomplete = model.questions.some((question, index) => question.required !== false && !answers[index]);
  const hint = !model.questions.length
    ? "Runner 未提供具体问题，请使用下方“拒绝并指导”说明下一步。"
    : incomplete
      ? "请先选择一个答案，或在允许自定义时填写具体说明。"
      : "回答只发送给当前任务；计划批准、工具审批和会话取消仍由各自入口处理。";
  const update = (id: string, patch: Partial<PendingRunnerQuestionDraft>, clearIds: string[] = []) => {
    setDrafts(previous => {
      const next = { ...previous };
      for (const clearId of clearIds) next[clearId] = { ...(next[clearId] || { value: "", checked: false }), checked: false };
      next[id] = { ...(next[id] || { value: "", checked: false }), ...patch };
      return next;
    });
  };
  const onSubmit = () => {
    const submitted = model.questions.map(question => readAnswer(model.requestId, question, drafts)).filter((answer): answer is PendingRunnerQuestionAnswer => !!answer);
    if (model.questions.length && !incomplete) model.onSubmit(submitted);
  };

  return (
    <>
      {model.questions.map(question => {
        const options = question.options || [];
        const allowText = options.length ? question.allowFreeText === true : question.allowFreeText !== false;
        const customId = customInputId(model.requestId, question.id);
        const customChecked = !!drafts[customId]?.checked;
        const clearOptionIds = options.map(option => optionInputId(model.requestId, question.id, option.id));
        return (
          <fieldset className="runner-question" key={question.id}>
            <legend>{question.text || "Runner 未提供具体问题"}</legend>
            {options.map(option => {
              const id = optionInputId(model.requestId, question.id, option.id);
              const checked = !!drafts[id]?.checked;
              const clearIds = question.multiple
                ? [customId]
                : [...clearOptionIds.filter(optionId => optionId !== id), customId];
              return (
                <label className="runner-question-option" key={option.id}>
                  <input
                    type={question.multiple ? "checkbox" : "radio"}
                    name={`${model.requestId}:${question.id}`}
                    id={id}
                    data-question-id={question.id}
                    data-option-id={option.id}
                    value={option.id}
                    checked={checked}
                    onChange={event => update(id, { checked: event.currentTarget.checked }, clearIds)}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
            {allowText && options.length > 0 && (
              <label className="runner-question-option">
                <input
                  type="radio"
                  name={`${model.requestId}:${question.id}`}
                  id={customId}
                  data-question-id={question.id}
                  checked={customChecked}
                  onChange={event => update(customId, { checked: event.currentTarget.checked }, clearOptionIds)}
                />
                <span>自定义回答</span>
              </label>
            )}
            {allowText && (
              <label className="runner-question-text" hidden={options.length > 0 && !customChecked}>
                {options.length ? "请说明你的决定或补充信息" : "请补充这个问题需要的信息"}
                <input
                  type={question.secret ? "password" : "text"}
                  autoComplete="off"
                  id={answerInputId(model.requestId, question.id)}
                  data-question-id={question.id}
                  value={drafts[answerInputId(model.requestId, question.id)]?.value || ""}
                  placeholder={options.length ? "例如：选择其他方案，并说明具体要求" : "填写上方问题所需的具体信息"}
                  aria-label={`回答：${question.text}`}
                  onChange={event => update(answerInputId(model.requestId, question.id), { value: event.currentTarget.value })}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      <p className="hint runner-question-help">{hint}</p>
      <button type="button" className="button button-primary" disabled={!model.questions.length || incomplete} onClick={onSubmit}>发送回答并继续</button>
    </>
  );
}
