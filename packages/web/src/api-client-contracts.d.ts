export type ApiRequestOptions = Omit<RequestInit, "headers"> & { headers?: HeadersInit };

export type EventStreamHandlers = {
  onHello?: (event: Event) => void;
  onOpen?: (event: Event) => void;
  onError?: (event: Event) => void;
  onMessage?: (event: Event) => void;
  eventTypes?: readonly string[];
};

export type TokenCouponClient = {
  api(path: string, options?: ApiRequestOptions): Promise<unknown | null>;
  openEventStream(path: string, handlers?: EventStreamHandlers): EventSource;
};

export type CommandPaletteEntry = {
  label: string;
  hint: string;
  run: () => void | Promise<void>;
};

export type CommandPaletteBridge = {
  render(
    entries: CommandPaletteEntry[],
    selectedIndex: number,
    onSelect: (entry: CommandPaletteEntry) => void,
  ): void;
};

declare global {
  var tokenCouponClient: TokenCouponClient | undefined;
  var tokenCouponCommandPalette: CommandPaletteBridge | undefined;
}
