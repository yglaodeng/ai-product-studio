import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collaborationModels,
  communicationTargetKey,
  defaultCommunicationTarget,
  normalizeCommunicationTarget,
} from "./conversation-target.mjs";
import { getContextualExecutionApproval, getDelegatedExecutionApproval, isSystemValidationRequest } from "./intent-classifier.mjs";
import { createWritebackRecord, writebackTargetMatches } from "./writeback.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = process.env.APS_RUNTIME_DIR || moduleRoot;
const staticRoot = path.join(runtimeRoot, "dist");
const dataRoot = path.join(runtimeRoot, "data");
const eventsFile = path.join(dataRoot, "sync-events.json");
const tasksFile = path.join(dataRoot, "sync-tasks.json");
const taskDraftsFile = path.join(dataRoot, "task-drafts.json");
const executionsFile = path.join(dataRoot, "execution-tasks.json");
const studioStateFile = path.join(dataRoot, "studio-state.json");
const checkpointFile = path.join(dataRoot, "safari-sync-checkpoint.json");
const collaborationFile = path.join(dataRoot, "collaboration-state.json");
const writebackFile = path.join(dataRoot, "writeback-outbox.json");
const bridgeWorkerFile = path.join(runtimeRoot, "bridge-worker.mjs");
const codexSchemaFile = path.join(runtimeRoot, "codex-result-schema.json");
const projectRegistryFile = path.join(runtimeRoot, "project-registry.json");
const projectRoot = process.env.APS_PROJECT_ROOT || moduleRoot;
const projectRegistry = (() => {
  const configured = JSON.parse(readFileSync(projectRegistryFile, "utf8"));
  const projects = configured.projects.map((project) => ({
    ...project,
    path: project.id === "ai-product-studio"
      ? projectRoot
      : project.id === "ai-data-workbench" && process.env.APS_AI_DATA_WORKBENCH_ROOT
        ? process.env.APS_AI_DATA_WORKBENCH_ROOT
        : path.isAbsolute(project.path) ? project.path : path.resolve(moduleRoot, project.path),
  }));
  return { ...configured, projects };
})();
const codexBin = process.env.APS_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const host = process.env.APS_HOST || "127.0.0.5";
const port = Number(process.env.APS_PORT || 8005);
const clients = new Set();
const bridgeInternalToken = process.env.APS_BRIDGE_INTERNAL_TOKEN || randomUUID();
let bridgeProcess = null;
let executionProcess = null;
let activeExecutionId = null;
let executionPumpRunning = false;
let shuttingDown = false;

function normalizeProjectKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN").replace(/[\s_-]+/g, "");
}

function registeredProject(value) {
  const key = normalizeProjectKey(value);
  if (!key) return null;
  return projectRegistry.projects.find((project) => [project.name, ...(project.aliases ?? [])].some((alias) => normalizeProjectKey(alias) === key)) ?? null;
}

function inferRegisteredProject(text) {
  const source = String(text ?? "");
  const matches = [];
  if (/AI\s*(?:数据工作台|Data\s*Workbench)|AI_DATA_WORKBENCH/i.test(source)) matches.push(registeredProject("AI 数据工作台")?.name);
  if (/(?:^|[^A-Za-z])APS(?:[^A-Za-z]|$)|AI Product Studio/i.test(source)) matches.push(registeredProject("AI Product Studio")?.name);
  const projects = matches.filter(Boolean);
  return projects.length === 1 ? projects[0] : "";
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    description: project.description,
    status: project.status,
    allowedExecutionScopes: project.allowedExecutionScopes,
  };
}

const defaultCollaborationState = {
  version: 2,
  approvalStatus: "pending",
  approvedAt: null,
  mode: "stopped",
  bridgeStatus: "ready_for_review",
  sessionId: null,
  sessionStartedAt: null,
  sessionStoppedAt: null,
  lastActivityAt: null,
  activePromptNumber: null,
  lastError: null,
  conversationTitle: "请配置会话",
  conversationUrl: "",
  communicationTarget: defaultCommunicationTarget,
  executionScope: "registered-projects",
  writebackPolicy: "disabled",
  writebackApprovedAt: null,
};

const safariLocationScript = `
on run argv
  set targetUrl to item 1 of argv
  set browserJavascript to item 2 of argv
  tell application "System Events" to set safariRunning to exists process "Safari"
  if safariRunning is false then return "{\\\"error\\\":\\\"safari_not_running\\\"}"
  set matchingPayloads to {}
  tell application "Safari"
    set windowCounter to 0
    repeat with browserWindow in windows
      set windowCounter to windowCounter + 1
      set tabCounter to 0
      repeat with browserTab in tabs of browserWindow
        set tabCounter to tabCounter + 1
        if (URL of browserTab) is targetUrl then
          set pagePayload to do JavaScript browserJavascript in browserTab
          set windowIdentifier to id of browserWindow
          set currentMarker to false
          try
            set currentMarker to (browserTab is current tab of browserWindow)
          end try
          set frontMarker to windowCounter is 1
          set wrapper to "{\\\"windowId\\\":" & (windowIdentifier as text) & ",\\\"windowIndex\\\":" & (windowCounter as text) & ",\\\"tabIndex\\\":" & (tabCounter as text) & ",\\\"isFrontWindow\\\":" & (frontMarker as text) & ",\\\"isCurrentTab\\\":" & (currentMarker as text) & ",\\\"page\\\":" & pagePayload & "}"
          set end of matchingPayloads to wrapper
        end if
      end repeat
    end repeat
  end tell
  if (count of matchingPayloads) is 0 then return "[]"
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to ","
  set joinedPayloads to matchingPayloads as text
  set AppleScript's text item delimiters to previousDelimiters
  return "[" & joinedPayloads & "]"
end run`;

const safariLocationJavascript = `(() => {
  const promptNumbers = [...document.querySelectorAll('button[aria-label^="Prompt "]')]
    .map((button) => Number((button.getAttribute('aria-label') || '').match(/Prompt (\\d+)/)?.[1]))
    .filter(Number.isFinite);
  return JSON.stringify({
    title: document.title,
    url: location.href,
    maxPromptNumber: promptNumbers.length ? Math.max(...promptNumbers) : null,
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
  });
})()`;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonIfChanged(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(file, "utf8").catch(() => "");
  if (current === next) return false;
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, next, "utf8");
  await rename(temporaryFile, file);
  return true;
}

async function readCollaborationState() {
  const stored = await readJson(collaborationFile, {});
  const communicationTarget = {
    ...defaultCommunicationTarget,
    ...(stored.communicationTarget ?? {}),
    location: stored.communicationTarget?.location ?? null,
  };
  return {
    ...defaultCollaborationState,
    ...stored,
    version: 2,
    conversationTitle: communicationTarget.conversationTitle,
    conversationUrl: communicationTarget.conversationUrl,
    communicationTarget,
    executionScope: "registered-projects",
  };
}

async function writeCollaborationState(patch) {
  const current = await readCollaborationState();
  const next = {
    ...current,
    ...patch,
    ...(patch.communicationTarget ? {
      communicationTarget: { ...current.communicationTarget, ...patch.communicationTarget },
    } : {}),
  };
  await writeJsonIfChanged(collaborationFile, next);
  return next;
}

function runReadOnlyProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`process_failed:${command}:${code ?? signal}:${stderr.slice(-800)}`));
    });
  });
}

async function discoverSafariLocations(target) {
  let stdout;
  try {
    ({ stdout } = await runReadOnlyProcess("/usr/bin/osascript", ["-e", safariLocationScript, target.conversationUrl, safariLocationJavascript]));
  } catch (error) {
    if (error.message.includes("Allow JavaScript from Apple Events")) throw Object.assign(new Error("safari_javascript_disabled"), { statusCode: 409 });
    throw error;
  }
  const parsed = JSON.parse(stdout.trim() || "[]");
  if (parsed?.error) throw Object.assign(new Error(parsed.error), { statusCode: 409 });
  return parsed.map((item) => ({
    id: `safari-window-${item.windowId}-tab-${item.tabIndex}`,
    browser: "safari",
    windowId: item.windowId,
    windowIndex: item.windowIndex,
    tabIndex: item.tabIndex,
    label: `窗口 ${item.windowIndex} · 标签页 ${item.tabIndex}`,
    title: item.page?.title ?? target.conversationTitle,
    conversationUrl: item.page?.url ?? target.conversationUrl,
    isFrontWindow: item.isFrontWindow === true,
    isCurrentTab: item.isCurrentTab === true,
    hasFocus: item.page?.hasFocus === true,
    visibilityState: item.page?.visibilityState ?? "unknown",
    maxPromptNumber: Number.isInteger(item.page?.maxPromptNumber) ? item.page.maxPromptNumber : null,
  }));
}

