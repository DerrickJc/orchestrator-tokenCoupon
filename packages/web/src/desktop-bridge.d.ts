interface Window {
  tokenCouponDesktop?: {
    getAttachment(): Promise<{
      origin: string;
      port: number;
      epoch: string;
      profileId: string;
      protocol: { major: number; minor: number };
      applicationVersion: string;
      buildId: string;
    }>;
    chooseWorkspaceFolder(): Promise<{ canceled: boolean; path?: string }>;
    showNotification(input: { title: string; body: string; workspaceId?: string; planningId?: string; taskId?: string }): Promise<boolean>;
    getNotificationsEnabled(): Promise<boolean>;
    setNotificationsEnabled(enabled: boolean): Promise<boolean>;
  };
}
