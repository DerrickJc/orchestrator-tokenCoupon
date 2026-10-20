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

declare global {
  var tokenCouponClient: TokenCouponClient | undefined;
  var tokenCouponCommandPalette: CommandPaletteBridge | undefined;
  var tokenCouponWorkspaceSwitcher: WorkspaceSwitcherBridge | undefined;
  var tokenCouponPlanningSwitcher: PlanningSwitcherBridge | undefined;
}