const waitingSteps = () => ({
  listened: { status: "waiting", at: null },
  parsed: { status: "waiting", at: null },
  taskCreated: { status: "waiting", at: null },
  confirmed: { status: "waiting", at: null },
  dispatched: { status: "waiting", at: null },
  codex: { status: "waiting", at: null },
  returned: { status: "waiting", at: null },
});

function promptNumberOf(value) {
  const match = String(value ?? "").match(/prompt-(\d+)/);
  return match ? Number(match[1]) : null;
}

function deriveTasksFromEvents(events) {
  const tasks = new Map();
  for (const event of events) {
    if (event.source !== "safari-chatgpt" && event.source !== "codex-aps") continue;
    const promptNumber = promptNumberOf(event.turnId) ?? promptNumberOf(event.id);
    if (!Number.isInteger(promptNumber)) continue;
    const taskId = `prompt-${promptNumber}`;
    const current = tasks.get(taskId) ?? {
      id: taskId,
      promptNumber,
      source: "safari-chatgpt",
      message: "",
      confirmed: false,
      status: "waiting",
      result: null,
      error: null,
      errors: [],
      createdAt: event.receivedAt,
      updatedAt: event.receivedAt,
      steps: waitingSteps(),
    };
    if (event.source === "safari-chatgpt") {
      current.message = event.content;
      current.confirmed = event.confirmed === true;
      current.createdAt = event.receivedAt;
      current.steps.listened = { status: "success", at: event.receivedAt };
      current.steps.parsed = { status: "success", at: event.receivedAt };
      current.steps.taskCreated = event.confirmed
        ? { status: "success", at: event.receivedAt }
        : { status: "waiting", at: null, detail: "普通讨论，未生成执行任务" };
      current.steps.confirmed = event.confirmed
        ? { status: "success", at: event.receivedAt }
        : { status: "waiting", at: null };
    }
    if (event.source === "codex-aps") {
      const failed = /【Codex failed】/i.test(event.content);
      const completed = /【Codex completed】/i.test(event.content);
      current.confirmed = true;
      current.steps.taskCreated = { status: "success", at: current.steps.taskCreated.at ?? event.receivedAt };
      current.steps.confirmed = { status: "success", at: current.steps.confirmed?.at ?? event.receivedAt };
      current.steps.dispatched = { status: "success", at: event.receivedAt };
      current.steps.codex = { status: failed ? "failed" : completed ? "success" : "running", at: event.receivedAt };
      current.steps.returned = { status: "success", at: event.receivedAt };
      current.status = failed ? "failed" : completed ? "success" : "running";
      current.result = event.content;
      if (failed) {
        current.error = event.content.replace(/^【Codex failed】/i, "").trim();
        current.errors.push(current.error);
      } else if (completed) {
        current.error = null;
        current.errors = [];
      }
    }
    current.updatedAt = event.receivedAt;
    tasks.set(taskId, current);
  }
  return [...tasks.values()];
}

async function readSyncTasks() {
  const eventPayload = await readJson(eventsFile, { events: [] });
  const persisted = await readJson(tasksFile, { tasks: [] });
  const merged = new Map(deriveTasksFromEvents(eventPayload.events).map((task) => [task.id, task]));
  for (const task of persisted.tasks) {
    const derived = merged.get(task.id);
    merged.set(task.id, {
      ...derived,
      ...task,
      steps: { ...(derived?.steps ?? waitingSteps()), ...(task.steps ?? {}) },
      errors: [...new Set([...(derived?.errors ?? []), ...(task.errors ?? [])])],
    });
  }
  return { tasks: [...merged.values()].sort((a, b) => a.promptNumber - b.promptNumber) };
}

