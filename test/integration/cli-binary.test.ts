import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

const CLI_PATH = resolve("dist/cli-entry.js");
const NODE_PATH = process.execPath;

/**
 * Runs the CLI binary as a child process with a clean environment
 * (no inherited env vars that could satisfy config loading).
 */
async function runCli(
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  try {
    const result = await execFileAsync(NODE_PATH, [CLI_PATH, ...args], {
      env: { PATH: process.env["PATH"] ?? "" },
      timeout: 10_000,
    });
    return { exitCode: 0, stderr: result.stderr };
  } catch (error: unknown) {
    const execError = error as {
      code?: number;
      stderr?: string;
    };
    return {
      exitCode: execError.code ?? 1,
      stderr: execError.stderr ?? "",
    };
  }
}

describe("CLI binary integration", () => {
  beforeAll(async () => {
    // Verify the build exists — tests require `npm run build` first
    const { existsSync } = await import("node:fs");
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `Built CLI not found at ${CLI_PATH}. Run 'npm run build' before integration tests.`,
      );
    }
  });

  it("exits 0 and prints usage text when --help is passed", async () => {
    const { exitCode, stderr } = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("paperboy");
    expect(stderr).toContain("--title");
    expect(stderr).toContain("--file");
  });

  it("exits 0 and prints version when --version is passed", async () => {
    const { exitCode, stderr } = await runCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 4 with config error when no env vars are set", async () => {
    const { exitCode, stderr } = await runCli([
      "--title",
      "Test",
      "--file",
      "nonexistent.md",
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain("Configuration error");
  });
});
