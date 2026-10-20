export type ApiRequestOptions = Omit<RequestInit, "headers"> & { headers?: HeadersInit };

export type EventStreamHandlers = {
  onHello?: (event: Event) => void;
  onOpen?: (event: Event) => void;
  onError?: (event: Event) => void;
  onMessage?: (event: Event) => void;
  eventTypes?: readonly string[];
};

export type TokenCouponClient = {
  api(path: string, options?: ApiRequestOptions): Promise<unknown | null>;
  openEventStream(path: string, handlers?: EventStreamHandlers): EventSource;
};

export type CommandPaletteEntry = {
  label: string;
  hint: string;
  run: () => void | Promise<void>;
};

export type CommandPaletteBridge = {
  open(
    entries: CommandPaletteEntry[],
    onSelect: (entry: CommandPaletteEntry) => void,
  ): void;
};

export type WorkspaceCardItem = { workspaceId: string; label: string; path: string };

export type WorkspaceSwitcherBridge = {
  render(
    workspaces: WorkspaceCardItem[],
    selectedWorkspaceId: string | undefined,
    onSelect: (workspaceId: string) => void,
  ): void;
};

export type PlanningNavigationItem = {
  planningId: string;
  title: string;
  status: string;
  statusTone: string;
  createdAt?: string;
  taskCount: number;
  selected: boolean;
  workflowLabel?: string;
  toolsExpanded: boolean;
};

export type PlanningSwitcherBridge = {
  render(
    items: PlanningNavigationItem[],
    activeTool: string | undefined,
    onSelect: (planningId: string) => void,
    onOpenTool: (planningId: string, tab: string) => void,
    onToolsToggle: (planningId: string, expanded: boolean) => void,
  ): void;
};

export type ReviewChoice = { choice: "accept" | "custom" | "defer"; custom: string };
export type ReviewFindingView = {
  findingId: string;
  severity: "error" | "warning" | "info";
  description: string;
  suggestion: string;
  basis: string;
};
export type ReviewViewModel = {
  contextKey: string;
  summaryTitle: string;
  summaryText: string;
  isCurrent: boolean;
  reviewReadError?: string;
  findings: ReviewFindingView[];
  canChoose: boolean;
  choices: Record<string, ReviewChoice>;
  resolutions: { findingId: string; status: string; basis: string }[];
  history: string[];
};
export type ReviewViewBridge = {
  render(model: ReviewViewModel, onChoiceChange: (findingId: string, choice: ReviewChoice) => void): void;
  setErrors(findingIds: string[]): void;
};

export type PlannerRequestComposerBridge = {
  setValue(value: string): void;
  focus(): void;
};

export type ReplyComposerBridge = PlannerRequestComposerBridge & {
  setPlaceholder(value: string): void;
  setDisabled(value: boolean): void;
};

export type PlanDraftViewTask = {
  taskId: string;
  title: string;
  schemaLabel: string;
  sections: { label: string; value: string | string[] }[];
  dependsOn: string[];
  runnerLabel: string;
  modelLabel: string;
};
export type PlanDraftViewModel = {
  contextKey: string;
  emptyMessage?: string;
  tasks: PlanDraftViewTask[];
};
export type PlanDraftViewBridge = {
  render(model: PlanDraftViewModel): void;
};
export type PlanOverviewModel = {
  stage: string;
  stageTone: string;
  nextAction: string;
  taskCount: number;
  completedTaskCount: number;
  reviewStatus: string;
  primaryActionLabel: string;
  resumeDisabled: boolean;
};
export type PlanOverviewBridge = {
  render(model: PlanOverviewModel, onPrimaryAction: () => void, onResume: () => void): void;
};

declare global {
  var tokenCouponClient: TokenCouponClient | undefined;
  var tokenCouponCommandPalette: CommandPaletteBridge | undefined;
  var tokenCouponWorkspaceSwitcher: WorkspaceSwitcherBridge | undefined;
  var tokenCouponPlanningSwitcher: PlanningSwitcherBridge | undefined;
  var tokenCouponReviewView: ReviewViewBridge | undefined;
  var tokenCouponPlannerRequestComposer: PlannerRequestComposerBridge | undefined;
  var tokenCouponReplyComposer: ReplyComposerBridge | undefined;
  var tokenCouponPlanDraftView: PlanDraftViewBridge | undefined;
  var tokenCouponPlanOverview: PlanOverviewBridge | undefined;
}
