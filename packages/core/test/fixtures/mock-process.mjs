import { spawn } from "node:child_process";

const scenario = process.argv[2] ?? "success";
const marker = process.argv[3] ?? "";
const line = `${marker}\n`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

switch (scenario) {
  case "success":
    process.stdout.write("mock runner started\n");
    process.stdout.write(line.slice(0, Math.floor(line.length / 2)));
    await pause(10);
    process.stdout.write(line.slice(Math.floor(line.length / 2)));
    break;
  case "missing-marker": process.stdout.write("completed without protocol\n"); break;
  case "marker-nonzero": process.stdout.write(line); process.exitCode = 7; break;
  case "old-marker": process.stdout.write("<<<TOKEN_COUPON_DONE:old-attempt>>>\n"); break;
  case "stderr-marker": process.stderr.write(line); break;
  case "quoted-marker": process.stdout.write(`The marker is \"${marker}\"\n`); break;
  case "large-output":
    for (let index = 0; index < 40; index += 1) process.stdout.write("x".repeat(32 * 1024));
    break;
  case "hang": process.stdout.write("waiting\n"); setInterval(() => {}, 1000); break;
  case "marker-then-hang": process.stdout.write(line); setInterval(() => {}, 1000); break;
  case "spawn-child": {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(`child:${child.pid}\n${line}`);
    setInterval(() => {}, 1000);
    break;
  }
  default: process.stderr.write(`unknown scenario: ${scenario}\n`); process.exitCode = 2;
}
