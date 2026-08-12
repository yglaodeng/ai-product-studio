import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp("/private/tmp/aps008-");
const dataRoot = path.join(runtimeRoot, "data");
const workspaceRoot = path.join(runtimeRoot, "AI 数据工作台");
const documentRelativePath = "docs/AI_DATA_WORKBENCH_V1_ARCHITECTURE.md";
const documentContent = "# AI 数据工作台 V1 架构\n\n完整架构评审内容。\n";
const fakeCodex = path.join(runtimeRoot, "fake-codex.mjs");
const host = "127.0.0.1";
const port = 18108;
const baseUrl = `http://${host}:${port}`;
const token = "aps008-test-token";

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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const { response, payload } = await requestJson(`/api/executions/${executionId}`);
    if (!response.ok) throw new Error(`execution_read_failed:${response.status}`);
    if (["completed", "failed"].includes(payload.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("execution_timeout");
}

await mkdir(dataRoot, { recursive: true });
await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
await writeFile(path.join(workspaceRoot, documentRelativePath), documentContent, "utf8");
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
for (const file of ["sync-events.json", "sync-tasks.json", "task-drafts.json", "execution-tasks.json", "studio-state.json", "safari-sync-checkpoint.json", "collaboration-state.json"]) {
  await writeJson(path.join(dataRoot, file), file === "task-drafts.json" ? { drafts: [] } : file === "execution-tasks.json" ? { executions: [] } : file === "sync-events.json" ? { events: [] } : file === "sync-tasks.json" ? { tasks: [] } : {});
}

await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const sandboxIndex = args.indexOf("--sandbox");
const outputFile = args[outputIndex + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (args[sandboxIndex + 1] !== "read-only") process.exit(2);
if (!prompt.includes("${documentRelativePath}") || !prompt.includes("Do not read any other file")) process.exit(3);
const content = await readFile("${documentRelativePath}", "utf8");
await writeFile(outputFile, content, "utf8");
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

try {
  await waitForServer();
  const projectsResult = await requestJson("/api/projects");
  if (!projectsResult.response.ok || projectsResult.payload.projects.length !== 2) throw new Error("project_registry_missing");
  const workbench = projectsResult.payload.projects.find((project) => project.name === "AI 数据工作台");
  if (workbench?.path !== workspaceRoot || !workbench.allowedExecutionScopes.includes("read_document")) throw new Error("workbench_registration_invalid");

  const exactTask = {
    promptNumber: 908,
    sourceContent: "【用户】请读取 AI_DATA_WORKBENCH_V1_ARCHITECTURE.md 文档，并返回完整内容，用于产品架构评审。不修改任何文件。",
    original_message: "请读取 AI_DATA_WORKBENCH_V1_ARCHITECTURE.md 文档，并返回完整内容，用于产品架构评审。不修改任何文件。",
    isTask: true,
    task_generated: true,
    intent_type: "execution_task",
    target_object: "codex",
    project: "AI Product Studio",
    title: "读取 AI 数据工作台架构文档",
    goal: "返回完整架构文档供评审",
    type: "documentation",
    executionSuggestion: "只读取并返回完整内容，不修改任何文件",
    acceptanceCriteria: ["返回完整原文", "项目文件零改动"],
    reason: "用户明确要求读取指定文档",
  };
  const created = await requestJson("/api/task-drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(exactTask),
  });
  if (!created.response.ok || created.payload.draft.project !== "AI 数据工作台") throw new Error("automatic_project_match_failed");

  const saved = await requestJson("/api/task-drafts/draft-prompt-908", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...created.payload.draft, priority: "high" }),
  });
  if (!saved.response.ok) throw new Error(`draft_save_failed:${saved.response.status}`);
  const confirmed = await requestJson("/api/task-drafts/draft-prompt-908/confirm", { method: "POST" });
  if (confirmed.response.status !== 202 || !confirmed.payload.executionId) throw new Error(`confirm_failed:${confirmed.response.status}`);
  const execution = await waitForExecution(confirmed.payload.executionId);
  if (execution.status !== "completed") throw new Error(`execution_failed:${execution.error}`);
  if (execution.executionMode !== "read_document" || execution.workspacePath !== workspaceRoot) throw new Error("execution_workspace_mismatch");
  if (execution.result !== documentContent || execution.changedFiles.length !== 0) throw new Error("read_result_or_source_protection_failed");

  const ambiguous = await requestJson("/api/task-drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...exactTask,
      promptNumber: 909,
      sourceContent: "【用户】右侧这部分要可折叠/打开,选择\n\n【GPT】这个属于 APS-011/012 后续体验优化。",
      original_message: "右侧这部分要可折叠/打开,选择",
      project: "AI Product Studio",
      title: "右侧区域增加折叠与选择交互",
    }),
  });
  if (!ambiguous.response.ok || ambiguous.payload.draft.project !== "") throw new Error("ambiguous_project_should_require_selection");
  const invalidSelection = await requestJson("/api/task-drafts/draft-prompt-909", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "未注册项目" }),
  });
  if (invalidSelection.response.status !== 409 || invalidSelection.payload.error !== "unregistered_project") throw new Error("unregistered_project_not_blocked");
  const manualSelection = await requestJson("/api/task-drafts/draft-prompt-909", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "AI 数据工作台" }),
  });
  if (!manualSelection.response.ok || manualSelection.payload.draft.project !== "AI 数据工作台") throw new Error("manual_project_selection_failed");

  const multipleProjects = await requestJson("/api/task-drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...exactTask,
      promptNumber: 910,
      sourceContent: "【用户】请检查 APS 与 AI 数据工作台之间的任务归属。",
      original_message: "请检查 APS 与 AI 数据工作台之间的任务归属。",
      title: "检查跨项目任务归属",
    }),
  });
  if (!multipleProjects.response.ok || multipleProjects.payload.draft.project !== "") throw new Error("multiple_projects_should_require_selection");

  process.stdout.write(`${JSON.stringify({
    projects: projectsResult.payload.projects.map((project) => project.name),
    automaticProject: created.payload.draft.project,
    executionMode: execution.executionMode,
    workspacePath: execution.workspacePath,
    resultBytes: Buffer.byteLength(execution.result),
    changedFiles: execution.changedFiles,
    ambiguousProject: ambiguous.payload.draft.project,
    multipleProjects: multipleProjects.payload.draft.project,
    unregisteredBlocked: true,
    manualProject: manualSelection.payload.draft.project,
  }, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(runtimeRoot, { recursive: true, force: true });
}
