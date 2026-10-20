import { useRef, useState, type FormEvent } from "react";
import type { PendingElicitationField, PendingElicitationModel } from "./api-client-contracts.js";

type FieldState = { value: string; checked: boolean; selected: string[]; touched: boolean };

function initialFieldState(field: PendingElicitationField): FieldState {
  return {
    value: field.default !== undefined && typeof field.default !== "boolean" && !Array.isArray(field.default) ? String(field.default) : "",
    checked: typeof field.default === "boolean" ? field.default : false,
    selected: Array.isArray(field.default) ? field.default.map(String) : [],
    touched: false,
  };
}

function fieldChoices(field: PendingElicitationField) {
  if (Array.isArray(field.enum)) return field.enum.map((value, index) => ({ value: String(value), label: field.enumNames?.[index] || String(value) }));
  if (Array.isArray(field.oneOf)) return field.oneOf.map(entry => ({ value: String(entry.const ?? ""), label: entry.title || String(entry.const ?? "") }));
  if (field.type === "array" && Array.isArray(field.items?.enum)) return field.items.enum.map(value => ({ value: String(value), label: String(value) }));
  if (field.type === "array" && Array.isArray(field.items?.anyOf)) return field.items.anyOf.map(entry => ({ value: String(entry.const ?? ""), label: entry.title || String(entry.const ?? "") }));
  return undefined;
}

function controlIsRequired(name: string, field: PendingElicitationField, required: Set<string>, choices: ReturnType<typeof fieldChoices>) {
  return required.has(name) && (
    field.type === "number" || field.type === "integer" ||
    field.type === "string" && (!!choices || (field.minLength || 0) > 0) ||
    field.type === "array" && (field.minItems || 0) > 0
  );
}

export function PendingElicitation({ model }: { model: PendingElicitationModel }) {
  const schema = model.schema;
  if (model.mode === "url") {
    let host = "目标网站";
    try { host = new URL(model.url || "").host; } catch { /* Runner has validated the URL. */ }
    return (
      <>
        <p className="elicitation-destination">授权或确认页面：{host}</p>
        <a href={model.url} target="_blank" rel="noopener noreferrer">在新标签页打开安全连接</a>
        <div className="interaction-actions">
          <button type="button" className="button button-primary" onClick={model.onAcceptUrl}>已完成，继续执行</button>
          <button type="button" className="button button-quiet" onClick={model.onDecline}>拒绝</button>
          <button type="button" className="button button-quiet" onClick={model.onCancel}>取消此请求</button>
        </div>
      </>
    );
  }
  if (model.mode !== "form" || !schema?.properties) {
    return <p className="hint">当前表单格式不受支持。Runner 已安全拒绝该请求；如任务仍在运行，可查看诊断信息。</p>;
  }

  return <ElicitationForm model={model} schema={schema} />;
}

function ElicitationForm({ model, schema }: { model: PendingElicitationModel; schema: NonNullable<PendingElicitationModel["schema"]> }) {
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {});
  const [values, setValues] = useState<Record<string, FieldState>>(() => Object.fromEntries(fields.map(([name, field]) => [name, initialFieldState(field)])));
  const controls = useRef(new Map<string, HTMLElement>());

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const content: Record<string, unknown> = {};
    for (const [name, field] of fields) {
      const state = values[name] || initialFieldState(field);
      if (field.type === "boolean") {
        if (required.has(name) || field.default !== undefined || state.checked || state.touched) content[name] = state.checked;
      } else if (field.type === "array") {
        if (required.has(name) || state.selected.length) content[name] = state.selected;
      } else if (state.value !== "" || required.has(name) && field.type === "string") {
        content[name] = field.type === "number" ? Number(state.value) : field.type === "integer" ? Number.parseInt(state.value, 10) : state.value;
      }
    }
    const missing = (schema.required || []).find(name => !Object.hasOwn(content, name));
    if (missing) { controls.current.get(missing)?.focus(); return; }
    model.onSubmit(content);
  };

  return (
    <form className="elicitation-form" onSubmit={submit}>
      {fields.map(([name, field]) => {
        const state = values[name] || initialFieldState(field);
        const choices = fieldChoices(field);
        const requiredControl = controlIsRequired(name, field, required, choices);
        const common = {
          required: requiredControl,
          "data-elicitation-field": name,
          ref: (element: HTMLElement | null) => { if (element) controls.current.set(name, element); else controls.current.delete(name); },
        };
        const setState = (patch: Partial<FieldState>) => setValues(previous => ({ ...previous, [name]: { ...(previous[name] || initialFieldState(field)), ...patch } }));
        let control;
        if (field.type === "boolean") {
          control = <input {...common} type="checkbox" checked={state.checked} onChange={event => setState({ checked: event.currentTarget.checked, touched: true })} />;
        } else if (choices) {
          const multiple = field.type === "array";
          control = (
            <select
              {...common}
              multiple={multiple}
              value={multiple ? state.selected : state.value}
              onChange={event => setState(multiple
                ? { selected: [...event.currentTarget.selectedOptions].map(option => option.value) }
                : { value: event.currentTarget.value })}
            >
              {!multiple && <option value="">请选择</option>}
              {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          );
        } else {
          const inputType = field.type === "number" || field.type === "integer" ? "number"
            : field.type === "string" && field.format === "email" ? "email"
              : field.type === "string" && field.format === "date" ? "date"
                : field.type === "string" && field.format === "uri" ? "url" : "text";
          control = (
            <input
              {...common}
              type={inputType}
              step={field.type === "number" ? "any" : field.type === "integer" ? "1" : undefined}
              min={field.minimum}
              max={field.maximum}
              minLength={field.type === "string" ? field.minLength : undefined}
              maxLength={field.type === "string" ? field.maxLength : undefined}
              value={state.value}
              onChange={event => setState({ value: event.currentTarget.value })}
            />
          );
        }
        return (
          <label className="elicitation-field" key={name}>
            <span className="elicitation-field-heading">{(field.title || name) + (required.has(name) ? " · 必填" : "")}</span>
            {field.description && <small>{field.description}</small>}
            {control}
          </label>
        );
      })}
      <button type="submit" className="button button-primary">提交并继续</button>
      <div className="interaction-actions">
        <button type="button" className="button button-quiet" onClick={model.onDecline}>拒绝此请求</button>
        <button type="button" className="button button-quiet" onClick={model.onCancel}>取消此请求</button>
      </div>
    </form>
  );
}
