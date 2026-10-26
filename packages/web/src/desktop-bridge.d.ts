interface Window {
  tokenCouponDesktop?: {
    copyText?(text: string): Promise<void>;
    reconnect?(snapshot: string): Promise<void>;
    getConnectionState?(): Promise<{ phase: "connected" | "disconnected" | "reconnecting"; error?: string }>;
    getRecoveryState?(): Promise<{ id: string; snapshot: string } | undefined>;
    acknowledgeRecovery?(id: string): Promise<void>;
    getAttachment(): Promise<{
      origin: string;
      port: number;
      epoch: string;
      profileId: string;
      protocol: { major: number; minor: number };
      applicationVersion: string;
      buildId: string;
    }>;
    openWorkspaceFolder(path: string): Promise<{ opened: boolean }>;
    chooseWorkspaceFolder(): Promise<{ canceled: boolean; path?: string }>;
    showNotification(input: { title: string; body: string; workspaceId?: string; planningId?: string; taskId?: string }): Promise<boolean>;
    getNotificationsEnabled(): Promise<boolean>;
    setNotificationsEnabled(enabled: boolean): Promise<boolean>;
  };
}
