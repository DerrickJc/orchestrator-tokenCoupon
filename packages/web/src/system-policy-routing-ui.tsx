import type { SystemPolicyRoutingCallbacks, SystemPolicyRoutingModel } from "./api-client-contracts.js";

export function SystemPolicyRouting({ model, callbacks }: {
  model: SystemPolicyRoutingModel;
  callbacks: SystemPolicyRoutingCallbacks;
}) {
  return <div className="system-policy-routing">
    <label>默认方式<select data-field="priority" value={model.priority} onChange={event => callbacks.onPriorityChange(event.currentTarget.value as SystemPolicyRoutingModel["priority"])}>
      <option value="web">网页优先</option>
      <option value="agent">指定 Agent 优先</option>
    </select></label>
    <label className={model.priority === "web" ? "" : "hidden"}>默认网页<select data-field="web-source" value={model.webSource} onChange={event => callbacks.onWebSourceChange(event.currentTarget.value as SystemPolicyRoutingModel["webSource"])}>
      <option value="chatgpt">ChatGPT</option>
      <option value="claude">Claude</option>
    </select></label>
  </div>;
}
