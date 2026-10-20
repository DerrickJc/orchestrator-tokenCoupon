import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceCardItem, WorkspaceSwitcherBridge } from "./api-client-contracts.js";
import { WorkspaceCards, WorkspaceNavigation } from "./workspace-cards-ui.js";

const cardsMount = document.getElementById("workspace-cards");
const navigationMount = document.getElementById("workspace-list");
if (!cardsMount || !navigationMount) throw new Error("workspace_switcher_mount_missing：找不到工作区选择挂载点");

const cardsRoot: Root = createRoot(cardsMount);
const navigationRoot: Root = createRoot(navigationMount);
const bridge: WorkspaceSwitcherBridge = {
  render(workspaces: WorkspaceCardItem[], selectedWorkspaceId: string | undefined, onSelect) {
    const props = { workspaces, selectedWorkspaceId, onSelect };
    cardsRoot.render(<WorkspaceCards {...props} />);
    navigationRoot.render(<WorkspaceNavigation {...props} />);
  },
};

globalThis.tokenCouponWorkspaceSwitcher = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cardsRoot.unmount();
    navigationRoot.unmount();
    delete globalThis.tokenCouponWorkspaceSwitcher;
  });
}
