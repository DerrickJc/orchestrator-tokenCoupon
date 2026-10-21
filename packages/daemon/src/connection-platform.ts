/** The persistent gateway currently relies on POSIX socket paths and permissions. */
export function quickTunnelSupport(platform: NodeJS.Platform = process.platform): { available: boolean; reason?: string } {
  return platform === "win32"
    ? { available: false, reason: "原生 Windows 暂不支持快捷连接。可继续使用本机 Agent；网页 MCP 可连接已单独配置的固定 HTTPS 网关，或使用 Linux／WSL 后台的快捷连接。" }
    : { available: true };
}

export function assertQuickTunnelSupported(platform: NodeJS.Platform = process.platform): void {
  const support = quickTunnelSupport(platform);
  if (!support.available) throw new Error(`remote_quick_tunnel_unsupported：${support.reason}`);
}
