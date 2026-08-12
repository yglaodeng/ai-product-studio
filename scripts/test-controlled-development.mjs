import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp("/private/tmp/aps-controlled-development-");
const dataRoot = path.join(runtimeRoot, "data");
const workspaceRoot = path.join(runtimeRoot, "AI 数据工作台");
const host = "127.0.0.1";
const port = 18107;
const baseUrl = `http://${host}:${port}`;
const fakeCodex = path.join(runtimeRoot, "fake-codex.mjs");

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/executions`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test_server_not_ready");
}

async function getJson(url) {
  const response = await fetch(`${baseUrl}${url}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url}:${response.status}:${JSON.stringify(payload)}`);
  return payload;
}

await mkdir(dataRoot, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
await writeFile(fakeCodex, `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes("Do not read, edit, delete, move, or create files outside") || !prompt.includes("127.0.0.6 on port 8006")) process.exit(2);
await mkdir(path.join(process.cwd(), "src"), { recursive: true });
await writeFile(path.join(process.cwd(), "package.json"), JSON.stringify({ name: "ai-data-workbench", private: true }, null, 2) + "\\n");
await writeFile(path.join(process.cwd(), "src", "main.js"), "export const ready = true;\\n");
if (outputFile) await writeFile(outputFile, "受控开发隔离测试完成");
`, "utf8");
await chmod(fakeCodex, 0o755);

const now = new Date().toISOString();
const failedExecution = {
  id: "execution-draft-prompt-901",
  draftId: "draft-prompt-901",
  promptNumber: 901,
  project: "APS",
  title: "将以上任务交由 Codex 执行",
  goal: "执行上一轮已生成的任务",
  requirements: "先检查完整上下文再执行",
  acceptanceCriteria: ["独立项目产生文件"],
  priority: "high",
  command: "npm run build",
  status: "failed",
  createdAt: now,
  confirmedAt: now,
  updatedAt: now,
  dispatchedAt: now,
  startedAt: null,
  completedAt: now,
  exitCode: null,
  result: null,
  error: "unsupported_execution_request",
  stdout: "",
  stderr: "",
  statusHistory: [{ status: "failed", at: now }],
};
await writeJson(path.join(dataRoot, "execution-tasks.json"), { executions: [failedExecution] });
await writeJson(path.join(dataRoot, "task-drafts.json"), { drafts: [{
  id: "draft-prompt-901", promptNumber: 901, project: "AI 数据工作台", title: failedExecution.title,
  goal: failedExecution.goal, priority: "high", acceptanceCriteria: failedExecution.acceptanceCriteria,
  status: "failed", confirmedAt: now, updatedAt: now,
}] });
await writeJson(path.join(dataRoot, "sync-tasks.json"), { tasks: [{
  id: "prompt-901", promptNumber: 901, confirmed: true, status: "failed", error: failedExecution.error,
  errors: [failedExecution.error], createdAt: now, updatedAt: now,
  steps: Object.fromEntries(["listened", "parsed", "taskCreated", "confirmed", "dispatched", "codex", "returned"].map((key) => [key, { status: "success", at: now }])),
}] });
await writeJson(path.join(dataRoot, "sync-events.json"), { events: [{
  id: "safari-test-prompt-902", source: "safari-chatgpt", conversationId: "test",
  turnId: "prompt-902", role: "assistant",
  content: "【用户】1\n\n【GPT】AI 数据工作台 V1.0 产品架构与业务逻辑设计任务包：输出产品架构图、用户流程、数据流、模块设计、MVP 路线和差距分析，暂不开发更多 UI。",
  confirmed: false, operations: [], receivedAt: now,
}, {
  id: `${failedExecution.id}-failed`, source: "codex-aps", conversationId: "test",
  turnId: "prompt-901-codex", role: "system", content: "【Codex failed】unsupported_execution_request",
  confirmed: true, operations: [], receivedAt: now,
}] });
await writeJson(path.join(dataRoot, "studio-state.json"), { nodes: [], positions: {}, versions: [], updatedAt: now });
await writeJson(path.join(dataRoot, "safari-sync-checkpoint.json"), { lastPromptNumber: 901, collaborationMode: "paused" });
await writeJson(path.join(dataRoot, "collaboration-state.json"), { approvalStatus: "approved", mode: "stopped", bridgeStatus: "ready" });

const server = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    APS_RUNTIME_DIR: runtimeRoot,
    APS_PROJECT_ROOT: projectRoot,
    APS_AI_DATA_WORKBENCH_ROOT: workspaceRoot,
    APS_CODEX_BIN: fakeCodex,
    APS_HOST: host,
    APS_PORT: String(port),
    APS_BRIDGE_SIMULATION: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitForServer();
  const retryResponse = await fetch(`${baseUrl}/api/executions/${failedExecution.id}/retry`, { method: "POST" });
  const retryPayload = await retryResponse.json();
  if (retryResponse.status !== 202 || retryPayload.executionId !== `${failedExecution.id}-retry-1`) {
    throw new Error(`retry_not_queued:${retryResponse.status}:${JSON.stringify(retryPayload)}`);
  }
  let retry;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    retry = (await getJson("/api/executions")).executions.find((item) => item.id === retryPayload.executionId);
    if (["completed", "failed"].includes(retry?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (retry?.status !== "completed" || retry.exitCode !== 0 || retry.executionMode !== "development" || retry.project !== "AI 数据工作台") {
    throw new Error(`controlled_execution_failed:${JSON.stringify(retry)}`);
  }
  if (retry.requirements.includes("失败任务检查补充上下文")) throw new Error("retry_context_polluted_requirements");
  const executions = (await getJson("/api/executions")).executions;
  const original = executions.find((item) => item.id === failedExecution.id);
  if (original.status !== "failed" || original.error !== "unsupported_execution_request" || original.project !== "APS") {
    throw new Error("historical_failure_was_modified");
  }
  const packageName = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8")).name;
  const task = (await getJson("/api/sync/tasks")).tasks.find((item) => item.promptNumber === 901);
  const events = (await getJson("/api/sync/events")).events;
  if (packageName !== "ai-data-workbench" || task.status !== "success" || task.error !== null || task.errors.length !== 0) {
    throw new Error("workspace_or_task_result_invalid");
  }
  if (!events.some((event) => event.id === `${retryPayload.executionId}-completed`)) throw new Error("retry_result_event_missing");
  process.stdout.write(`${JSON.stringify({
    passed: true,
    originalStatus: original.status,
    retryId: retry.id,
    retryStatus: retry.status,
    executionMode: retry.executionMode,
    workspacePath: retry.workspacePath,
    changedFiles: retry.changedFiles,
    retryReview: retry.retryReview,
    taskStatus: task.status,
    historicalFailurePreserved: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(runtimeRoot, { recursive: true, force: true });
}
