export type ExecutionMode = "non_interactive" | "managed";
export type RequiredRunnerCapability = "userInput" | "toolApproval";

export interface ExecutionConfig {
  runnerId: string;
  modelId?: string;
  mode: ExecutionMode;
  /** Optional capabilities the task needs from this Runner; omitted in legacy plans. */
  requiredCapabilities?: RequiredRunnerCapability[];
  /** Deprecated historical field. It is preserved in old plans but never limits an Attempt. */
  timeoutMs?: number;
}

export interface TaskDefinition {
  schemaVersion: 1 | 2;
  id: string;
  title: string;
  /** Canonical execution text; generated from the structured fields for schemaVersion 2. */
  prompt: string;
  objective?: string;
  approach?: string;
  steps?: string[];
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  notes?: string;
  execution: ExecutionConfig;
}

export type StructuredTaskFields = Pick<TaskDefinition, "objective" | "approach" | "steps" | "deliverables" | "acceptanceCriteria" | "constraints" | "notes">;

export function renderTaskPrompt(task: Pick<TaskDefinition, "schemaVersion" | "prompt"> & Partial<StructuredTaskFields>): string {
  if (task.schemaVersion === 1) return task.prompt;
  const sections: string[] = [];
  const add = (title: string, value: string | string[] | undefined) => {
    const content = Array.isArray(value) ? value.map((item, index) => `${index + 1}. ${item}`).join("\n") : value;
    if (content?.trim()) sections.push(`${title}\n${content}`);
  };
  add("需求目标", task.objective);
  add("设计与技术方案", task.approach);
  add("实施步骤", task.steps);
  add("交付物", task.deliverables);
  add("验收标准", task.acceptanceCriteria);
  add("约束", task.constraints);
  add("其他说明", task.notes);
  return sections.join("\n\n");
}
