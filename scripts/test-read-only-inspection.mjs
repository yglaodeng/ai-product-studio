import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp("/private/tmp/aps-read-only-inspection-");
const dataRoot = path.join(runtimeRoot, "data");
const workspaceRoot = path.join(runtimeRoot, "AI 数据工作台");
const fakeCodex = path.join(runtimeRoot, "fake-codex.mjs");
const host = "127.0.0.1";
const port = 18112;
const baseUrl = `http://${host}:${port}`;
const token = "aps-read-only-inspection-token";
const evidence = "检查完成：存在 V1.0 架构文档，全程只读，项目文件零变化。";

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function requestJson(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/projects`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test_server_not_ready");
}

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { response, payload } = await requestJson(`/api/executions/${executionId}`);
    if (!response.ok) throw new Error(`execution_read_failed:${response.status}`);
    if (["completed", "failed"].includes(payload.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("execution_timeout");
}

await mkdir(dataRoot, { recursive: true });
await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
await writeFile(path.join(workspaceRoot, "docs", "AI_DATA_WORKBENCH_V1_ARCHITECTURE.md"), "# V1.0\n", "utf8");
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
for (const file of ["sync-events.json", "sync-tasks.json", "task-drafts.json", "execution-tasks.json", "studio-state.json", "safari-sync-checkpoint.json", "collaboration-state.json", "writeback-outbox.json"]) {
  const value = file === "task-drafts.json" ? { drafts: [] }
    : file === "execution-tasks.json" ? { executions: [] }
      : file === "sync-events.json" ? { events: [] }
        : file === "sync-tasks.json" ? { tasks: [] }
          : file === "writeback-outbox.json" ? { writebacks: [] }
            : {};
  await writeJson(path.join(dataRoot, file), value);
}

await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const outputFile = args[args.indexOf("-o") + 1];
const sandbox = args[args.indexOf("--sandbox") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (sandbox !== "read-only") process.exit(2);
if (!prompt.includes("Perform only the confirmed read-only inspection")) process.exit(3);
process.stderr.write("tracking_refreshed updated=48 errors=[]\\n");
await writeFile(outputFile, ${JSON.stringify(evidence)}, "utf8");
`, "utf8");
await chmod(fakeCodex, 0o755);

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
    APS_BRIDGE_INTERNAL_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitForServer();
  const sourceContent = "【用户】刚才不行的问题修复了,再发一个\n\n【GPT】请执行 AI Data Workbench 项目文档完整性检查。检查当前项目是否包含 V1.0 架构文档，并返回检查结果。只读取文件状态，不修改任何文件。";
  const created = await requestJson("/api/task-drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      promptNumber: 946,
      sourceContent,
      original_message: "刚才不行的问题修复了,再发一个",
      isTask: true,
      task_generated: true,
      intent_type: "execution_task",
      target_object: "codex",
      project: "AI 数据工作台",
      title: "检查 V1.0 架构文档完整性",
      goal: "只读确认当前项目是否包含 V1.0 架构文档",
      type: "testing",
      priority: "medium",
      executionSuggestion: "只读检查文件目录和文档内容，不得创建、修改或删除任何文件。",
      acceptanceCriteria: ["返回真实检查结果", "项目文件零变化"],
      reason: "受控只读文档完整性检查",
    }),
  });
  if (!created.response.ok) throw new Error(`draft_create_failed:${created.response.status}`);
  const saved = await requestJson("/api/task-drafts/draft-prompt-946", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "AI 数据工作台", priority: "medium" }),
  });
  if (!saved.response.ok) throw new Error(`draft_save_failed:${saved.response.status}`);
  const confirmed = await requestJson("/api/task-drafts/draft-prompt-946/confirm", { method: "POST" });
  if (confirmed.response.status !== 202) throw new Error(`confirm_failed:${confirmed.response.status}:${JSON.stringify(confirmed.payload)}`);
  const execution = await waitForExecution(confirmed.payload.executionId);
  if (execution.status !== "completed" || execution.executionMode !== "read_only_inspection") {
    throw new Error(`inspection_failed:${JSON.stringify(execution)}`);
  }
  if (execution.changedFiles.length !== 0 || execution.result !== evidence || execution.testResult?.status !== "passed" || execution.testResult?.consoleErrors !== null) {
    throw new Error("inspection_evidence_invalid");
  }
  process.stdout.write(`${JSON.stringify({
    passed: true,
    executionMode: execution.executionMode,
    status: execution.status,
    exitCode: execution.exitCode,
    changedFiles: execution.changedFiles,
    testResult: execution.testResult,
    result: execution.result,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(runtimeRoot, { recursive: true, force: true });
}
