import { createRoot, type Root } from "react-dom/client";
import type { CommandPaletteBridge } from "./api-client-contracts.js";
import { PaletteResults } from "./command-palette-results.js";

const resultsNode = document.getElementById("command-palette-results");
if (!resultsNode) throw new Error("command_palette_mount_missing：找不到快速导航结果挂载点");

const root: Root = createRoot(resultsNode);
const bridge: CommandPaletteBridge = {
  render(entries, selectedIndex, onSelect) {
    root.render(<PaletteResults entries={entries} selectedIndex={selectedIndex} onSelect={onSelect} />);
  },
};

globalThis.tokenCouponCommandPalette = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    if (globalThis.tokenCouponCommandPalette === bridge) delete globalThis.tokenCouponCommandPalette;
  });
}
