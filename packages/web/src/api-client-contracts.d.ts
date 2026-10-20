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
export type PlanTabsBridge = {
  render(selectedTab: string, onSelect: (tab: string) => void): void;
};
export type ConversationViewItem = {
  messageId: string;
  roleClass: "user" | "assistant";
  label: string;
  content: string;
};
export type ConversationViewModel = {
  count: number;
  messages: ConversationViewItem[];
};
export type ConversationViewBridge = {
  render(model: ConversationViewModel): void;
};
export type ExecutionProgressMetric = { label: string; value: string | number; kind: string };
export type ExecutionProgressModel = {
  statusLabel: string;
  statusTone: string;
  hasSession: boolean;
  completed: number;
  total: number;
  metrics: ExecutionProgressMetric[];
};
export type ExecutionProgressBridge = {
  render(model: ExecutionProgressModel): void;
};
export type LiveTaskReplyCard = {
  attemptId: string;
  heading: string;
  reply: string;
  activity: string;
  error?: string;
  showDiagnosis: boolean;
  onDiagnose: () => void;
};
export type LiveTaskRepliesModel = {
  visible: LiveTaskReplyCard[];
  overflow: LiveTaskReplyCard[];
  overflowLabel: string;
};
export type LiveTaskRepliesBridge = {
  render(model: LiveTaskRepliesModel): void;
};
export type TaskBoardAction = { label: string; onClick: () => void };
export type TaskBoardDependency = { label: string; tone: string };
export type TaskBoardEntry = {
  taskId: string;
  icon: string;
  iconTone: string;
  title: string;
  runnerModel: string;
  attemptSummary: string;
  elapsed: string;
  reasonCode?: string;
  activity: string;
  resultSummary?: string;
  resultTruncated?: boolean;
  dependencyLabel: string;
  dependencies: TaskBoardDependency[];
  completedDependencyLabel?: string;
  completedDependencies?: TaskBoardDependency[];
  nextModel?: string;
  outcome?: string;
  statusLabel: string;
  statusTone: string;
  actions: TaskBoardAction[];
};
export type TaskBoardGroup = { id: string; label: string; tasks: TaskBoardEntry[] };
export type TaskBoardModel = { emptyMessage?: string; groups: TaskBoardGroup[] };
export type TaskBoardBridge = {
  render(model: TaskBoardModel): void;
};
export type TaskDependencyPreviewModel = {
  taskCount: number;
  focusLabel: string;
  shown: number;
  svg: SVGSVGElement;
  onOpen: () => void;
};
export type TaskDependencyPreviewBridge = {
  render(model: TaskDependencyPreviewModel | null): void;
};
export type SessionControlButton = { label: string; className: string; title?: string; disabled: boolean; onClick: () => void };
export type SessionControlsModel = { buttons: SessionControlButton[] };
export type SessionControlsBridge = {
  render(model: SessionControlsModel): void;
};
export type SessionContinueBlocker = { taskId: string; label: string; onView: () => void };
export type SessionContinueModel = {
  label: string;
  disabled: boolean;
  message: string;
  blockers: SessionContinueBlocker[];
  onContinue: () => void;
  onRevise: () => void;
};
export type SessionContinueBridge = {
  render(model: SessionContinueModel): void;
};
export type PendingApprovalOverviewModel = { count: number; summary: string };
export type PendingApprovalOverviewBridge = {
  render(model: PendingApprovalOverviewModel): void;
};
export type PendingApprovalTextModel = {
  className: string;
  title: string;
  text: string;
  storageKey: string;
  maxLines: number;
  maxChars: number;
  code?: boolean;
};
export type PendingApprovalTextBridge = {
  render(mount: HTMLElement, model: PendingApprovalTextModel): void;
  unmountWithin(container: HTMLElement): void;
};
export type PendingApprovalDecisionModel = {
  onAllow: () => void;
  onDeny: () => void;
};
export type PendingApprovalDecisionBridge = {
  render(mount: HTMLElement, model: PendingApprovalDecisionModel): void;
  unmountWithin(container: HTMLElement): void;
};
export type PendingRunnerQuestionOption = { id: string; label: string };
export type PendingRunnerQuestion = {
  id: string;
  text: string;
  required?: boolean;
  allowFreeText?: boolean;
  multiple?: boolean;
  secret?: boolean;
  options?: PendingRunnerQuestionOption[];
};
export type PendingRunnerQuestionAnswer =
  | { questionId: string; text: string }
  | { questionId: string; optionIds: string[] };
export type PendingRunnerQuestionDraft = { value: string; checked: boolean };
export type PendingRunnerQuestionsModel = {
  requestId: string;
  questions: PendingRunnerQuestion[];
  drafts: Record<string, PendingRunnerQuestionDraft>;
  onSubmit: (answers: PendingRunnerQuestionAnswer[]) => void;
};
export type PendingRunnerQuestionsBridge = {
  render(mount: HTMLElement, model: PendingRunnerQuestionsModel): void;
  unmountWithin(container: HTMLElement): void;
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
  var tokenCouponPlanTabs: PlanTabsBridge | undefined;
  var tokenCouponConversationView: ConversationViewBridge | undefined;
  var tokenCouponExecutionProgress: ExecutionProgressBridge | undefined;
  var tokenCouponLiveTaskReplies: LiveTaskRepliesBridge | undefined;
  var tokenCouponTaskBoard: TaskBoardBridge | undefined;
  var tokenCouponTaskDependencyPreview: TaskDependencyPreviewBridge | undefined;
  var tokenCouponSessionControls: SessionControlsBridge | undefined;
  var tokenCouponSessionContinue: SessionContinueBridge | undefined;
  var tokenCouponPendingApprovalOverview: PendingApprovalOverviewBridge | undefined;
  var tokenCouponPendingApprovalText: PendingApprovalTextBridge | undefined;
  var tokenCouponPendingApprovalDecision: PendingApprovalDecisionBridge | undefined;
  var tokenCouponPendingRunnerQuestions: PendingRunnerQuestionsBridge | undefined;
}
