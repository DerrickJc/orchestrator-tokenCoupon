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

declare global {
  var tokenCouponClient: TokenCouponClient | undefined;
}
