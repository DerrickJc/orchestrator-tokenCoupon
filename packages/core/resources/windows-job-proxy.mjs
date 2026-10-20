import crossSpawn from "cross-spawn";

try {
  const config = JSON.parse(Buffer.from(process.env.TOKEN_COUPON_CHILD_CONFIG || "", "base64").toString("utf8"));
  delete process.env.TOKEN_COUPON_CHILD_CONFIG;
  if (typeof config.command !== "string" || !Array.isArray(config.args) || config.args.some(value => typeof value !== "string")) throw new Error("windows_job_config_invalid");
  const child = crossSpawn(config.command, config.args, { stdio: "inherit", windowsHide: true, shell: false });
  child.once("error", error => { process.stderr.write(`windows_job_child_start_failed: ${error.code || "unknown"}\n`); process.exit(127); });
  child.once("close", code => process.exit(code ?? 1));
} catch (error) {
  process.stderr.write(`windows_job_proxy_failed: ${error.message}\n`);
  process.exitCode = 126;
}
