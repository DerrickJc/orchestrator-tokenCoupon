import type { SessionControlsModel } from "./api-client-contracts.js";

export function SessionControls({ model }: { model: SessionControlsModel }) {
  return <>{model.buttons.map((button, index) => (
    <button type="button" className={button.className} title={button.title} disabled={button.disabled} onClick={button.onClick} key={`${button.label}:${index}`}>
      {button.label}
    </button>
  ))}</>;
}
