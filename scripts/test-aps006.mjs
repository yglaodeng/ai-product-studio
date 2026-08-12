import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntentPrompt, normalizeUnderstanding } from "../intent-classifier.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaFile = path.join(projectRoot, "task-understanding-schema.json");
const codexBin = process.env.APS_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const cases = [
  {
    user: "请修改APS增加任务状态显示。",
    assistant: "可以，我会先整理修改范围。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true },
  },
  {
    user: "以后任务包必须完整复制，一个复制区域。",
    assistant: "明白，以后会按这个格式输出。",
    expected: { intent_type: "system_rule", target_object: "gpt", task_generated: false },
  },
  {
    user: "我觉得未来这个产品应该增加企业负责人视角。",
    assistant: "这个方向可以继续讨论。",
    expected: { intent_type: "product_discussion", target_object: "aps", task_generated: false },
  },
  {
    user: "我们测试一下 APS 是否能识别这个。",
    assistant: "我会发一条样本，观察 APS 如何分类。",
    expected: { intent_type: "system_validation", target_object: "aps", task_generated: false },
  },
  {
    user: "现在别再补了,越补越大,先进行已有功能测试,再发一个任务测试,看他是否能判断",
    assistant: "请执行 APS 项目构建检测，只运行 npm run build，不修改任何文件，并返回真实执行结果。",
    expected: { intent_type: "system_validation", target_object: "aps", task_generated: false },
  },
  {
    user: "请执行 APS 项目构建检测，只运行 npm run build，不修改任何文件，并返回真实执行结果。",
    assistant: "收到，等待 APS 生成人工确认草案。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true },
  },
  {
    user: "以上生成任务交给aps让codex执行",
    assistant: "我先确认交付格式。",
    recentContext: "【用户】我没看到后面要执行的内容和逻辑\n【GPT】下一步让 Codex 先输出 AI 数据工作台 V1.0 产品架构、数据流、模块设计和用户路径，暂不继续开发页面。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true, project: "AI 数据工作台" },
  },
  {
    user: "已经在监听了,开始吧",
    assistant: "好的，现在开始。",
    recentContext: "【用户】codex回复已经双向通了,你们测试一下\n【GPT】请执行 APS 双向回传链路测试。要求：不修改任何文件；返回 Execution ID 和当前任务状态。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true, project: "AI Product Studio", authorization_basis: "contextual_user_confirmation" },
  },
  {
    user: "你可以给Codex生成任务包了",
    assistant: "收到。",
    recentContext: "【用户】这个方向可以\n【GPT】任务名称：修复 AI 数据工作台导入页面。任务目标：修复空文件错误。执行要求：修改页面并运行测试。验收标准：测试全部通过。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true, project: "AI 数据工作台", authorization_basis: "contextual_user_confirmation" },
  },
  {
    user: "先别执行，我再看看",
    assistant: "好的。",
    recentContext: "【用户】先出方案\n【GPT】请修改 APS 页面并运行 npm run build。",
    expected: { task_generated: false, authorization_basis: "none" },
  },
  {
    user: "开始吧",
    assistant: "我们先讨论。",
    recentContext: "【用户】今天聊什么\n【GPT】可以讨论产品方向。",
    expected: { task_generated: false, authorization_basis: "none" },
  },
  {
    user: "那现在这样,我打开了监听,你下个任务看执行和回馈情况.我看着",
    assistant: "请执行 AI Data Workbench 项目健康检查，确认当前服务是否正常运行。只读取运行状态，不修改任何文件，并返回检查结果。",
    expected: { intent_type: "execution_task", target_object: "codex", task_generated: true, project: "AI 数据工作台", authorization_basis: "delegated_task_request" },
  },
  {
    user: "再发一个任务测试,看他是否能判断",
    assistant: "请执行 AI Data Workbench 项目健康检查，只读取运行状态，不修改文件。",
    expected: { intent_type: "system_validation", target_object: "aps", task_generated: false, authorization_basis: "none" },
  },
];

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`process_failed:${code ?? signal}:${stderr.slice(-1200)}`)));
    child.stdin.end(input);
  });
}

