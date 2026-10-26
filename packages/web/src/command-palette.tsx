import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CommandPaletteBridge, CommandPaletteEntry } from "./api-client-contracts.js";
import { CommandPaletteUi, type PaletteRequest } from "./command-palette-ui.js";

const mount = document.getElementById("command-palette-root");
if (!mount) throw new Error("command_palette_mount_missing：找不到快速导航挂载点");

let publishRequest: (request: PaletteRequest) => void = () => {
  throw new Error("command_palette_not_ready：快速导航尚未挂载");
};
let sequence = 0;

function MountedCommandPalette() {
  const [request, setRequest] = useState<PaletteRequest | null>(null);
  publishRequest = setRequest;
  return <CommandPaletteUi request={request} />;
}

const root: Root = createRoot(mount);
flushSync(() => root.render(<MountedCommandPalette />));

const bridge: CommandPaletteBridge = {
  open(entries: CommandPaletteEntry[], onSelect) {
    publishRequest({ id: ++sequence, entries, onSelect });
  },
};

globalThis.tokenCouponCommandPalette = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    if (globalThis.tokenCouponCommandPalette === bridge) delete globalThis.tokenCouponCommandPalette;
  });
}
