import type { PendingQueueDto } from "@token-coupon/client";

export interface PendingQueueState { items: PendingQueueDto["items"]; total: number; offset: number; nextOffset: number | null; loading: boolean; error: string | null; }
export function createPendingQueueState(load: (offset: number) => Promise<PendingQueueDto>, changed: (state: PendingQueueState) => void) {
  let epoch = "", generation = 0;
  let value: PendingQueueState = { items: [], total: 0, offset: 0, nextOffset: null, loading: false, error: null };
  return {
    current: () => value,
    reset(nextEpoch: string) {
      if (epoch === nextEpoch) return;
      epoch = nextEpoch; generation++;
      value = { items: [], total: 0, offset: 0, nextOffset: null, loading: false, error: "状态待核对" }; changed(value);
    },
    async refresh(offset = value.offset): Promise<void> {
      const request = ++generation;
      value = { ...value, loading: true }; changed(value);
      try {
        const result = await load(offset);
        if (request !== generation) return;
        if (result.epoch !== epoch) throw new Error("后台已变化，请重新连接后核对待处理请求。");
        // Resolved requests can make the last page empty; read the first page again.
        if (offset > 0 && !result.items.length) return await this.refresh(0);
        value = { ...result, offset, loading: false, error: null }; changed(value);
      } catch (error) {
        if (request !== generation) return;
        value = { ...value, loading: false, error: error instanceof Error ? error.message : "读取失败，请重试。" }; changed(value);
      }
    },
    unavailable() { generation++; value = { ...value, loading: false, error: "连接中断，当前数量尚未核实。" }; changed(value); },
  };
}
