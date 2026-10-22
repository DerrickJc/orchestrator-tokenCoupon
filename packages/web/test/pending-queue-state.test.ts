import { expect, it, vi } from "vitest";
import type { PendingQueueDto } from "@token-coupon/client";
import { createPendingQueueState } from "../src/pending-queue-state.js";

const page = (epoch = "one", total = 0): PendingQueueDto => ({ epoch, items: [], total, nextOffset: null });
it("discards late responses after a restart or disconnect and rejects mismatched daemon identity", async () => {
  let complete!: (value: PendingQueueDto) => void;
  const load = vi.fn(() => new Promise<PendingQueueDto>(resolve => { complete = resolve; }));
  const state = createPendingQueueState(load, vi.fn()); state.reset("one");
  const first = state.refresh(); state.reset("two"); complete(page("one", 7)); await first;
  expect(state.current().total).toBe(0); expect(state.current().error).toBe("状态待核对");
  const second = state.refresh(); state.unavailable(); complete(page("two", 4)); await second;
  expect(state.current().error).toContain("连接中断"); expect(state.current().total).toBe(0);
  const third = state.refresh(); complete(page("other")); await third;
  expect(state.current().error).toContain("后台已变化");
});

it("returns to page one when requests resolve and keeps errors distinct from an empty queue", async () => {
  const load = vi.fn(async (_offset: number) => page());
  const state = createPendingQueueState(load, vi.fn()); state.reset("one"); await state.refresh(100);
  expect(load.mock.calls.map(call => call[0])).toEqual([100, 0]); expect(state.current().offset).toBe(0);
  load.mockRejectedValueOnce(new Error("offline")); await state.refresh();
  expect(state.current().error).toBe("offline"); expect(state.current().loading).toBe(false);
  await state.refresh(); expect(state.current().error).toBeNull();
});
