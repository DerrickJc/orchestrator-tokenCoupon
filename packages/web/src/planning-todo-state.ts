import type { PlanningTodoPageDto } from "@token-coupon/client";

export function createPlanningTodoState(load: (cursor?: string) => Promise<PlanningTodoPageDto>, changed: () => void) {
  let epoch = "", generation = 0, cursors: Array<string | undefined> = [undefined];
  let value: { page: PlanningTodoPageDto | null; pageIndex: number; loading: boolean; error: string | null } = { page: null, pageIndex: 0, loading: false, error: null };
  return {
    current: () => value,
    reset(nextEpoch: string) { if (epoch === nextEpoch) return; epoch = nextEpoch; generation++; cursors = [undefined]; value = { page: null, pageIndex: 0, loading: false, error: null }; changed(); },
    async refresh(): Promise<void> {
      const request = ++generation; value = { ...value, loading: true }; changed();
      try {
        const page = await load(cursors[value.pageIndex]);
        if (request !== generation) return;
        if (page.epoch !== epoch) throw new Error("后台已变化，请重新核对计划待办。");
        value = { ...value, page, loading: false, error: null }; changed();
      } catch (error) {
        if (request !== generation) return;
        value = { ...value, loading: false, error: error instanceof Error ? error.message : "读取失败，请重试。" }; changed();
      }
    },
    async move(direction: -1 | 1): Promise<void> {
      if (value.loading || direction === -1 && value.pageIndex === 0 || direction === 1 && !value.page?.nextCursor) return;
      if (direction === 1) cursors = [...cursors.slice(0, value.pageIndex + 1), value.page!.nextCursor!];
      value = { page: null, pageIndex: value.pageIndex + direction, loading: false, error: null };
      await this.refresh();
    },
    async first(): Promise<void> { cursors = [undefined]; value = { page: null, pageIndex: 0, loading: false, error: null }; await this.refresh(); },
    unavailable() { generation++; value = { ...value, loading: false, error: "连接中断，计划待办尚未核实。" }; changed(); },
  };
}
