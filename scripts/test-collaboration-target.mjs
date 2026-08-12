import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultCommunicationTarget,
  normalizeCommunicationTarget,
  selectBoundSafariConversation,
} from "../conversation-target.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = await mkdtemp(path.join("/private/tmp", "aps-target-e2e-"));
const dataRoot = path.join(runtimeRoot, "data");
const host = "127.0.0.1";
const port = 18112;
const baseUrl = `http://${host}:${port}`;

function readTemplateLiteral(source, name) {
  const prefix = `const ${name} = \``;
  const start = source.indexOf(prefix);
  const end = source.indexOf("`;", start + prefix.length);
  if (start < 0 || end < 0) throw new Error(`template_not_found:${name}`);
  return Function(`return \`${source.slice(start + prefix.length, end)}\`;`)();
}

for (const [file, name] of [["server.mjs", "safariLocationScript"], ["bridge-worker.mjs", "safariScript"], ["bridge-worker.mjs", "safariWriteScript"]]) {
  const source = await readFile(path.join(projectRoot, file), "utf8");
  const compiled = spawnSync("/usr/bin/osacompile", [
    "-e",
    readTemplateLiteral(source, name),
    "-o",
    path.join(runtimeRoot, `${name}.scpt`),
  ], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(`applescript_compile_failed:${file}:${name}:${compiled.stderr}`);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function requestJson(url, options) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/collaboration/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test_server_not_ready");
}

const target = normalizeCommunicationTarget({
  ...defaultCommunicationTarget,
  conversationTitle: "公开隔离测试会话",
  conversationUrl: "https://chatgpt.com/c/example-public-test",
  location: {
    id: "safari-window-22-tab-1",
    browser: "safari",
    windowId: 22,
    windowIndex: 2,
    tabIndex: 1,
    label: "窗口 2 · 标签页 1",
  },
});
const candidates = [{
  url: target.conversationUrl,
  maxPromptNumber: 999,
  location: { windowId: 11, windowIndex: 1, tabIndex: 1 },
}, {
  url: target.conversationUrl,
  maxPromptNumber: 332,
  location: { windowId: 22, windowIndex: 2, tabIndex: 1 },
}];
const selected = selectBoundSafariConversation(candidates, target);
if (selected.location.windowId !== 22 || selected.maxPromptNumber !== 332) {
  throw new Error(`exact_location_selection_failed:${JSON.stringify(selected)}`);
}
let missingLocationError = null;
try {
  selectBoundSafariConversation(candidates, {
    ...target,
    location: { ...target.location, windowId: 33 },
  });
} catch (error) {
  missingLocationError = error.message;
}
if (missingLocationError !== "selected_conversation_location_not_found") {
  throw new Error(`missing_location_gate_failed:${missingLocationError}`);
}
let unsupportedProviderError = null;
try {
  normalizeCommunicationTarget({ ...target, provider: "claude" });
} catch (error) {
  unsupportedProviderError = error.message;
}
if (unsupportedProviderError !== "collaboration_provider_not_supported") {
  throw new Error(`unsupported_provider_gate_failed:${unsupportedProviderError}`);
}

await mkdir(dataRoot, { recursive: true });
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of [
  "server.mjs",
  "bridge-worker.mjs",
  "conversation-target.mjs",
  "intent-classifier.mjs",
  "writeback.mjs",
  "codex-result-schema.json",
  "task-understanding-schema.json",
  "project-registry.json",
]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
const now = new Date().toISOString();
await writeJson(path.join(dataRoot, "collaboration-state.json"), {
  version: 1,
  approvalStatus: "pending",
  approvedAt: null,
  mode: "stopped",
  bridgeStatus: "ready_for_review",
});
await writeJson(path.join(dataRoot, "safari-sync-checkpoint.json"), {
  lastPromptNumber: 332,
  collaborationMode: "paused",
  bridgeStatus: "paused_by_user",
  lastError: null,
});
await writeJson(path.join(dataRoot, "sync-events.json"), { events: [] });
await writeJson(path.join(dataRoot, "sync-tasks.json"), { tasks: [] });
await writeJson(path.join(dataRoot, "execution-tasks.json"), { executions: [] });
await writeJson(path.join(dataRoot, "task-drafts.json"), { drafts: [] });
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
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitForServer();
  const models = await requestJson("/api/collaboration/models");
  if (!models.response.ok || models.payload.models.find((model) => model.id === "chatgpt")?.status !== "available") {
    throw new Error(`chatgpt_model_missing:${JSON.stringify(models.payload)}`);
  }
  if (models.payload.models.filter((model) => ["claude", "gemini"].includes(model.id)).some((model) => model.status !== "unavailable")) {
    throw new Error(`unsupported_models_not_marked:${JSON.stringify(models.payload)}`);
  }

  const saved = await requestJson("/api/collaboration/target", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!saved.response.ok || saved.payload.saved !== true || saved.payload.changed !== true) {
    throw new Error(`target_save_failed:${saved.response.status}:${JSON.stringify(saved.payload)}`);
  }
  if (saved.payload.state.version !== 2 || saved.payload.state.approvalStatus !== "pending" || saved.payload.state.communicationTarget.location.windowId !== 22) {
    throw new Error(`target_persistence_failed:${JSON.stringify(saved.payload.state)}`);
  }

  const approval = await requestJson("/api/collaboration/approval", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, writebackPolicy: "progress_and_result" }),
  });
  if (!approval.response.ok || approval.payload.approvalStatus !== "approved") {
    throw new Error(`approval_failed:${approval.response.status}:${JSON.stringify(approval.payload)}`);
  }

  const started = await requestJson("/api/collaboration/start", { method: "POST" });
  if (started.response.status !== 202) {
    throw new Error(`start_failed:${started.response.status}:${JSON.stringify(started.payload)}`);
  }
  let runningState;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ({ payload: runningState } = await requestJson("/api/collaboration/status"));
    if (runningState.processRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!runningState.processRunning || runningState.communicationTarget.location.windowId !== 22) {
    throw new Error(`running_target_missing:${JSON.stringify(runningState)}`);
  }

  const locked = await requestJson("/api/collaboration/target", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...target,
      location: { ...target.location, id: "safari-window-33-tab-1", windowId: 33, windowIndex: 3, label: "窗口 3 · 标签页 1" },
    }),
  });
  if (locked.response.status !== 409 || locked.payload.error !== "collaboration_target_locked_while_running") {
    throw new Error(`running_target_lock_failed:${locked.response.status}:${JSON.stringify(locked.payload)}`);
  }

  const stopped = await requestJson("/api/collaboration/stop", { method: "POST" });
  if (!stopped.response.ok) throw new Error(`stop_failed:${stopped.response.status}:${JSON.stringify(stopped.payload)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const finalStatus = (await requestJson("/api/collaboration/status")).payload;
  const checkpoint = (await requestJson("/api/sync/checkpoint")).payload;
  if (finalStatus.mode !== "stopped" || finalStatus.processRunning || finalStatus.communicationTarget.location.windowId !== 22) {
    throw new Error(`stop_state_failed:${JSON.stringify(finalStatus)}`);
  }
  if (checkpoint.lastPromptNumber !== 332 || checkpoint.bridgeStatus !== "paused_by_user") {
    throw new Error(`checkpoint_changed:${JSON.stringify(checkpoint)}`);
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    exactLocationSelected: selected.location,
    higherPromptCandidateIgnored: true,
    missingLocationError,
    unsupportedProviderError,
    models: models.payload.models,
    targetSaved: saved.payload.state.communicationTarget,
    runningTargetLocked: true,
    checkpointPreserved: checkpoint.lastPromptNumber,
    runtimeRoot,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(runtimeRoot, { recursive: true, force: true });
}
