import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWritebackRecord, extractWritebackId, makeWritebackId } from "../writeback.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp(path.join("/private/tmp", "aps-writeback-e2e-"));
const dataRoot = path.join(runtimeRoot, "data");
const host = "127.0.0.1";
const port = 18113;
const baseUrl = `http://${host}:${port}`;
const now = new Date().toISOString();
const target = {
  provider: "chatgpt",
  providerName: "ChatGPT",
  browser: "safari",
  conversationTitle: "派",
  conversationUrl: "https://chatgpt.com/c/example-public-test",
  location: { id: "safari-window-22-tab-1", browser: "safari", windowId: 22, windowIndex: 2, tabIndex: 1, label: "窗口 2 · 标签页 1" },
  configuredAt: now,
};

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitFor(predicate, label, attempts = 600) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout:${label}`);
}

const helperExecution = { id: "execution-draft-prompt-990", promptNumber: 990, project: "APS", title: "回传测试", status: "completed", exitCode: 0 };
const helperRecord = createWritebackRecord(helperExecution, "result", target, now);
if (helperRecord.id !== makeWritebackId(helperExecution.id, "result") || extractWritebackId(helperRecord.content) !== helperRecord.id) {
  throw new Error("writeback_helper_roundtrip_failed");
}

await mkdir(dataRoot, { recursive: true });
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
await writeJson(path.join(dataRoot, "sync-events.json"), { events: [] });
await writeJson(path.join(dataRoot, "sync-tasks.json"), { tasks: [] });
await writeJson(path.join(dataRoot, "execution-tasks.json"), { executions: [] });
await writeJson(path.join(dataRoot, "writeback-outbox.json"), { version: 1, messages: [] });
await writeJson(path.join(dataRoot, "task-drafts.json"), { drafts: [{
  id: "draft-prompt-990",
  promptNumber: 990,
  sourceContent: "确认执行 APS 构建验收检测",
  original_message: "确认执行 APS 构建验收检测",
  isTask: true,
  needsExecution: true,
  task_generated: true,
  intent_type: "execution_task",
  target_object: "codex",
  project: "APS",
  title: "执行 APS 构建验收检测",
  goal: "验证回传闭环",
  type: "testing",
  priority: "high",
  executionSuggestion: "只运行 npm run build，不修改源代码。",
  acceptanceCriteria: ["退出码为 0", "结果回传 GPT"],
  reason: "隔离回传测试",
  status: "pending",
  createdAt: now,
  updatedAt: now,
  confirmedAt: null,
  rejectedAt: null,
}] });
await writeJson(path.join(dataRoot, "collaboration-state.json"), {
  version: 2,
  approvalStatus: "pending",
  approvedAt: null,
  mode: "stopped",
  bridgeStatus: "ready_for_review",
  communicationTarget: target,
});
await writeJson(path.join(dataRoot, "safari-sync-checkpoint.json"), { lastPromptNumber: 989, collaborationMode: "paused", bridgeStatus: "paused_by_user" });
await writeJson(path.join(dataRoot, "studio-state.json"), { nodes: [], positions: {}, versions: [], updatedAt: now });

const server = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    APS_RUNTIME_DIR: runtimeRoot,
    APS_PROJECT_ROOT: projectRoot,
    APS_HOST: host,
    APS_PORT: String(port),
    APS_BRIDGE_SIMULATION: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverExited = false;
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitFor(async () => fetch(`${baseUrl}/api/collaboration/status`).then((response) => response.ok).catch(() => false), "server_ready", 100);
  const unapprovedStart = await request("/api/collaboration/start", { method: "POST" });
  if (unapprovedStart.response.status !== 409 || unapprovedStart.payload.error !== "approval_required") throw new Error("approval_gate_failed");
  const missingPolicy = await request("/api/collaboration/approval", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true }),
  });
  if (missingPolicy.response.status !== 400 || missingPolicy.payload.error !== "writeback_policy_approval_required") throw new Error("writeback_policy_gate_failed");
  const approved = await request("/api/collaboration/approval", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, writebackPolicy: "progress_and_result" }),
  });
  if (!approved.response.ok || approved.payload.writebackPolicy !== "progress_and_result") throw new Error("writeback_approval_failed");
  const started = await request("/api/collaboration/start", { method: "POST" });
  if (started.response.status !== 202) throw new Error(`bridge_start_failed:${JSON.stringify(started.payload)}`);
  await waitFor(async () => (await request("/api/collaboration/status")).payload.processRunning, "bridge_running");

  const confirmed = await request("/api/task-drafts/draft-prompt-990/confirm", { method: "POST" });
  if (confirmed.response.status !== 202) throw new Error(`confirm_failed:${JSON.stringify(confirmed.payload)}`);
  const execution = await waitFor(async () => {
    const executions = (await request("/api/executions")).payload.executions;
    return executions.find((item) => item.status === "completed") ?? null;
  }, "execution_completed", 1200);
  if (execution.exitCode !== 0) throw new Error(`execution_failed:${execution.error}`);

  const messages = await waitFor(async () => {
    const current = (await request("/api/writebacks")).payload.messages;
    return current.length === 2 && current.every((item) => item.status === "acknowledged") ? current : null;
  }, "writebacks_acknowledged", 200);
  const ids = new Set(messages.map((item) => item.id));
  if (ids.size !== 2 || !ids.has(makeWritebackId(execution.id, "progress")) || !ids.has(makeWritebackId(execution.id, "result"))) {
    throw new Error(`writeback_idempotency_failed:${JSON.stringify(messages)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 800));
  const stableMessages = (await request("/api/writebacks")).payload.messages;
  if (stableMessages.length !== 2) throw new Error("duplicate_writeback_created");
  const writebackAckEvent = await request("/api/sync/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "writeback-ack-regression-prompt-991",
      source: "gpt-writeback-ack",
      turnId: "prompt-991",
      content: "GPT 已回应 APS 回传消息。",
    }),
  });
  if (writebackAckEvent.response.status !== 202) throw new Error("writeback_ack_event_failed");
  const syncTasks = (await request("/api/sync/tasks")).payload.tasks;
  if (syncTasks.some((item) => item.promptNumber === 991)) throw new Error("writeback_ack_created_blank_task");
  await request("/api/collaboration/stop", { method: "POST" });
  const stopped = (await request("/api/collaboration/status")).payload;
  if (stopped.writebackPolicy !== "disabled" || stopped.writebackApprovedAt !== null) throw new Error("writeback_authorization_not_revoked");

  await request("/api/collaboration/approval", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, writebackPolicy: "progress_and_result" }),
  });
  const restartStarted = await request("/api/collaboration/start", { method: "POST" });
  if (restartStarted.response.status !== 202) throw new Error("restart_revocation_setup_failed");
  await waitFor(async () => (await request("/api/collaboration/status")).payload.processRunning, "restart_bridge_running");
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  serverExited = true;
  const persistedAfterSignal = JSON.parse(await readFile(path.join(dataRoot, "collaboration-state.json"), "utf8"));
  if (
    persistedAfterSignal.mode !== "stopped"
    || persistedAfterSignal.writebackPolicy !== "disabled"
    || persistedAfterSignal.writebackApprovedAt !== null
  ) throw new Error("writeback_authorization_not_revoked_on_sigterm");

  process.stdout.write(`${JSON.stringify({ passed: true, executionId: execution.id, writebacks: messages.map((item) => ({ id: item.id, status: item.status, attempts: item.attempts })), authorizationRevokedOnStop: true, authorizationRevokedOnSigterm: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  if (!serverExited && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(runtimeRoot, { recursive: true, force: true });
}
