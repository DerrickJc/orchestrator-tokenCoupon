export interface DisplayWorkArea { x: number; y: number; width: number; height: number }
export interface WindowBounds extends DisplayWorkArea {}

const DEFAULT_SIZE = { width: 1440, height: 960 };

function validBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Partial<WindowBounds>;
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
    Math.abs(bounds.x!) <= 100_000 && Math.abs(bounds.y!) <= 100_000 && bounds.width! >= 900 && bounds.height! >= 640 && bounds.width! <= 8192 && bounds.height! <= 8192;
}

function overlapArea(a: WindowBounds, b: DisplayWorkArea): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

export function restoreWindowBounds(saved: unknown, workAreas: readonly DisplayWorkArea[]): WindowBounds {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1440, height: 960 };
  const bounds = validBounds(saved) ? saved : undefined;
  const area = bounds
    ? workAreas.reduce((best, candidate) => overlapArea(bounds, candidate) > overlapArea(bounds, best) ? candidate : best, primary)
    : primary;
  const width = Math.max(Math.min(900, area.width), Math.min(bounds?.width ?? DEFAULT_SIZE.width, area.width));
  const height = Math.max(Math.min(640, area.height), Math.min(bounds?.height ?? DEFAULT_SIZE.height, area.height));
  const x = bounds && overlapArea(bounds, area) > 0 ? bounds.x : area.x + Math.round((area.width - width) / 2);
  const y = bounds && overlapArea(bounds, area) > 0 ? bounds.y : area.y + Math.round((area.height - height) / 2);
  return { x: Math.min(Math.max(x, area.x), area.x + area.width - width), y: Math.min(Math.max(y, area.y), area.y + area.height - height), width, height };
}
