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
export type PendingInteractionGuidanceKind = "approval" | "elicitation" | "question";
export type PendingInteractionGuidanceModel = {
  kind: PendingInteractionGuidanceKind;
  onSubmit: (guidance: string) => void;
  onInvalid: () => void;
};
export type PendingInteractionGuidanceBridge = {
  render(mount: HTMLElement, model: PendingInteractionGuidanceModel): void;
  unmountWithin(container: HTMLElement): void;
};
export type PendingElicitationChoice = { value: string; label: string };
export type PendingElicitationField = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: { const?: unknown; title?: string }[];
  items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: string }[] };
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  default?: unknown;
};
export type PendingElicitationSchema = {
  required?: string[];
  properties?: Record<string, PendingElicitationField>;
};
export type PendingElicitationMode = "form" | "url" | "unsupported";
export type PendingElicitationModel = {
  mode: PendingElicitationMode;
  url?: string;
  schema?: PendingElicitationSchema;
  onAcceptUrl: () => void;
  onSubmit: (content: Record<string, unknown>) => void;
  onDecline: () => void;
  onCancel: () => void;
};
export type PendingElicitationBridge = {
  render(mount: HTMLElement, model: PendingElicitationModel): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptOverviewModel = {
  state: string;
  notice: string;
  outcome: string;
  outcomeClass: string;
  outcomeVisible: boolean;
  replyHeading: string;
  diagnoseVisible: boolean;
};
export type AttemptOverviewBridge = {
  render(model: AttemptOverviewModel, onDiagnose: () => void): void;
};
export type AttemptMessageView = { messageId: string; title: string; text: string };
export type AttemptMessagesModel = { messages: AttemptMessageView[]; emptyMessage: string };
export type AttemptMessagesBridge = {
  render(model: AttemptMessagesModel): void;
};
export type AttemptToolView = { eventKey: string; summary: string; text: string; isError: boolean };
export type AttemptToolsModel = { tools: AttemptToolView[]; openEventKeys: string[] };
export type AttemptToolsBridge = {
  render(model: AttemptToolsModel): void;
};
export type AttemptToolsPaginationModel = { pageLabel: string; previousDisabled: boolean; nextDisabled: boolean };
export type AttemptToolsPaginationBridge = {
  render(model: AttemptToolsPaginationModel, callbacks: { onPrevious: () => void; onNext: () => void }): void;
};
export type AttemptRecordControlsModel = { hasMore: boolean; loading: boolean };
export type AttemptRecordControlsBridge = {
  render(model: AttemptRecordControlsModel, callbacks: { onRefresh: () => void; onMore: () => void }): void;
};
export type PlannerProviderOption = { id: string; label: string; disabled: boolean };
export type PlannerProviderSelectorModel = {
  standalone: PlannerProviderOption[];
  localAgents: PlannerProviderOption[];
  apiProviders: PlannerProviderOption[];
  selectedProviderId: string;
};
export type PlannerProviderSelectorBridge = {
  render(model: PlannerProviderSelectorModel, onChange: (providerId: string) => void): void;
};
export type RunnerSelectorOption = { id: string; label: string; disabled: boolean };
export type RunnerSelectorModel = { options: RunnerSelectorOption[]; selectedRunnerId: string };
export type RunnerSelectorBridge = {
  render(model: RunnerSelectorModel, onChange: (runnerId: string) => void): void;
};
export type ModelChoiceOption = { id: string; label: string };
export type ModelChoiceSelectorModel = { choices: ModelChoiceOption[]; selectedModelId: string };
export type ModelChoiceSelectorsBridge = {
  render(prefix: "planner" | "runner" | "reviewer", model: ModelChoiceSelectorModel, onChange: (modelId: string) => void): void;
};
export type ReviewerModeOption = { id: string; label: string };
export type ReviewerModeSelectorModel = { options: ReviewerModeOption[]; selectedMode: string };
export type ReviewerModeSelectorBridge = {
  render(model: ReviewerModeSelectorModel, onChange: (mode: string) => void): void;
};
export type AttemptRawEventsModel = { lines: string[]; filterValue: string; pageLabel: string; previousDisabled: boolean; nextDisabled: boolean };
export type AttemptRawEventsBridge = {
  render(mount: HTMLElement, model: AttemptRawEventsModel, callbacks: { onFilter: (value: string) => void; onPrevious: () => void; onNext: () => void }): void;
};
export type AttemptSelectionChoice = { attemptId: string; label: string };
export type AttemptSelectionModel = {
  choices: AttemptSelectionChoice[];
  selectedAttemptId: string;
  contextText: string;
  historical: boolean;
  latestDisabled: boolean;
};
export type AttemptSelectionBridge = {
  render(model: AttemptSelectionModel, callbacks: { onSelect: (attemptId: string) => void; onLatest: () => void }): void;
};
export type AttemptDiagnosisMessageView = { messageId: string; role: "user" | "assistant"; heading: string; content: string };
export type AttemptDiagnosisHistoryModel = {
  messages: AttemptDiagnosisMessageView[];
  emptyMessage: string;
  showEmptyMessage: boolean;
  pendingMessage?: string;
  errorMessage?: string;
  running: boolean;
};
export type AttemptDiagnosisHistoryBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisHistoryModel): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptDiagnosisComposerModel = { initialValue: string; placeholder: string };
export type AttemptDiagnosisComposerBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisComposerModel, onValueChange: (value: string) => void, onSubmit: () => void): void;
  setValue(mount: HTMLElement, value: string): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptDiagnosisControlsModel = {
  diagnostics: { id: string; label: string }[];
  selectedDiagnosticId: string;
  runnerId: string;
  modelId: string;
  models: { id: string; label: string }[];
  customModelId: string;
  disabled: boolean;
};
export type AttemptDiagnosisControlsBridge = {
  renderHistory(mount: HTMLElement, diagnostics: AttemptDiagnosisControlsModel["diagnostics"], selectedId: string, disabled: boolean, onChange: (id: string) => void): void;
  renderModels(mount: HTMLElement, model: AttemptDiagnosisControlsModel, callbacks: { onRunnerChange: (runnerId: string) => void; onModelChange: (modelId: string) => void; onCustomModelChange: (modelId: string) => void }): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptDiagnosisExportModel = { status: string; path: string; copyLabel: string; copyDisabled: boolean };
export type AttemptDiagnosisExportBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisExportModel, callbacks: { onClose: () => void; onCopy: () => void; onSwitch: () => void }): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptDiagnosisChoiceBridge = {
  render(mount: HTMLElement, callbacks: { onClose: () => void; onLocal: () => void; onWeb: () => void }): void;
  unmountWithin(container: HTMLElement): void;
};
export type AttemptDiagnosisDialogModel = { contextText: string; statusText: string; sendLabel: string; sendDisabled: boolean };
export type AttemptDiagnosisDialogBridge = {
  render(mount: HTMLElement, model: AttemptDiagnosisDialogModel, callbacks: { onClose: () => void; onSwitch: () => void }): void;
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
  var tokenCouponPendingInteractionGuidance: PendingInteractionGuidanceBridge | undefined;
  var tokenCouponPendingElicitation: PendingElicitationBridge | undefined;
  var tokenCouponAttemptOverview: AttemptOverviewBridge | undefined;
  var tokenCouponAttemptMessages: AttemptMessagesBridge | undefined;
  var tokenCouponAttemptTools: AttemptToolsBridge | undefined;
  var tokenCouponAttemptToolsPagination: AttemptToolsPaginationBridge | undefined;
  var tokenCouponAttemptRecordControls: AttemptRecordControlsBridge | undefined;
  var tokenCouponPlannerProviderSelector: PlannerProviderSelectorBridge | undefined;
  var tokenCouponRunnerSelector: RunnerSelectorBridge | undefined;
  var tokenCouponModelChoiceSelectors: ModelChoiceSelectorsBridge | undefined;
  var tokenCouponReviewerModeSelector: ReviewerModeSelectorBridge | undefined;
  var tokenCouponAttemptRawEvents: AttemptRawEventsBridge | undefined;
  var tokenCouponAttemptSelection: AttemptSelectionBridge | undefined;
  var tokenCouponAttemptDiagnosisHistory: AttemptDiagnosisHistoryBridge | undefined;
  var tokenCouponAttemptDiagnosisComposer: AttemptDiagnosisComposerBridge | undefined;
  var tokenCouponAttemptDiagnosisControls: AttemptDiagnosisControlsBridge | undefined;
  var tokenCouponAttemptDiagnosisExport: AttemptDiagnosisExportBridge | undefined;
  var tokenCouponAttemptDiagnosisChoice: AttemptDiagnosisChoiceBridge | undefined;
  var tokenCouponAttemptDiagnosisDialog: AttemptDiagnosisDialogBridge | undefined;
}