async function classify(testCase, index) {
  const outputFile = `/private/tmp/aps006-classification-${process.pid}-${index}.json`;
  try {
    await runProcess(codexBin, [
      "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
      "--cd", projectRoot, "--output-schema", schemaFile, "--output-last-message", outputFile, "-",
    ], buildIntentPrompt(testCase.user, testCase.assistant, testCase.recentContext));
    const result = normalizeUnderstanding(JSON.parse(await readFile(outputFile, "utf8")), testCase.user, testCase.assistant, testCase.recentContext);
    for (const [key, expected] of Object.entries(testCase.expected)) {
      if (result[key] !== expected) throw new Error(`case_${index + 1}_${key}:expected_${expected}:actual_${result[key]}`);
    }
    if (result.original_message !== testCase.user || result.priority !== "unassigned") {
      throw new Error(`case_${index + 1}_normalization_failed`);
    }
    return result;
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/task-drafts`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test_server_not_ready");
}

const classifications = [];
for (let index = 0; index < cases.length; index += 1) classifications.push(await classify(cases[index], index));

const contradictory = normalizeUnderstanding({
  intent_type: "system_rule",
  target_object: "codex",
  task_generated: true,
  isTask: true,
  needsExecution: true,
  project: "APS",
  title: "错误任务",
  goal: "不应生成",
  type: "development",
  priority: "unassigned",
  executionSuggestion: "不应执行",
  acceptanceCriteria: ["不应存在"],
  reason: "矛盾输入",
}, "以后回答不要重复解释。");
if (contradictory.task_generated || contradictory.isTask || contradictory.needsExecution) {
  throw new Error("normalization_gate_failed");
}

const runtimeRoot = await mkdtemp(path.join("/private/tmp", "aps006-e2e-"));
const dataRoot = path.join(runtimeRoot, "data");
const host = "127.0.0.1";
const port = 18106;
const baseUrl = `http://${host}:${port}`;
const token = "aps006-test-token";
await mkdir(dataRoot, { recursive: true });
await cp(path.join(projectRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "bridge-worker.mjs", "conversation-target.mjs", "intent-classifier.mjs", "writeback.mjs", "codex-result-schema.json", "task-understanding-schema.json", "project-registry.json"]) {
  await cp(path.join(projectRoot, file), path.join(runtimeRoot, file));
}
await writeJson(path.join(dataRoot, "sync-events.json"), { events: [] });
await writeJson(path.join(dataRoot, "sync-tasks.json"), { tasks: [] });
await writeJson(path.join(dataRoot, "execution-tasks.json"), { executions: [] });
await writeJson(path.join(dataRoot, "task-drafts.json"), { drafts: [] });
await writeJson(path.join(dataRoot, "collaboration-state.json"), { approvalStatus: "pending", mode: "stopped", bridgeStatus: "ready_for_review" });
await writeJson(path.join(dataRoot, "studio-state.json"), { nodes: [], positions: {}, versions: [], updatedAt: null });
await writeJson(path.join(dataRoot, "safari-sync-checkpoint.json"), { lastPromptNumber: 0, collaborationMode: "paused" });

const server = spawn(process.execPath, [path.join(runtimeRoot, "server.mjs")], {
  cwd: runtimeRoot,
  env: { ...process.env, APS_RUNTIME_DIR: runtimeRoot, APS_PROJECT_ROOT: projectRoot, APS_HOST: host, APS_PORT: String(port), APS_BRIDGE_INTERNAL_TOKEN: token },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitForServer(baseUrl);
  for (let index = 0; index < classifications.length; index += 1) {
    const result = classifications[index];
    const promptNumber = 960 + index;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const draftResponse = await fetch(`${baseUrl}/api/task-drafts`, { method: "PUT", headers, body: JSON.stringify({ promptNumber, sourceContent: cases[index].user, ...result }) });
    if (!draftResponse.ok) throw new Error(`draft_persistence_${index + 1}:${draftResponse.status}`);
    const taskResponse = await fetch(`${baseUrl}/api/sync/tasks`, { method: "PUT", headers, body: JSON.stringify({
      promptNumber,
      message: cases[index].user,
      original_message: result.original_message,
      intent_type: result.intent_type,
      target_object: result.target_object,
      task_generated: result.task_generated,
      steps: { parsed: { status: "success", at: new Date().toISOString(), detail: result.reason }, taskCreated: { status: result.task_generated ? "success" : "waiting", at: null } },
    }) });
    if (!taskResponse.ok) throw new Error(`task_persistence_${index + 1}:${taskResponse.status}`);
  }

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const gateResponse = await fetch(`${baseUrl}/api/task-drafts`, { method: "PUT", headers, body: JSON.stringify({
    promptNumber: 999,
    sourceContent: "测试 APS 是否能判断任务类型",
    original_message: "测试 APS 是否能判断任务类型",
    intent_type: "execution_task",
    target_object: "codex",
    task_generated: true,
    isTask: true,
    needsExecution: true,
    project: "APS",
    title: "错误生成的自测任务",
    goal: "不应派发",
    type: "testing",
    priority: "unassigned",
    executionSuggestion: "不应执行",
    acceptanceCriteria: ["不应生成任务"],
    reason: "模拟模型误判",
  }) });
  if (!gateResponse.ok) throw new Error(`gate_persistence:${gateResponse.status}`);

  const drafts = (await (await fetch(`${baseUrl}/api/task-drafts`)).json()).drafts;
  const tasks = (await (await fetch(`${baseUrl}/api/sync/tasks`)).json()).tasks;
  const expectedStatuses = classifications.map((result) => result.task_generated ? "pending" : "not_task");
  for (let index = 0; index < classifications.length; index += 1) {
    const draft = drafts.find((item) => item.promptNumber === 960 + index);
    const task = tasks.find((item) => item.promptNumber === 960 + index);
    if (draft.status !== expectedStatuses[index] || draft.intent_type !== classifications[index].intent_type || draft.target_object !== classifications[index].target_object || draft.task_generated !== classifications[index].task_generated) {
      throw new Error(`draft_fields_${index + 1}_mismatch:${JSON.stringify({ expected: classifications[index], actual: draft })}`);
    }
    if (task.intent_type !== classifications[index].intent_type || task.target_object !== classifications[index].target_object || task.task_generated !== classifications[index].task_generated) {
      throw new Error(`task_fields_${index + 1}_mismatch`);
    }
  }
  const guardedDraft = drafts.find((item) => item.promptNumber === 999);
  if (guardedDraft.status !== "not_task" || guardedDraft.intent_type !== "system_validation" || guardedDraft.target_object !== "aps" || guardedDraft.task_generated !== false || guardedDraft.isTask !== false) {
    throw new Error("server_gate_failed");
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    cases: classifications.map((result, index) => ({ input: cases[index].user, intent_type: result.intent_type, target_object: result.target_object, task_generated: result.task_generated, status: expectedStatuses[index] })),
    contradictoryInputBlocked: true,
    originalMessagePersisted: drafts.slice(0, cases.length).every((draft, index) => draft.original_message === cases[index].user),
    historyFieldsPersisted: tasks.length === cases.length,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(runtimeRoot, { recursive: true, force: true });
}