async function patchSyncTask(promptNumber, patch) {
  const merged = await readSyncTasks();
  const current = merged.tasks.find((task) => task.promptNumber === promptNumber);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    steps: { ...current.steps, ...(patch.steps ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const persisted = await readJson(tasksFile, { tasks: [] });
  const index = persisted.tasks.findIndex((task) => task.promptNumber === promptNumber);
  if (index >= 0) persisted.tasks[index] = next;
  else persisted.tasks.push(next);
  await writeJsonIfChanged(tasksFile, persisted);
  return next;
}

async function readTaskDrafts() {
  return readJson(taskDraftsFile, { drafts: [] });
}

async function saveTaskDraft(draft) {
  const payload = await readTaskDrafts();
  const index = payload.drafts.findIndex((item) => item.id === draft.id);
  if (index >= 0) payload.drafts[index] = draft;
  else payload.drafts.push(draft);
  await writeJsonIfChanged(taskDraftsFile, payload);
  return draft;
}

async function readExecutions() {
  return readJson(executionsFile, { executions: [] });
}

async function readWritebacks() {
  const payload = await readJson(writebackFile, { version: 1, messages: [] });
  return {
    version: 1,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
  };
}

async function saveWritebacks(payload) {
  await writeJsonIfChanged(writebackFile, { version: 1, messages: payload.messages });
  return payload;
}

async function enqueueExecutionWriteback(execution, kind) {
  const collaboration = await readCollaborationState();
  if (collaboration.mode !== "running" || collaboration.writebackPolicy !== "progress_and_result") return null;
  const target = collaboration.communicationTarget;
  if (!target?.location) return null;
  const payload = await readWritebacks();
  const candidate = createWritebackRecord(execution, kind, target);
  const existing = payload.messages.find((item) => item.id === candidate.id);
  if (existing) return existing;
  payload.messages.push(candidate);
  await saveWritebacks(payload);
  return candidate;
}

async function updateWriteback(id, status, patch = {}) {
  const payload = await readWritebacks();
  const index = payload.messages.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const current = payload.messages[index];
  const now = new Date().toISOString();
  const history = [...(current.statusHistory ?? [])];
  if (history.at(-1)?.status !== status) history.push({ status, at: now, detail: patch.detail ?? null });
  const next = {
    ...current,
    ...patch,
    status,
    updatedAt: now,
    statusHistory: history,
    ...(status === "sending" ? { attempts: Number(current.attempts ?? 0) + 1, error: null } : {}),
    ...(status === "sent" ? { sentAt: current.sentAt ?? now, verifiedAt: now, error: null } : {}),
    ...(status === "acknowledged" ? { acknowledgedAt: current.acknowledgedAt ?? now, error: null } : {}),
  };
  payload.messages[index] = next;
  await saveWritebacks(payload);
  return next;
}

async function saveExecution(execution) {
  const payload = await readExecutions();
  const index = payload.executions.findIndex((item) => item.id === execution.id);
  if (index >= 0) payload.executions[index] = execution;
  else payload.executions.push(execution);
  await writeJsonIfChanged(executionsFile, payload);
  return execution;
}

async function updateDraftExecution(execution) {
  const payload = await readTaskDrafts();
  const index = payload.drafts.findIndex((item) => item.id === execution.draftId);
  if (index < 0) return null;
  const current = payload.drafts[index];
  const next = {
    ...current,
    status: execution.status,
    executionId: execution.id,
    executionStatus: execution.status,
    executionResult: execution.result ?? null,
    executionError: execution.error ?? null,
    executionStartedAt: execution.startedAt ?? null,
    executionCompletedAt: execution.completedAt ?? null,
    updatedAt: new Date().toISOString(),
  };
  payload.drafts[index] = next;
  await writeJsonIfChanged(taskDraftsFile, payload);
  return next;
}

async function appendSyncEvent(input) {
  const event = {
    id: input.id || randomUUID(),
    source: input.source ?? "gpt",
    conversationId: input.conversationId,
    turnId: input.turnId,
    role: input.role ?? "assistant",
    content: String(input.content ?? "").trim(),
    confirmed: input.confirmed === true,
    operations: Array.isArray(input.operations) ? input.operations : [],
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };
  const payload = await readJson(eventsFile, { events: [] });
  if (!payload.events.some((item) => item.id === event.id)) {
    payload.events.push(event);
    await writeJsonIfChanged(eventsFile, payload);
    const message = `data: ${JSON.stringify(event)}\n\n`;
    clients.forEach((client) => client.write(message));
  }
  return event;
}

const executionStatusDetails = {
  confirmed: "任务已确认，等待串行派发",
  dispatching: "正在创建 Codex 执行请求",
  running: "Codex 正在执行已确认任务",
  testing: "Codex 已结束，APS 正在核验真实结果",
  completed: "Codex 执行完成，结果已回写",
  failed: "Codex 执行失败，错误已回写",
};

async function setExecutionStatus(execution, status, patch = {}) {
  const now = new Date().toISOString();
  const transitioned = execution.status !== status;
  const statusHistory = [...(execution.statusHistory ?? [])];
  if (statusHistory.at(-1)?.status !== status) {
    statusHistory.push({ status, at: now, detail: executionStatusDetails[status] ?? status });
  }
  const next = {
    ...execution,
    ...patch,
    status,
    statusHistory,
    updatedAt: now,
    ...(status === "dispatching" && !execution.dispatchedAt ? { dispatchedAt: now } : {}),
    ...(status === "running" && !execution.startedAt ? { startedAt: now } : {}),
    ...(status === "testing" && !execution.testingAt ? { testingAt: now } : {}),
    ...(["completed", "failed"].includes(status) && !execution.completedAt ? { completedAt: now } : {}),
  };
  await saveExecution(next);
  await updateDraftExecution(next);

  const taskPatch = { confirmed: true };
  if (status === "confirmed") {
    Object.assign(taskPatch, {
      status: "waiting",
      result: executionStatusDetails.confirmed,
      error: null,
      errors: [],
      steps: {
        confirmed: { status: "success", at: next.confirmedAt ?? now, detail: "用户已确认草案" },
        dispatched: { status: "waiting", at: null, detail: "等待串行队列" },
      },
    });
  }
  if (status === "dispatching") {
    Object.assign(taskPatch, {
      status: "running",
      result: executionStatusDetails.dispatching,
      error: null,
      steps: {
        confirmed: { status: "success", at: next.confirmedAt, detail: "用户已确认草案" },
        dispatched: { status: "running", at: now, detail: "正在派发给临时 Codex 进程" },
        codex: { status: "waiting", at: null },
        returned: { status: "waiting", at: null },
      },
    });
  }
  if (status === "running") {
    const codexDetail = next.executionMode === "development"
      ? "在受控项目目录执行开发任务"
      : next.executionMode === "read_document"
        ? "在受控项目目录只读读取文档"
        : "仅执行 npm run build";
    Object.assign(taskPatch, {
      status: "running",
      result: executionStatusDetails.running,
      error: null,
      steps: {
        dispatched: { status: "success", at: next.dispatchedAt, detail: `执行请求 ${next.id}` },
        codex: { status: "running", at: now, detail: codexDetail },
        returned: { status: "waiting", at: null },
      },
    });
  }
  if (status === "testing") {
    Object.assign(taskPatch, {
      status: "running",
      result: executionStatusDetails.testing,
      error: null,
      steps: {
        dispatched: { status: "success", at: next.dispatchedAt, detail: `执行请求 ${next.id}` },
        codex: { status: "running", at: now, detail: "Codex 已结束，APS 正在核验文件变化、退出码和测试证据" },
        returned: { status: "waiting", at: null },
      },
    });
  }
  if (status === "completed") {
    Object.assign(taskPatch, {
      status: "success",
      result: next.result,
      error: null,
      errors: [],
      steps: {
        dispatched: { status: "success", at: next.dispatchedAt, detail: `执行请求 ${next.id}` },
        codex: { status: "success", at: next.completedAt, detail: `Codex 退出码 ${next.exitCode}` },
        returned: { status: "success", at: next.completedAt, detail: "真实结果已写入 APS" },
      },
    });
  }
  if (status === "failed") {
    Object.assign(taskPatch, {
      status: "failed",
      result: next.result ?? executionStatusDetails.failed,
      error: next.error,
      errors: next.error ? [next.error] : [],
      steps: {
        dispatched: { status: next.startedAt ? "success" : "failed", at: next.dispatchedAt ?? now, detail: next.startedAt ? `执行请求 ${next.id}` : "派发失败" },
        codex: { status: "failed", at: next.completedAt ?? now, detail: next.error },
        returned: { status: "success", at: next.completedAt ?? now, detail: "错误已写入 APS" },
      },
    });
  }
  await patchSyncTask(next.promptNumber, taskPatch);

  if (transitioned && status === "running") await enqueueExecutionWriteback(next, "progress");
  if (transitioned && ["completed", "failed"].includes(status)) await enqueueExecutionWriteback(next, "result");

  if (["completed", "failed"].includes(status)) {
    await appendSyncEvent({
      id: `${next.id}-${status}`,
      source: "codex-aps",
      conversationId: "configured-conversation",
      turnId: `prompt-${next.promptNumber}-codex`,
      role: "system",
      content: status === "completed" ? `【Codex completed】${next.result}` : `【Codex failed】${next.error}`,
      confirmed: true,
      operations: [],
    });
  }
  return next;
}

async function createExecutionRequest(draft) {
  const payload = await readExecutions();
  const existing = payload.executions.find((item) => item.draftId === draft.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const policy = resolveExecutionPolicy(draft);
  const execution = {
    id: `execution-${draft.id}`,
    draftId: draft.id,
    promptNumber: draft.promptNumber,
    project: draft.project,
    sourceContent: draft.sourceContent,
    original_message: draft.original_message,
    title: draft.title,
    goal: draft.goal,
    requirements: draft.executionSuggestion,
    acceptanceCriteria: draft.acceptanceCriteria,
    priority: draft.priority,
    command: executionCommand(policy),
    status: "confirmed",
    createdAt: now,
    confirmedAt: draft.confirmedAt ?? now,
    updatedAt: now,
    dispatchedAt: null,
    startedAt: null,
    testingAt: null,
    completedAt: null,
    exitCode: null,
    result: null,
    error: null,
    stdout: "",
    stderr: "",
    statusHistory: [],
  };
  await saveExecution(execution);
  await updateDraftExecution(execution);
  return execution;
}

async function createRetryExecution(source) {
  const payload = await readExecutions();
  const retryOf = source.retryOf ?? source.id;
  const retryNumber = payload.executions.filter((item) => item.retryOf === retryOf).length + 1;
  const now = new Date().toISOString();
  const policy = resolveExecutionPolicy(source);
  const execution = {
    ...source,
    id: `${retryOf}-retry-${retryNumber}`,
    retryOf,
    retryNumber,
    command: executionCommand(policy),
    executionMode: policy?.executionMode ?? null,
    workspacePath: policy?.workspacePath ?? null,
    timeoutMs: policy?.timeoutMs ?? null,
    status: "confirmed",
    createdAt: now,
    confirmedAt: now,
    updatedAt: now,
    dispatchedAt: null,
    startedAt: null,
    testingAt: null,
    completedAt: null,
    exitCode: null,
    result: null,
    error: null,
    stdout: "",
    stderr: "",
    changedFiles: [],
    fileChanges: { added: [], modified: [], deleted: [] },
    testResult: null,
    statusHistory: [],
  };
  await saveExecution(execution);
  await updateDraftExecution(execution);
  return execution;
}

async function reviewFailedExecutionForRetry(source) {
  const payload = await readJson(eventsFile, { events: [] });
  const contextEvents = payload.events
    .filter((event) => {
      const promptNumber = promptNumberOf(event.turnId);
      return Number.isInteger(promptNumber)
        && Math.abs(promptNumber - source.promptNumber) <= 2
        && event.turnId === `prompt-${promptNumber}`;
    })
    .sort((left, right) => String(left.receivedAt ?? "").localeCompare(String(right.receivedAt ?? "")));
  const context = contextEvents.map((event) => event.content).filter(Boolean).join("\n\n").slice(0, 45_000);
  const project = source.project?.trim() === "AI 数据工作台" || /AI\s*数据工作台/i.test(context)
    ? "AI 数据工作台"
    : source.project;
  const reviewed = {
    ...source,
    project,
    retryReview: {
      checkedAt: new Date().toISOString(),
      contextPromptNumbers: [...new Set(contextEvents.map((event) => promptNumberOf(event.turnId)))],
      originalProject: source.project,
      resolvedProject: project,
    },
  };
  const policy = resolveExecutionPolicy(reviewed);
  return policy ? { execution: reviewed, policy } : null;
}

const ignoredSnapshotDirectories = new Set([".git", ".npm-cache", "data", "dist", "node_modules"]);

async function sourceSnapshot(directory = projectRoot, relative = "") {
  const result = new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredSnapshotDirectories.has(entry.name)) {
        const nested = await sourceSnapshot(path.join(directory, entry.name), nextRelative);
        nested.forEach((value, key) => result.set(key, value));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(path.join(directory, entry.name));
    result.set(nextRelative, createHash("sha256").update(content).digest("hex"));
  }
  return result;
}

function changedSnapshotFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort();
}

function snapshotFileChanges(before, after) {
  const added = [...after.keys()].filter((file) => !before.has(file)).sort();
  const deleted = [...before.keys()].filter((file) => !after.has(file)).sort();
  const modified = [...before.keys()].filter((file) => after.has(file) && before.get(file) !== after.get(file)).sort();
  return { added, modified, deleted };
}

function reportedTestResult(executionMode, exitCode, output) {
  const text = String(output ?? "");
  const fraction = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:tests?\s*)?(?:passed|通过)/i);
  const passedOnly = text.match(/(?:^|\s)(\d+)\s+(?:tests?\s+)?passed\b/i);
  const failedMatch = text.match(/(?:^|\s)(\d+)\s+(?:tests?\s+)?failed\b/i);
  const allPassedZh = text.match(/(\d+)\s*项[^\n。；;]{0,30}(?:全部通过|全通过)/);
  const consoleMatch = text.match(/console\s*(?:errors?\s*[:：=]?\s*(\d+)|[:：=]?\s*(\d+)\s+errors?\b)/i);
  let total = null;
  let passed = null;
  let failed = null;
  if (fraction) {
    passed = Number(fraction[1]);
    total = Number(fraction[2]);
    failed = Math.max(0, total - passed);
  } else if (passedOnly || failedMatch) {
    passed = passedOnly ? Number(passedOnly[1]) : 0;
    failed = failedMatch ? Number(failedMatch[1]) : 0;
    total = passed + failed;
  } else if (allPassedZh) {
    total = Number(allPassedZh[1]);
    passed = total;
    failed = 0;
  }
  const build = executionMode === "build" ? (exitCode === 0 ? "success" : "failed") : null;
  const status = exitCode !== 0 || (failed ?? 0) > 0 || build === "failed"
    ? "failed"
    : total !== null || build === "success"
      ? "passed"
      : "not_reported";
  return {
    status,
    total,
    passed,
    failed,
    build,
    consoleErrors: consoleMatch ? Number(consoleMatch[1] ?? consoleMatch[2]) : null,
    evidenceSource: "codex_result",
    summary: status === "not_reported" ? "执行结果中未识别到结构化测试计数。" : null,
  };
}

