import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp(path.join("/private/tmp", "aps005-e2e-"));
const dataRoot = path.join(runtimeRoot, "data");
const host = "127.0.0.1";
const port = 18105;
const baseUrl = `http://${host}:${port}`;
const codexBin = process.env.APS_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const ignored = new Set([".git", ".npm-cache", "data", "dist", "node_modules"]);

async function snapshot(directory = projectRoot, relative = "") {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) {
        const nested = await snapshot(path.join(directory, entry.name), nextRelative);
        nested.forEach((value, key) => result.set(key, value));
      }
    } else if (entry.isFile()) {
      const content = await readFile(path.join(directory, entry.name));
      result.set(nextRelative, createHash("sha256").update(content).digest("hex"));
    }
  }
  return result;
}

function changedFiles(before, after) {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((file) => before.get(file) !== after.get(file)).sort();
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/executions`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
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
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}

const now = new Date().toISOString();
await writeJson(path.join(dataRoot, "sync-events.json"), { events: [{
  id: "aps005-test-prompt-900",
  source: "safari-chatgpt",
  conversationId: "example-public-test",
  turnId: "prompt-900",
  role: "assistant",
  content: "【用户】确认执行 APS 构建验收检测。\n【GPT】请在人工确认后只运行 npm run build。",
  confirmed: false,
  operations: [],
  receivedAt: now,
}] });
await writeJson(path.join(dataRoot, "sync-tasks.json"), { tasks: [] });
await writeJson(path.join(dataRoot, "execution-tasks.json"), { executions: [] });
await writeJson(path.join(dataRoot, "task-drafts.json"), { drafts: [{
  id: "draft-prompt-900",
  promptNumber: 900,
  sourceEventId: "aps005-test-prompt-900",
  sourceContent: "确认执行 APS 构建验收检测",
  isTask: true,
  needsExecution: true,
  project: "APS",
  title: "执行 APS 构建验收检测",
  goal: "确认 Codex 服务重新启动后，可以正常执行 APS 项目任务。",
  type: "testing",
  priority: "high",
  executionSuggestion: "只运行 npm run build，不修改任何源代码文件，返回真实执行结果。",
  acceptanceCriteria: ["npm run build 退出码为 0", "源代码文件没有变化", "真实结果写入 APS 协作记录"],
  reason: "用户明确要求在人工确认后执行构建验收。",
  status: "pending",
  createdAt: now,
  updatedAt: now,
  confirmedAt: null,
  rejectedAt: null,
}, {
  id: "draft-prompt-899",
  promptNumber: 899,
  sourceContent: "以上任务交给 Codex 执行",
  isTask: true,
  needsExecution: true,
  project: "APS",
  title: "将以上任务交由 Codex 执行",
  goal: "执行未解析项目的泛化任务",
  type: "operations",
  priority: "high",
  executionSuggestion: "等待完整上下文",
  acceptanceCriteria: ["完成任务"],
  status: "pending",
  createdAt: now,
  updatedAt: now,
  confirmedAt: null,
  rejectedAt: null,
}] });
await writeJson(path.join(dataRoot, "collaboration-state.json"), {
  approvalStatus: "approved",
  approvedAt: now,
  writebackPolicy: "progress_and_result",
  writebackApprovedAt: now,
  mode: "stopped",
  bridgeStatus: "ready",
  communicationTarget: {
    provider: "chatgpt",
    providerName: "ChatGPT",
    browser: "safari",
    conversationTitle: "派",
    conversationUrl: "https://chatgpt.com/c/example-public-test",
    location: { id: "safari-window-1-tab-1", browser: "safari", windowId: 1, windowIndex: 1, tabIndex: 1, label: "窗口 1 · 标签页 1" },
    configuredAt: now,
  },
});
await writeJson(path.join(dataRoot, "studio-state.json"), { nodes: [], positions: {}, versions: [], updatedAt: now });
await writeJson(path.join(dataRoot, "safari-sync-checkpoint.json"), { lastPromptNumber: 900, collaborationMode: "paused" });

const before = await snapshot();
const server = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    APS_RUNTIME_DIR: runtimeRoot,
    APS_PROJECT_ROOT: projectRoot,
    APS_CODEX_BIN: codexBin,
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
  const beforeConfirmExecutions = (await getJson("/api/executions")).executions;
  if (beforeConfirmExecutions.length !== 0) throw new Error("execution_created_before_confirmation");
  const unsupportedResponse = await fetch(`${baseUrl}/api/task-drafts/draft-prompt-899/confirm`, { method: "POST" });
  const unsupportedPayload = await unsupportedResponse.json();
  if (unsupportedResponse.status !== 409 || unsupportedPayload.error !== "unsupported_execution_workspace") {
    throw new Error(`unsupported_workspace_gate_failed:${unsupportedResponse.status}:${JSON.stringify(unsupportedPayload)}`);
  }
  if ((await getJson("/api/executions")).executions.length !== 0 || unsupportedPayload.draft.status !== "pending") {
    throw new Error("unsupported_workspace_was_dispatched");
  }
  const confirmResponse = await fetch(`${baseUrl}/api/task-drafts/draft-prompt-900/confirm`, { method: "POST" });
  const confirmPayload = await confirmResponse.json();
  if (confirmResponse.status !== 202 || !confirmPayload.queuedForExecution) {
    throw new Error(`confirm_failed:${confirmResponse.status}:${JSON.stringify(confirmPayload)}`);
  }

  let execution;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    execution = (await getJson("/api/executions")).executions[0];
    if (["completed", "failed"].includes(execution?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!execution || execution.status !== "completed" || execution.exitCode !== 0) {
    throw new Error(`execution_not_completed:${JSON.stringify(execution)}`);
  }

  const expectedHistory = ["confirmed", "dispatching", "running", "testing", "completed"];
  const actualHistory = execution.statusHistory.map((item) => item.status);
  if (JSON.stringify(actualHistory) !== JSON.stringify(expectedHistory)) {
    throw new Error(`status_history_mismatch:${actualHistory.join(",")}`);
  }

  const duplicateResponse = await fetch(`${baseUrl}/api/task-drafts/draft-prompt-900/confirm`, { method: "POST" });
  const duplicatePayload = await duplicateResponse.json();
  const executions = (await getJson("/api/executions")).executions;
  if (duplicateResponse.status !== 200 || duplicatePayload.duplicate !== true || executions.length !== 1) {
    throw new Error(`idempotency_failed:${duplicateResponse.status}:${executions.length}`);
  }

  const draft = (await getJson("/api/task-drafts")).drafts[0];
  const task = (await getJson("/api/sync/tasks")).tasks.find((item) => item.promptNumber === 900);
  const events = (await getJson("/api/sync/events")).events;
  const after = await snapshot();
  const changed = changedFiles(before, after);
  const sevenStages = ["listened", "parsed", "taskCreated", "confirmed", "dispatched", "codex", "returned"];
  if (draft.status !== "completed" || sevenStages.some((stage) => task.steps[stage].status !== "success")) {
    throw new Error(`persistence_failed:${draft.status}:${JSON.stringify(task.steps)}`);
  }
  if (!events.some((event) => event.id === "execution-draft-prompt-900-completed")) {
    throw new Error("result_event_missing");
  }
  if (!execution.testingAt || execution.testResult?.build !== "success" || execution.testResult?.status !== "passed") {
    throw new Error(`execution_evidence_missing:${JSON.stringify(execution.testResult)}`);
  }
  if (!execution.fileChanges || ["added", "modified", "deleted"].some((kind) => !Array.isArray(execution.fileChanges[kind]))) {
    throw new Error(`file_change_classification_missing:${JSON.stringify(execution.fileChanges)}`);
  }
  if (changed.length) throw new Error(`source_changed:${changed.join(",")}`);

  const approvalResponse = await fetch(`${baseUrl}/api/collaboration/approval`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, writebackPolicy: "progress_and_result" }),
  });
  if (!approvalResponse.ok) throw new Error(`simulation_approval_failed:${approvalResponse.status}`);
  const startResponse = await fetch(`${baseUrl}/api/collaboration/start`, { method: "POST" });
  if (startResponse.status !== 202) throw new Error(`simulation_start_failed:${startResponse.status}`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await getJson("/api/collaboration/status")).processRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stopResponse = await fetch(`${baseUrl}/api/collaboration/stop`, { method: "POST" });
  if (!stopResponse.ok) throw new Error(`simulation_stop_failed:${stopResponse.status}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stoppedCollaboration = await getJson("/api/collaboration/status");
  const stoppedCheckpoint = await getJson("/api/sync/checkpoint");
  if (stoppedCollaboration.mode !== "stopped" || stoppedCollaboration.processRunning || stoppedCollaboration.lastError !== null) {
    throw new Error(`collaboration_stop_state_failed:${JSON.stringify(stoppedCollaboration)}`);
  }
  if (stoppedCheckpoint.collaborationMode !== "paused" || stoppedCheckpoint.bridgeStatus !== "paused_by_user" || stoppedCheckpoint.lastError !== null) {
    throw new Error(`checkpoint_stop_state_failed:${JSON.stringify(stoppedCheckpoint)}`);
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    executionCountBeforeConfirm: beforeConfirmExecutions.length,
    unsupportedWorkspaceConfirmStatus: unsupportedResponse.status,
    confirmStatus: confirmResponse.status,
    executionId: execution.id,
    statusHistory: actualHistory,
    exitCode: execution.exitCode,
    testResult: execution.testResult,
    fileChanges: execution.fileChanges,
    duplicateConfirmStatus: duplicateResponse.status,
    executionCount: executions.length,
    draftStatus: draft.status,
    sevenStages: Object.fromEntries(sevenStages.map((stage) => [stage, task.steps[stage].status])),
    resultEventPersisted: true,
    sourceFilesChanged: changed,
    bridgeStopState: {
      mode: stoppedCollaboration.mode,
      processRunning: stoppedCollaboration.processRunning,
      checkpointStatus: stoppedCheckpoint.bridgeStatus,
      checkpointError: stoppedCheckpoint.lastError,
    },
    runtimeRoot,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(runtimeRoot, { recursive: true, force: true });
}
