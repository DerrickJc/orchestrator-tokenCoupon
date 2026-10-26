/** Windows uses authenticated named pipes; Linux retains its private Unix socket. */
export function quickTunnelSupport(platform: NodeJS.Platform = process.platform): { available: boolean; reason?: string } {
  return platform === "win32" || platform === "linux"
    ? { available: true }
    : { available: false, reason: "当前快捷连接支持原生 Windows 和 Linux／WSL；本平台可使用本机 Agent 或单独配置固定 HTTPS 网关。" };
}

export function assertQuickTunnelSupported(platform: NodeJS.Platform = process.platform): void {
  const support = quickTunnelSupport(platform);
  if (!support.available) throw new Error(`remote_quick_tunnel_unsupported：${support.reason}`);
}
