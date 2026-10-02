import type { TaskDefinition } from "./task.js";

export interface PlannedTask {
  task: TaskDefinition;
  dependsOn: string[];
  status: "planned";
}

export interface PlanDefinition {
  schemaVersion: 1;
  id: string;
  title: string;
  tasks: PlannedTask[];
}
