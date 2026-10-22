import { createRoot, type Root } from "react-dom/client";
import type { ReviewChoice, ReviewViewBridge, ReviewViewModel } from "./api-client-contracts.js";
import { ReviewView } from "./review-view-ui.js";

const mount = document.getElementById("review-view");
if (!mount) throw new Error("review_view_mount_missing：找不到审查结果挂载点");

let publishErrors: (findingIds: string[]) => void = () => undefined;
const root: Root = createRoot(mount);
const bridge: ReviewViewBridge = {
  render(model: ReviewViewModel, onChoiceChange: (findingId: string, choice: ReviewChoice) => void) {
    root.render(<ReviewView key={model.contextKey} model={model} onChoiceChange={onChoiceChange} setErrors={publish => { publishErrors = publish; }} />);
  },
  setErrors(findingIds: string[]) { publishErrors(findingIds); },
};

globalThis.tokenCouponReviewView = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    delete globalThis.tokenCouponReviewView;
  });
}