function supportsBuildExecution(execution) {
  const text = [execution.title, execution.goal, execution.requirements, ...(execution.acceptanceCriteria ?? [])].join("\n");
  return /npm\s+run\s+build|构建验收|\bbuild\s+(?:check|test|verification)\b/i.test(text);
}

function executionText(execution) {
  return [execution.original_message, execution.sourceContent, execution.title, execution.goal, execution.requirements, ...(execution.acceptanceCriteria ?? [])].join("\n");
}

function supportsReadOnlyInspection(execution) {
  const text = executionText(execution);
  const requestsInspection = /(?:检查|核查|验证|确认|完整性|运行状态|health\s*check|inspect|inspection|status\s*check)/i.test(text);
  const requiresNoChanges = /(?:只读|不修改|不得.{0,16}(?:创建|修改|删除)|read[-\s]*only|without.{0,16}modif)/i.test(text);
  const requestsDevelopment = /(?:^|[\n。；;:])\s*(?:请|需要|开始|继续)?\s*(?:修改|修复|开发|实现|新增|改造|重构).{0,12}(?:代码|页面|功能|接口|文件)/im.test(text);
  return requestsInspection && requiresNoChanges && !requestsDevelopment;
}

function requestedRegisteredDocument(execution, project) {
  const text = executionText(execution);
  const requestedNames = text.match(/[A-Za-z0-9][A-Za-z0-9_.-]*\.md\b/gi) ?? [];
  const documentName = requestedNames.find((name) => Object.hasOwn(project.documents ?? {}, name));
  if (!documentName || !/(?:读取|查看|返回|输出).{0,24}(?:完整内容|全文|文档)|(?:完整内容|全文).{0,24}(?:读取|返回|输出)/s.test(text)) return null;
  const relativePath = project.documents[documentName];
  const absolutePath = path.resolve(project.path, relativePath);
  if (!absolutePath.startsWith(`${path.resolve(project.path)}${path.sep}`)) return null;
  return { name: documentName, relativePath, absolutePath };
}

function resolveExecutionPolicy(execution) {
  const project = registeredProject(execution.project);
  if (!project || project.status !== "active") return null;
  const allowed = new Set(project.allowedExecutionScopes ?? []);
  const document = requestedRegisteredDocument(execution, project);
  if (document && allowed.has("read_document")) {
    return { executionMode: "read_document", workspacePath: project.path, timeoutMs: 300_000, document };
  }
  if (supportsBuildExecution(execution) && allowed.has("build")) {
    return { executionMode: "build", workspacePath: project.path, timeoutMs: 300_000 };
  }
  if (supportsReadOnlyInspection(execution) && allowed.has("read_only_inspection")) {
    return { executionMode: "read_only_inspection", workspacePath: project.path, timeoutMs: 300_000 };
  }
  if (allowed.has("development")) {
    return { executionMode: "development", workspacePath: project.path, timeoutMs: 1_800_000 };
  }
  return null;
}

function executionCommand(policy) {
  if (policy?.executionMode === "build") return "npm run build";
  if (policy?.executionMode === "read_document") return `read ${policy.document.relativePath}`;
  if (policy?.executionMode === "read_only_inspection") return "codex read-only inspection";
  if (policy?.executionMode === "development") return "codex controlled development";
  return "unsupported";
}

function codexExecutionPrompt(execution, policy) {
  const controls = policy.executionMode === "development"
    ? [
      "Complete the confirmed development task inside the current working directory.",
      "Do not read, edit, delete, move, or create files outside the current working directory.",
      "Do not deploy, access secrets, change databases, or modify any other project.",
      "The new product must bind to 127.0.0.6 on port 8006. Do not substitute 127.0.0.1, 127.0.0.5, localhost, or another host.",
      "Keep the implementation minimal and run proportionate local verification before reporting.",
    ]
    : policy.executionMode === "read_document"
      ? [
        `Read exactly this registered file: ${policy.document.relativePath}`,
        "Do not read any other file. Do not edit, create, delete, move, or format any file.",
        "Return the complete file content exactly, without explanation, summary, Markdown fences, or omissions.",
      ]
      : policy.executionMode === "read_only_inspection"
        ? [
          "Perform only the confirmed read-only inspection inside the current working directory.",
          "Do not edit, create, delete, move, format, or generate any project file.",
          "Do not deploy, access secrets, change databases, or modify another project.",
          "Return the real finding, inspected scope, and verifiable evidence in concise Chinese.",
        ]
      : [
      "Execute exactly one command: npm run build.",
      "Do not edit, create, delete, move, or format source files. Do not run any other command.",
      "Build artifacts produced by npm run build are allowed.",
    ];
  return [
    "You are the APS-005 controlled executor. The user already confirmed this task in APS.",
    ...controls,
    ...(policy.executionMode === "read_document" || policy.executionMode === "read_only_inspection" ? [] : ["Report the actual changes, verification, result, and remaining risks in concise Chinese."]),
    "",
    `项目：${execution.project}`,
    `任务名称：${execution.title}`,
    `任务目标：${execution.goal}`,
    `执行要求：${execution.requirements}`,
    `验收标准：\n${(execution.acceptanceCriteria ?? []).map((item) => `- ${item}`).join("\n")}`,
  ].join("\n");
}

