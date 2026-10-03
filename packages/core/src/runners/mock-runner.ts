import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runner, RunnerInput, RunnerContext } from "../runner.js";
import { runChildProcess } from "./child-process.js";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/mock-process.mjs");

export class MockRunner implements Runner {
  readonly id = "mock";
  readonly supportsModel = false;
  constructor(readonly scenario = "success") {}

  async checkAvailable(): Promise<void> {
    await access(process.execPath, constants.X_OK);
    await access(fixturePath);
  }

  run(input: RunnerInput, context: RunnerContext) {
    context.onOutput({ stream: "stdout", text: "", structuredEvent: { type: "mock.scenario", scenario: this.scenario } });
    return runChildProcess({
      executable: process.execPath,
      args: [fixturePath, this.scenario, input.completionMarker],
      cwd: input.cwd,
      input: input.prompt,
      context,
      onOutput: (output) => context.onOutput({ ...output, ...(output.stream === "stdout" ? { agentText: output.text } : {}) }),
    });
  }
}
