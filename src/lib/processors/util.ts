import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function makeWorkDir(fileId: string) {
  const dir = path.join(os.tmpdir(), `mm-rag-${fileId}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function runCommand(command: string, args: string[], timeoutMs = 120_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

export async function commandExists(command: string) {
  try {
    await runCommand("which", [command], 5_000);
    return true;
  } catch {
    return false;
  }
}

export async function writeBuffer(dir: string, fileName: string, buffer: Buffer) {
  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, buffer);
  return fullPath;
}

export async function parseCommandJson<T>(commandLine: string, filePath: string): Promise<T> {
  const [command, ...prefixArgs] = commandLine.split(" ").filter(Boolean);
  if (!command) throw new Error("Adapter command is empty.");
  const { stdout } = await runCommand(command, [...prefixArgs, filePath], 600_000);
  return JSON.parse(stdout) as T;
}
