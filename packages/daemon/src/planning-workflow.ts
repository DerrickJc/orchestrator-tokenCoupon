/** A read-only projection. Core remains responsible for approval and execution gates. */
export function planningWorkflow(view: {
  revision: number; status: string;
  draft?: { draftRevision: number; planHash: string };
  approval?: { draftRevision: number; planHash: string } | null;
  review?: { current: boolean; status: string };
  reviewReadError?: string;
  session?: { status?: string };
  interactions?: unknown[];
  externalOperations: Array<{ operationId: string; role: string; state: string; isCurrent: boolean; expectedRevision: number; diagnostic?: string }>;
  handoffs: Array<{ operationId: string; role?: string; pendingInputs?: number; owner?: { source?: string; expired: boolean } | null }>;
}) {
  const pending = view.handoffs.some(item => item.role === "plan" && (item.pendingInputs ?? 0) > 0);
  const current = view.externalOperations.find(op => op.isCurrent && (!pending || op.role === "plan") && op.expectedRevision === view.revision && ["prepared", "submitting"].includes(op.state));
  const slot = current && view.handoffs.find(item => item.operationId === current.operationId);
  const approved = !!view.draft && view.approval?.planHash === view.draft.planHash && view.approval?.draftRevision === view.draft.draftRevision;
  let stage: string, label: string, detail: string;
  if (view.session) {
    stage = view.interactions?.length ? "waiting_input" : `execution_${view.session.status}`;
    label = view.interactions?.length ? "等待人工处理" : ({ succeeded: "执行已完成", failed: "执行失败", running: "执行中", paused: "执行已暂停", interrupted: "执行已中断，待恢复", cancelled: "执行已取消", ready: "执行待继续", unavailable: "执行状态待核验" }[view.session.status || ""] || "查看执行状态");
    detail = view.session.status === "interrupted" ? "先在执行页核验并修复中断状态，再重试失败任务；重试完成后继续剩余任务，保留已完成结果。"
      : view.session.status === "unavailable" ? "执行身份尚未核验，不能将保存记录视为正在运行。请在执行页重新检测，暂不解锁或启动重复执行。"
      : "在执行与结果页查看任务、审批、恢复操作和交付证据。";
  } else if (current) {
    const role = current.role === "review" ? "审查" : "规划／修订";
    stage = `${current.role}_${current.state === "submitting" ? "submitting" : slot?.owner && !slot.owner.expired ? "owned" : "prepared"}`;
    label = current.state === "submitting" ? `${role}提交校验中` : slot?.owner && !slot.owner.expired ? `${role}已领取，处理中` : `等待网页领取${role}`;
    detail = current.state === "submitting" ? "正在校验提交，请查询当前结果，不要重复提交。" : slot?.owner && !slot.owner.expired ? `${slot.owner.source || "网页客户端"} 正在处理；在原网页继续，或通过交接入口转交，不要重新准备。` : `已准备当前版本的${role}，尚未收到结果。复制继续提示到获准网页，领取现有操作并提交。`;
    if (current.state === "prepared" && current.diagnostic) { label = `${role}提交校验未通过，等待修正`; detail = `${current.diagnostic}；请复用当前操作、证据和有效领取修正；达到修正上限后再重新准备。`; }
  } else if (pending) {
    stage = "plan_needs_continue"; label = "补充需求／修订尚未完成"; detail = "已登记的输入尚未提交为有效草案；先在网页继续处理，再审查、批准和执行。";
  } else if (view.reviewReadError) {
    stage = "review_unreadable"; label = "审查记录读取失败"; detail = view.reviewReadError;
  } else if (approved && view.review?.current) {
    stage = "approved"; label = `已批准 draft-${view.draft!.draftRevision}，尚未执行`; detail = "核对执行配置后，点击运行计划创建执行 Session。";
  } else if (view.review?.current && view.review.status === "succeeded") {
    stage = "awaiting_approval"; label = "审查已完成，待核对与批准"; detail = "核对问题与修订；严重问题需修订或显式豁免，再在本地批准。";
  } else {
    const last = view.externalOperations.find(op => op.isCurrent && op.expectedRevision === view.revision && ["failed", "stale", "interrupted", "cancelled"].includes(op.state));
    stage = last ? `${last.role}_${last.state}` : view.review ? "review_stale" : view.draft ? "awaiting_review" : "awaiting_plan";
    label = last ? `${last.role === "review" ? "审查" : "规划"}需要继续处理` : view.review ? "审查已失效" : view.draft ? "草案待审查" : "等待网页规划";
    detail = last?.diagnostic || (view.review ? "报告不适用于当前草案或文件依据，需要重新审查。" : view.draft ? "尚无本版有效审查；在网页完成一次审查后回本地批准。" : "在获准网页提出需求，或继续回答澄清。文字回复不等于提交到本地。");
  }
  return { stage, label, detail, ...(current ? { operationId: current.operationId, role: current.role } : pending ? { role: "plan" } : {}),
    options: stage === "awaiting_approval" || stage === "approved"
      ? ["A. 查看草案与差异", "B. 继续补充或修订", "C. 前往 4177 批准／运行"]
      : ["A. 继续当前规划／审查", "B. 按具体建议修订草案", "C. 自定义补充"],
    approvalNotice: approved && !view.review?.current ? "当前审查已不再有效，已有批准暂不可用于执行；请重新审查／批准。" : view.draft && view.draft.draftRevision > 1 && !approved ? `当前为 draft-${view.draft.draftRevision}；旧版审查或批准不适用于本版，需要重新审查／批准。` : null };
}