async function runExecution(execution) {
  let current = execution;
  let outputFile = null;
  let child = null;
  activeExecutionId = execution.id;
  try {
    const policy = resolveExecutionPolicy(current);
    current = await setExecutionStatus(current, "dispatching", policy ?? {});
    if (!policy) {
      await setExecutionStatus(current, "failed", { error: "unsupported_execution_workspace:当前任务没有配置受控项目目录" });
      return;
    }

    const workspaceInfo = await stat(policy.workspacePath).catch(() => null);
    if (!workspaceInfo?.isDirectory()) {
      await setExecutionStatus(current, "failed", { error: "registered_workspace_missing:注册项目目录不存在" });
      return;
    }
    if (policy.executionMode === "read_document") {
      const documentInfo = await stat(policy.document.absolutePath).catch(() => null);
      if (!documentInfo?.isFile()) {
        await setExecutionStatus(current, "failed", { error: "registered_document_missing:注册文档不存在" });
        return;
      }
    }
    const before = await sourceSnapshot(policy.workspacePath);
    outputFile = path.join("/private/tmp", `aps-${current.id}-${randomUUID()}.txt`);
    child = spawn(codexBin, [
      "exec",
      "--ephemeral",
      "--sandbox", ["read_document", "read_only_inspection"].includes(policy.executionMode) ? "read-only" : "workspace-write",
      "--skip-git-repo-check",
      "-o", outputFile,
      "-C", policy.workspacePath,
      "-",
    ], {
      cwd: policy.workspacePath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    executionProcess = child;
    let stdout = "";
    let stderr = "";
    const appendLimited = (existing, chunk) => `${existing}${chunk}`.slice(-50_000);
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.stdin.end(codexExecutionPrompt(current, policy));

    const outcomePromise = new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    });
    const spawnError = await new Promise((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", resolve);
    });
    if (spawnError) {
      await setExecutionStatus(current, "failed", { error: `codex_spawn_failed:${spawnError.message}`, stdout, stderr });
      return;
    }
    current = await setExecutionStatus(current, "running");
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null) child.kill("SIGTERM");
    }, policy.timeoutMs);
    const outcome = await outcomePromise;
    clearTimeout(timeoutId);
    if (timedOut) outcome.signal = "TIMEOUT";
    const finalOutput = await readFile(outputFile, "utf8").catch(() => "");
    const after = await sourceSnapshot(policy.workspacePath);
    const changedFiles = changedSnapshotFiles(before, after);
    const fileChanges = snapshotFileChanges(before, after);
    const exitCode = Number.isInteger(outcome.code) ? outcome.code : null;
    const testResult = reportedTestResult(policy.executionMode, exitCode, `${finalOutput}\n${stdout}\n${stderr}`);
    current = await setExecutionStatus(current, "testing", {
      exitCode,
      stdout,
      stderr,
      changedFiles,
      fileChanges,
      testResult,
    });
    if (["build", "read_document", "read_only_inspection"].includes(policy.executionMode) && changedFiles.length) {
      current = await setExecutionStatus(current, "failed", {
        exitCode,
        stdout,
        stderr,
        error: `source_files_changed:${changedFiles.join(",")}`,
        result: finalOutput || stdout || "Codex 执行后检测到源文件变化。",
      });
    } else if (policy.executionMode === "read_document" && outcome.code === 0) {
      const expectedContent = await readFile(policy.document.absolutePath, "utf8");
      if (finalOutput.trim() !== expectedContent.trim()) {
        current = await setExecutionStatus(current, "failed", {
          exitCode: 0,
          stdout,
          stderr,
          changedFiles,
          error: "document_content_incomplete:Codex 未返回注册文档的完整原文",
          result: finalOutput || stdout || "Codex 未返回文档内容。",
        });
      } else {
        current = await setExecutionStatus(current, "completed", {
          exitCode: 0,
          stdout,
          stderr,
          changedFiles,
          testResult: { ...testResult, status: "passed", total: 1, passed: 1, failed: 0, summary: "注册文档原文完整性核验通过。" },
          result: expectedContent,
        });
      }
    } else if (policy.executionMode === "read_only_inspection" && outcome.code === 0) {
      current = await setExecutionStatus(current, "completed", {
        exitCode: 0,
        stdout,
        stderr,
        changedFiles,
        testResult: { ...testResult, status: "passed", total: 1, passed: 1, failed: 0, summary: "只读检查完成，项目文件零变化。" },
        result: finalOutput || stdout || "只读检查完成。",
      });
    } else if (policy.executionMode === "development" && outcome.code === 0 && changedFiles.length === 0) {
      current = await setExecutionStatus(current, "failed", {
        exitCode: 0,
        stdout,
        stderr,
        changedFiles,
        error: "no_workspace_changes:开发任务没有产生任何项目文件变化",
        result: finalOutput || stdout || "Codex 未产生项目文件变化。",
      });
    } else if (outcome.code === 0) {
      current = await setExecutionStatus(current, "completed", {
        exitCode: 0,
        stdout,
        stderr,
        changedFiles,
        result: finalOutput || stdout || (policy.executionMode === "development" ? "受控开发任务执行成功。" : "npm run build 执行成功。"),
      });
    } else {
      current = await setExecutionStatus(current, "failed", {
        exitCode,
        stdout,
        stderr,
        error: outcome.signal === "TIMEOUT" ? "execution_timeout" : `codex_exit_${outcome.code ?? outcome.signal}:${(stderr || stdout).slice(-1200)}`,
        result: finalOutput || stdout || "Codex 构建验收失败。",
      });
    }
  } catch (error) {
    await setExecutionStatus(current, "failed", { error: `execution_queue_failed:${error.message}` }).catch(() => {});
  } finally {
    if (outputFile) await unlink(outputFile).catch(() => {});
    if (executionProcess === child) executionProcess = null;
    if (activeExecutionId === execution.id) activeExecutionId = null;
  }
}

async function pumpExecutionQueue() {
  if (executionPumpRunning || executionProcess) return;
  executionPumpRunning = true;
  try {
    const payload = await readExecutions();
    const next = payload.executions.find((item) => item.status === "confirmed");
    if (next) await runExecution(next);
  } catch (error) {
    if (activeExecutionId) {
      const payload = await readExecutions().catch(() => ({ executions: [] }));
      const current = payload.executions.find((item) => item.id === activeExecutionId);
      if (current) await setExecutionStatus(current, "failed", { error: `execution_queue_failed:${error.message}` }).catch(() => {});
    }
  } finally {
    executionPumpRunning = false;
    const payload = await readExecutions().catch(() => ({ executions: [] }));
    if (payload.executions.some((item) => item.status === "confirmed")) setTimeout(() => pumpExecutionQueue(), 0);
  }
}

async function stopBridge(reason = "stopped_by_user") {
  const processToStop = bridgeProcess;
  bridgeProcess = null;
  if (processToStop && processToStop.exitCode === null) processToStop.kill("SIGTERM");
  const now = new Date().toISOString();
  const state = await writeCollaborationState({
    mode: "stopped",
    bridgeStatus: reason,
    sessionId: null,
    sessionStoppedAt: now,
    activePromptNumber: null,
    lastActivityAt: now,
    lastError: null,
    writebackPolicy: "disabled",
    writebackApprovedAt: null,
  });
  const checkpoint = await readJson(checkpointFile, { lastPromptNumber: 0 });
  await writeJsonIfChanged(checkpointFile, {
    ...checkpoint,
    collaborationMode: "paused",
    bridgeStatus: "paused_by_user",
    lastCheckedAt: now,
    lastError: null,
    sessionPausedAt: now,
  });
  return state;
}

