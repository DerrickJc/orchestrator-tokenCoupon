import { expect, it } from "vitest";
// @ts-expect-error Native maintainer launcher; parsing is safe to test on all hosts.
const { parseWindowsStaticProxy } = await import("../../../scripts/prepare-desktop-acceptance.mjs");
const settings = (server: string, enabled = "0x1") => `ProxyEnable REG_DWORD ${enabled}\r\nProxyServer REG_SZ ${server}\r\n`;
it("uses an enabled Windows static proxy for both destination protocols", () => {
  expect(parseWindowsStaticProxy(settings("127.0.0.1:7897"))).toEqual({ HTTP_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7897" });
  expect(parseWindowsStaticProxy(settings("http=proxy.example:8080;https=https://secure.example:8443"))).toEqual({ HTTP_PROXY: "http://proxy.example:8080", HTTPS_PROXY: "https://secure.example:8443" });
});
it("does not reuse disabled settings, PAC-only configuration or unsupported SOCKS values", () => {
  expect(parseWindowsStaticProxy(settings("127.0.0.1:7897", "0x0"))).toEqual({});
  expect(parseWindowsStaticProxy("AutoConfigURL REG_SZ https://config.example/proxy.pac")).toEqual({});
  expect(parseWindowsStaticProxy(settings("socks=socks5://127.0.0.1:1080"))).toEqual({});
});
it("does not put credentials, commands or malformed proxy settings into a batch file", () => {
  for (const value of ["http://user:password@proxy.example:8080", "http://proxy.example/path", "proxy.example:8080 & other", 'proxy.example:8080"', "http://proxy.example/?secret=1", "not-a-proxy:port"])
    expect(parseWindowsStaticProxy(settings(value))).toEqual({});
});
