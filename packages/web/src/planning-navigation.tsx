import { createRoot, type Root } from "react-dom/client";
import type { PlanningNavigationItem, PlanningSwitcherBridge } from "./api-client-contracts.js";
import { PlanningCards, PlanningNavigation } from "./planning-navigation-ui.js";

const navigationMount = document.getElementById("planning-list");
const cardsMount = document.getElementById("workspace-plan-cards");
if (!navigationMount || !cardsMount) throw new Error("planning_switcher_mount_missing：找不到规划列表挂载点");

const navigationRoot: Root = createRoot(navigationMount);
const cardsRoot: Root = createRoot(cardsMount);
const bridge: PlanningSwitcherBridge = {
  render(items: PlanningNavigationItem[], activeTool, onSelect, onOpenTool, onToolsToggle) {
    const props = { items, activeTool, onSelect, onOpenTool, onToolsToggle };
    navigationRoot.render(<PlanningNavigation {...props} />);
    cardsRoot.render(<PlanningCards items={items} onSelect={onSelect} />);
  },
};

globalThis.tokenCouponPlanningSwitcher = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    navigationRoot.unmount();
    cardsRoot.unmount();
    delete globalThis.tokenCouponPlanningSwitcher;
  });
}