async function startBridge() {
  const state = await readCollaborationState();
  if (state.approvalStatus !== "approved") {
    const error = new Error("approval_required");
    error.statusCode = 409;
    throw error;
  }
  if (state.writebackPolicy !== "progress_and_result" || !state.writebackApprovedAt) {
    const error = new Error("writeback_approval_required");
    error.statusCode = 409;
    throw error;
  }
  if (bridgeProcess && bridgeProcess.exitCode === null) {
    const error = new Error("collaboration_already_running");
    error.statusCode = 409;
    throw error;
  }
  const communicationTarget = normalizeCommunicationTarget(state.communicationTarget);

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  await writeCollaborationState({
    mode: "running",
    bridgeStatus: "starting",
    sessionId,
    sessionStartedAt: now,
    sessionStoppedAt: null,
    lastActivityAt: now,
    activePromptNumber: null,
    lastError: null,
  });
  const checkpoint = await readJson(checkpointFile, { lastPromptNumber: 0 });
  await writeJsonIfChanged(checkpointFile, {
    ...checkpoint,
    provider: communicationTarget.provider,
    conversationTitle: communicationTarget.conversationTitle,
    conversationUrl: communicationTarget.conversationUrl,
    communicationLocationId: communicationTarget.location.id,
    collaborationMode: "active",
    bridgeStatus: "starting",
    lastCheckedAt: now,
    lastError: null,
    sessionStartedAt: now,
  });

  const child = spawn(process.execPath, [bridgeWorkerFile], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      APS_BASE_URL: `http://${host}:${port}`,
      APS_RUNTIME_DIR: runtimeRoot,
      APS_PROJECT_ROOT: process.env.APS_PROJECT_ROOT || moduleRoot,
      APS_CODEX_SCHEMA_FILE: codexSchemaFile,
      APS_BRIDGE_INTERNAL_TOKEN: bridgeInternalToken,
      APS_BRIDGE_SESSION_ID: sessionId,
      APS_COMMUNICATION_TARGET: JSON.stringify(communicationTarget),
    },
    stdio: "ignore",
  });
  bridgeProcess = child;
  child.once("error", async (error) => {
    if (bridgeProcess === child) bridgeProcess = null;
    await writeCollaborationState({
      mode: "stopped",
      bridgeStatus: "blocked",
      sessionId: null,
      sessionStoppedAt: new Date().toISOString(),
      lastError: error.message,
    }).catch(() => {});
  });
  child.once("exit", async (code, signal) => {
    if (bridgeProcess === child) bridgeProcess = null;
    if (shuttingDown) return;
    const current = await readCollaborationState().catch(() => null);
    if (!current || current.sessionId !== sessionId) return;
    const failed = code !== 0 && signal !== "SIGTERM";
    await writeCollaborationState({
      mode: "stopped",
      bridgeStatus: failed ? "blocked" : "stopped",
      sessionId: null,
      sessionStoppedAt: new Date().toISOString(),
      activePromptNumber: null,
      lastError: failed ? current.lastError || `bridge_exit_${code}` : null,
      writebackPolicy: "disabled",
      writebackApprovedAt: null,
    }).catch(() => {});
  });
  return readCollaborationState();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/collaboration/status") {
    sendJson(response, 200, {
      ...(await readCollaborationState()),
      processRunning: Boolean(bridgeProcess && bridgeProcess.exitCode === null),
      scheduledAutomation: "REMOVED",
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/collaboration/models") {
    sendJson(response, 200, { models: collaborationModels });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/collaboration/locations") {
    try {
      const target = normalizeCommunicationTarget({
        provider: url.searchParams.get("provider"),
        conversationTitle: url.searchParams.get("conversationTitle") || "待选择会话",
        conversationUrl: url.searchParams.get("conversationUrl"),
      }, { requireLocation: false });
      sendJson(response, 200, { locations: await discoverSafariLocations(target) });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message || "conversation_location_discovery_failed" });
    }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/collaboration/target") {
    try {
      const current = await readCollaborationState();
      if (current.mode === "running" || (bridgeProcess && bridgeProcess.exitCode === null)) {
        sendJson(response, 409, { error: "collaboration_target_locked_while_running" });
        return true;
      }
      const body = await readBody(request);
      const requested = normalizeCommunicationTarget(body);
      let verifiedLocation = requested.location;
      if (process.env.APS_BRIDGE_SIMULATION !== "1") {
        const locations = await discoverSafariLocations(requested);
        verifiedLocation = locations.find((item) => item.windowId === requested.location.windowId && item.tabIndex === requested.location.tabIndex) ?? null;
        if (!verifiedLocation) {
          sendJson(response, 409, { error: "selected_conversation_location_not_found" });
          return true;
        }
      }
      const changed = communicationTargetKey(current.communicationTarget) !== communicationTargetKey({ ...requested, location: verifiedLocation });
      const now = new Date().toISOString();
      const communicationTarget = {
        ...requested,
        location: verifiedLocation,
        configuredAt: changed ? now : current.communicationTarget.configuredAt ?? now,
      };
      const state = await writeCollaborationState({
        communicationTarget,
        conversationTitle: communicationTarget.conversationTitle,
        conversationUrl: communicationTarget.conversationUrl,
        ...(changed ? {
          approvalStatus: "pending",
          approvedAt: null,
          writebackPolicy: "disabled",
          writebackApprovedAt: null,
          bridgeStatus: "target_ready_for_review",
          lastActivityAt: now,
          lastError: null,
        } : {}),
      });
      sendJson(response, 200, { saved: true, changed, state });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || "invalid_collaboration_target" });
    }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/collaboration/approval") {
    try {
      const body = await readBody(request);
      if (typeof body.approved !== "boolean") {
        sendJson(response, 400, { error: "approved_boolean_required" });
        return true;
      }
      if (body.approved && body.writebackPolicy !== "progress_and_result") {
        sendJson(response, 400, { error: "writeback_policy_approval_required" });
        return true;
      }
      if (!body.approved && bridgeProcess && bridgeProcess.exitCode === null) await stopBridge("approval_revoked");
      const now = new Date().toISOString();
      const state = await writeCollaborationState({
        approvalStatus: body.approved ? "approved" : "pending",
        approvedAt: body.approved ? now : null,
        writebackPolicy: body.approved ? "progress_and_result" : "disabled",
        writebackApprovedAt: body.approved ? now : null,
        mode: "stopped",
        bridgeStatus: body.approved ? "ready" : "ready_for_review",
        sessionId: null,
        activePromptNumber: null,
        lastActivityAt: now,
        lastError: null,
      });
      sendJson(response, 200, state);
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collaboration/start") {
    try {
      sendJson(response, 202, { accepted: true, ...(await startBridge()) });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message || "start_failed" });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collaboration/stop") {
    try {
      sendJson(response, 200, { stopped: true, ...(await stopBridge()) });
    } catch (error) {
      sendJson(response, 500, { error: error?.message ?? "stop_failed" });
    }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/collaboration/worker") {
    if (request.headers.authorization !== `Bearer ${bridgeInternalToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readBody(request);
      const current = await readCollaborationState();
      if (!body.sessionId || body.sessionId !== current.sessionId) {
        sendJson(response, 409, { error: "stale_session" });
        return true;
      }
      const allowed = ["bridgeStatus", "lastActivityAt", "lastError", "activePromptNumber"];
      const patch = Object.fromEntries(allowed.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
      sendJson(response, 200, await writeCollaborationState(patch));
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/writebacks") {
    const payload = await readWritebacks();
    sendJson(response, 200, {
      version: payload.version,
      messages: [...payload.messages].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/writebacks/pending") {
    if (request.headers.authorization !== `Bearer ${bridgeInternalToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    const state = await readCollaborationState();
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || sessionId !== state.sessionId || state.mode !== "running") {
      sendJson(response, 409, { error: "stale_session" });
      return true;
    }
    const payload = await readWritebacks();
    const message = payload.messages.find((item) =>
      ["pending", "failed"].includes(item.status)
      && Number(item.attempts ?? 0) < 3
      && writebackTargetMatches(item, state.communicationTarget));
    sendJson(response, 200, { message: message ?? null });
    return true;
  }
  const writebackWorkerMatch = url.pathname.match(/^\/api\/writebacks\/([^/]+)\/worker$/);
  if (request.method === "PUT" && writebackWorkerMatch) {
    if (request.headers.authorization !== `Bearer ${bridgeInternalToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readBody(request);
      const state = await readCollaborationState();
      if (!body.sessionId || body.sessionId !== state.sessionId || state.mode !== "running") {
        sendJson(response, 409, { error: "stale_session" });
        return true;
      }
      if (!["sending", "sent", "failed", "acknowledged"].includes(body.status)) {
        sendJson(response, 400, { error: "invalid_writeback_status" });
        return true;
      }
      const id = decodeURIComponent(writebackWorkerMatch[1]);
      const updated = await updateWriteback(id, body.status, {
        error: typeof body.error === "string" ? body.error.slice(0, 2000) : null,
        detail: typeof body.detail === "string" ? body.detail.slice(0, 500) : null,
        assistantReply: typeof body.assistantReply === "string" ? body.assistantReply.slice(0, 20_000) : undefined,
        responsePromptNumber: Number.isInteger(body.promptNumber) ? body.promptNumber : undefined,
      });
      if (!updated) {
        sendJson(response, 404, { error: "writeback_not_found" });
        return true;
      }
      if (body.status === "acknowledged") {
        await appendSyncEvent({
          id: `writeback-ack-${updated.id}`,
          source: "gpt-writeback-ack",
          conversationId: state.communicationTarget.conversationUrl,
          turnId: Number.isInteger(body.promptNumber) ? `prompt-${body.promptNumber}` : updated.id,
          role: "assistant",
          content: `【APS 回传】${updated.content}\n\n【GPT 回应】${updated.assistantReply ?? ""}`,
          confirmed: false,
          operations: [],
        });
      }
      sendJson(response, 200, updated);
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/task-drafts") {
    sendJson(response, 200, await readTaskDrafts());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, { version: projectRegistry.version, projects: projectRegistry.projects.map(publicProject) });
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/task-drafts") {
    if (request.headers.authorization !== `Bearer ${bridgeInternalToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readBody(request);
      if (!Number.isInteger(body.promptNumber) || body.promptNumber < 1 || typeof body.isTask !== "boolean") {
        sendJson(response, 400, { error: "valid_task_understanding_required" });
        return true;
      }
      const now = new Date().toISOString();
      const allowedIntentTypes = ["execution_task", "system_rule", "system_validation", "product_discussion", "ordinary_chat"];
      const allowedTargetObjects = ["codex", "gpt", "aps", "none"];
      const originalMessage = typeof body.original_message === "string" ? body.original_message : typeof body.sourceContent === "string" ? body.sourceContent : "";
      const contextualApproval = getContextualExecutionApproval(
        originalMessage,
        `【GPT】${typeof body.authorization_context === "string" ? body.authorization_context : ""}`,
        body.authorization_basis,
      );
      const delegatedApproval = getDelegatedExecutionApproval(
        originalMessage,
        typeof body.authorization_context === "string" ? body.authorization_context : "",
        body.authorization_basis,
      );
      const approvedContext = contextualApproval.approved ? contextualApproval : delegatedApproval.approved ? delegatedApproval : null;
      const rejected = contextualApproval.rejected || delegatedApproval.rejected;
      const systemValidation = isSystemValidationRequest(originalMessage) && !approvedContext;
      const intentType = rejected ? "ordinary_chat" : approvedContext ? "execution_task" : systemValidation ? "system_validation" : allowedIntentTypes.includes(body.intent_type) ? body.intent_type : body.isTask ? "execution_task" : "ordinary_chat";
      const targetObject = rejected ? "none" : approvedContext ? "codex" : systemValidation ? "aps" : allowedTargetObjects.includes(body.target_object) ? body.target_object : body.isTask ? "codex" : "none";
      const taskGenerated = intentType === "execution_task" && targetObject === "codex" && body.task_generated !== false;
      const authorizationBasis = contextualApproval.approved ? "contextual_user_confirmation" : delegatedApproval.approved ? "delegated_task_request" : body.authorization_basis === "explicit_user_instruction" ? "explicit_user_instruction" : "none";
      const projectEvidence = approvedContext ? `${originalMessage}\n${approvedContext.context}` : originalMessage;
      const draft = {
        id: `draft-prompt-${body.promptNumber}`,
        promptNumber: body.promptNumber,
        sourceEventId: `safari-configured-prompt-${body.promptNumber}`,
        sourceContent: typeof body.sourceContent === "string" ? body.sourceContent : "",
        original_message: originalMessage,
        authorization_basis: authorizationBasis,
        authorization_context: approvedContext?.context || "",
        intent_type: intentType,
        target_object: targetObject,
        task_generated: taskGenerated,
        isTask: taskGenerated,
        needsExecution: taskGenerated,
        project: taskGenerated ? inferRegisteredProject(projectEvidence) : "",
        title: typeof body.title === "string" ? body.title : "",
        goal: typeof body.goal === "string" ? body.goal : "",
        type: typeof body.type === "string" ? body.type : "discussion",
        priority: "unassigned",
        executionSuggestion: typeof body.executionSuggestion === "string" ? body.executionSuggestion : "",
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria.filter((item) => typeof item === "string") : [],
        reason: systemValidation ? "用户正在验证 APS 自身的识别、判断或现有能力；这是系统验收记录，不是 Codex 执行授权。" : typeof body.reason === "string" ? body.reason : "",
        status: taskGenerated ? "pending" : "not_task",
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
        rejectedAt: null,
      };
      sendJson(response, 200, { saved: true, draft: await saveTaskDraft(draft) });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  const draftRoute = url.pathname.match(/^\/api\/task-drafts\/([^/]+)(?:\/(confirm|reject))?$/);
  if (draftRoute && ["PATCH", "POST"].includes(request.method)) {
    try {
      const [, draftId, action] = draftRoute;
      const payload = await readTaskDrafts();
      const current = payload.drafts.find((item) => item.id === draftId);
      if (!current) {
        sendJson(response, 404, { error: "task_draft_not_found" });
        return true;
      }
      if (request.method === "POST" && action === "confirm" && ["confirmed", "dispatching", "running", "completed", "failed"].includes(current.status)) {
        const executions = await readExecutions();
        const execution = executions.executions.find((item) => item.draftId === current.id) ?? null;
        sendJson(response, 200, {
          confirmed: true,
          duplicate: true,
          queuedForExecution: execution ? ["confirmed", "dispatching", "running"].includes(execution.status) : false,
          execution,
          draft: current,
        });
        return true;
      }
      if (current.status !== "pending") {
        sendJson(response, 409, { error: "task_draft_not_pending" });
        return true;
      }
      const now = new Date().toISOString();
      if (request.method === "PATCH" && !action) {
        const body = await readBody(request);
        const priority = ["unassigned", "high", "medium", "low"].includes(body.priority) ? body.priority : current.priority;
        const selectedProject = typeof body.project === "string" ? body.project.trim() : current.project;
        const canonicalProject = selectedProject ? registeredProject(selectedProject)?.name : "";
        if (selectedProject && !canonicalProject) {
          sendJson(response, 409, { error: "unregistered_project" });
          return true;
        }
        const next = {
          ...current,
          project: canonicalProject,
          title: typeof body.title === "string" ? body.title.trim() : current.title,
          goal: typeof body.goal === "string" ? body.goal.trim() : current.goal,
          type: typeof body.type === "string" ? body.type : current.type,
          priority,
          executionSuggestion: typeof body.executionSuggestion === "string" ? body.executionSuggestion.trim() : current.executionSuggestion,
          acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : current.acceptanceCriteria,
          updatedAt: now,
        };
        sendJson(response, 200, { saved: true, draft: await saveTaskDraft(next) });
        return true;
      }
      if (request.method === "POST" && action === "confirm") {
        if (!current.project || !current.title || !current.goal || current.priority === "unassigned" || current.acceptanceCriteria.length === 0) {
          sendJson(response, 409, { error: current.project ? "complete_draft_and_priority_required" : "project_selection_required" });
          return true;
        }
        if (!resolveExecutionPolicy(current)) {
          sendJson(response, 409, { error: "unsupported_execution_workspace", draft: current });
          return true;
        }
        const next = await saveTaskDraft({ ...current, status: "confirmed", confirmedAt: now, updatedAt: now });
        await patchSyncTask(current.promptNumber, {
          confirmed: true,
          status: "waiting",
          result: `任务草案“${current.title}”已由用户确认，等待串行派发。`,
          steps: {
            taskCreated: { status: "success", at: current.createdAt, detail: "已生成结构化任务草案" },
            confirmed: { status: "success", at: now, detail: "用户已确认草案" },
          },
        });
        const execution = await createExecutionRequest(next);
        const queued = await setExecutionStatus(execution, "confirmed");
        setTimeout(() => pumpExecutionQueue(), 0);
        sendJson(response, 202, { confirmed: true, queuedForExecution: true, executionId: queued.id, execution: queued, draft: (await readTaskDrafts()).drafts.find((item) => item.id === next.id) });
        return true;
      }
      if (request.method === "POST" && action === "reject") {
        const next = { ...current, status: "rejected", rejectedAt: now, updatedAt: now };
        await patchSyncTask(current.promptNumber, {
          confirmed: false,
          status: "waiting",
          result: `任务草案“${current.title}”已被用户拒绝。`,
          steps: { taskCreated: { status: "waiting", at: null, detail: "草案已拒绝，不会派发" } },
        });
        sendJson(response, 200, { rejected: true, draft: await saveTaskDraft(next) });
        return true;
      }
      sendJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/events") {
    sendJson(response, 200, await readJson(eventsFile, { events: [] }));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/executions") {
    sendJson(response, 200, await readExecutions());
    return true;
  }
  const executionRoute = url.pathname.match(/^\/api\/executions\/([^/]+)(?:\/(retry))?$/);
  if (request.method === "GET" && executionRoute && !executionRoute[2]) {
    const payload = await readExecutions();
    const execution = payload.executions.find((item) => item.id === executionRoute[1]);
    sendJson(response, execution ? 200 : 404, execution ?? { error: "execution_not_found" });
    return true;
  }
  if (request.method === "POST" && executionRoute?.[2] === "retry") {
    const payload = await readExecutions();
    const source = payload.executions.find((item) => item.id === executionRoute[1]);
    if (!source) {
      sendJson(response, 404, { error: "execution_not_found" });
      return true;
    }
    if (source.status !== "failed") {
      sendJson(response, 409, { error: "failed_execution_required" });
      return true;
    }
    const retryOf = source.retryOf ?? source.id;
    if (payload.executions.some((item) => item.retryOf === retryOf && ["confirmed", "dispatching", "running"].includes(item.status))) {
      sendJson(response, 409, { error: "retry_already_active" });
      return true;
    }
    const review = await reviewFailedExecutionForRetry(source);
    if (!review) {
      sendJson(response, 409, { error: "retry_review_failed_workspace_unresolved" });
      return true;
    }
    const retry = await createRetryExecution(review.execution);
    const queued = await setExecutionStatus(retry, "confirmed");
    setTimeout(() => pumpExecutionQueue(), 0);
    sendJson(response, 202, {
      retried: true,
      reviewed: true,
      queuedForExecution: true,
      executionId: queued.id,
      execution: queued,
      draft: (await readTaskDrafts()).drafts.find((item) => item.id === queued.draftId) ?? null,
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/tasks") {
    sendJson(response, 200, await readSyncTasks());
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/sync/tasks") {
    if (request.headers.authorization !== `Bearer ${bridgeInternalToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readBody(request);
      if (!Number.isInteger(body.promptNumber) || body.promptNumber < 1) {
        sendJson(response, 400, { error: "valid_prompt_number_required" });
        return true;
      }
      const payload = await readJson(tasksFile, { tasks: [] });
      const taskId = `prompt-${body.promptNumber}`;
      const index = payload.tasks.findIndex((task) => task.id === taskId);
      const current = index >= 0 ? payload.tasks[index] : {
        id: taskId,
        promptNumber: body.promptNumber,
        source: "safari-chatgpt",
        message: "",
        confirmed: false,
        status: "waiting",
        result: null,
        error: null,
        errors: [],
        createdAt: new Date().toISOString(),
        steps: waitingSteps(),
      };
      const next = {
        ...current,
        ...body,
        id: taskId,
        promptNumber: body.promptNumber,
        steps: { ...current.steps, ...(body.steps ?? {}) },
        errors: [...new Set([...(current.errors ?? []), ...(body.errors ?? [])])],
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) payload.tasks[index] = next;
      else payload.tasks.push(next);
      await writeJsonIfChanged(tasksFile, payload);
      sendJson(response, 200, { saved: true, task: next });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/checkpoint") {
    sendJson(response, 200, await readJson(checkpointFile, { lastPromptNumber: 0, lastSyncedAt: null }));
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/sync/checkpoint") {
    try {
      const body = await readBody(request);
      const current = await readJson(checkpointFile, { lastPromptNumber: 0 });
      const lastPromptNumber = body.lastPromptNumber ?? current.lastPromptNumber;
      if (!Number.isInteger(lastPromptNumber) || lastPromptNumber < 0) {
        sendJson(response, 400, { error: "valid_last_prompt_number_required" });
        return true;
      }
      const checkpoint = {
        ...current,
        lastPromptNumber,
        collaborationMode: body.collaborationMode === "active" || body.collaborationMode === "paused"
          ? body.collaborationMode
          : current.collaborationMode ?? "paused",
        lastAssistantMessageId: typeof body.lastAssistantMessageId === "string"
          ? body.lastAssistantMessageId
          : current.lastAssistantMessageId ?? null,
        bridgeStatus: typeof body.bridgeStatus === "string" ? body.bridgeStatus : current.bridgeStatus ?? "idle",
        lastCheckedAt: new Date().toISOString(),
        lastError: body.lastError === null || typeof body.lastError === "string" ? body.lastError : current.lastError ?? null,
        lastSyncedAt: lastPromptNumber > current.lastPromptNumber ? new Date().toISOString() : current.lastSyncedAt ?? null,
      };
      const changed = await writeJsonIfChanged(checkpointFile, checkpoint);
      sendJson(response, 200, { saved: true, changed, lastPromptNumber: checkpoint.lastPromptNumber });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/sync/session") {
    sendJson(response, 410, { error: "legacy_session_control_disabled", use: "/api/collaboration/start" });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/events") {
    const expectedToken = process.env.APS_SYNC_TOKEN;
    if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readBody(request);
      if (typeof body.content !== "string" || !body.content.trim()) {
        sendJson(response, 400, { error: "content_required" });
        return true;
      }
      const event = {
        id: typeof body.id === "string" && body.id ? body.id : randomUUID(),
        source: body.source ?? "gpt",
        conversationId: body.conversationId,
        turnId: body.turnId,
        role: body.role ?? "assistant",
        content: body.content.trim(),
        confirmed: body.confirmed === true,
        operations: Array.isArray(body.operations) ? body.operations : [],
        receivedAt: new Date().toISOString(),
      };
      const payload = await readJson(eventsFile, { events: [] });
      if (!payload.events.some((item) => item.id === event.id)) {
        payload.events.push(event);
        await writeJsonIfChanged(eventsFile, payload);
        const message = `data: ${JSON.stringify(event)}\n\n`;
        clients.forEach((client) => client.write(message));
      }
      sendJson(response, 202, { accepted: true, eventId: event.id });
    } catch (error) {
      sendJson(response, error?.message === "payload_too_large" ? 413 : 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/studio/state") {
    sendJson(response, 200, await readJson(studioStateFile, { nodes: [], positions: {}, versions: [], updatedAt: null }));
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/studio/state") {
    try {
      const body = await readBody(request);
      if (!Array.isArray(body.nodes) || !body.nodes.every((item) => typeof item?.id === "string" && typeof item?.title === "string")) {
        sendJson(response, 400, { error: "valid_nodes_required" });
        return true;
      }
      const state = {
        nodes: body.nodes,
        positions: body.positions && typeof body.positions === "object" ? body.positions : {},
        versions: Array.isArray(body.versions) ? body.versions : [],
        updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString(),
      };
      const changed = await writeJsonIfChanged(studioStateFile, state);
      sendJson(response, 200, { saved: true, changed, updatedAt: state.updatedAt });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? "invalid_request" });
    }
    return true;
  }
  return false;
}

async function serveStatic(response, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const candidate = path.resolve(staticRoot, `.${requested}`);
  let file = candidate.startsWith(`${staticRoot}${path.sep}`) ? candidate : path.join(staticRoot, "index.html");
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not_file");
  } catch {
    file = path.join(staticRoot, "index.html");
  }
  response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname.startsWith("/api/") && await handleApi(request, response, url)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  await serveStatic(response, url);
});

const initialCollaboration = await readCollaborationState();
if (
  initialCollaboration.mode !== "stopped"
  || initialCollaboration.sessionId
  || initialCollaboration.writebackPolicy !== "disabled"
  || initialCollaboration.writebackApprovedAt
) {
  const restartedAt = new Date().toISOString();
  await writeCollaborationState({
    mode: "stopped",
    bridgeStatus: initialCollaboration.approvalStatus === "approved" ? "ready" : "ready_for_review",
    sessionId: null,
    sessionStoppedAt: restartedAt,
    activePromptNumber: null,
    lastError: null,
    writebackPolicy: "disabled",
    writebackApprovedAt: null,
  });
  const checkpoint = await readJson(checkpointFile, { lastPromptNumber: 0 });
  await writeJsonIfChanged(checkpointFile, {
    ...checkpoint,
    collaborationMode: "paused",
    bridgeStatus: "paused_by_service_restart",
    lastCheckedAt: restartedAt,
    lastError: null,
    sessionPausedAt: restartedAt,
  });
}

const initialExecutions = await readExecutions();
for (const execution of initialExecutions.executions.filter((item) => ["dispatching", "running"].includes(item.status))) {
  await setExecutionStatus(execution, "failed", { error: "server_restarted_during_execution" });
}

const initialWritebacks = await readWritebacks();
let recoveredWritebacks = false;
for (const message of initialWritebacks.messages) {
  if (message.status === "sending") {
    message.status = "pending";
    message.updatedAt = new Date().toISOString();
    message.error = "service_restarted_before_send_verification";
    message.statusHistory = [
      ...(message.statusHistory ?? []),
      { status: "pending", at: message.updatedAt, detail: "service_restart_recovery" },
    ];
    recoveredWritebacks = true;
  }
}
if (recoveredWritebacks) await saveWritebacks(initialWritebacks);

server.listen(port, host, () => {
  process.stdout.write(`AI Product Studio listening on http://${host}:${port}\n`);
  setTimeout(() => pumpExecutionQueue(), 0);
});

server.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  const stoppedAt = new Date().toISOString();
  await writeCollaborationState({
    mode: "stopped",
    bridgeStatus: "stopped_by_service_shutdown",
    sessionId: null,
    sessionStoppedAt: stoppedAt,
    activePromptNumber: null,
    lastError: null,
    writebackPolicy: "disabled",
    writebackApprovedAt: null,
  }).catch(() => {});
  const checkpoint = await readJson(checkpointFile, { lastPromptNumber: 0 }).catch(() => null);
  if (checkpoint) {
    await writeJsonIfChanged(checkpointFile, {
      ...checkpoint,
      collaborationMode: "paused",
      bridgeStatus: "paused_by_service_shutdown",
      lastCheckedAt: stoppedAt,
      lastError: null,
      sessionPausedAt: stoppedAt,
    }).catch(() => {});
  }
  if (bridgeProcess && bridgeProcess.exitCode === null) bridgeProcess.kill("SIGTERM");
  if (executionProcess && executionProcess.exitCode === null) executionProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => { void shutdown(); });
