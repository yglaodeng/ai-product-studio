import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeCommunicationTarget, selectBoundSafariConversation } from "./conversation-target.mjs";
import { buildIntentPrompt, normalizeUnderstanding } from "./intent-classifier.mjs";
import { extractWritebackId } from "./writeback.mjs";

const baseUrl = process.env.APS_BASE_URL || "http://127.0.0.5:8005";
const runtimeRoot = process.env.APS_RUNTIME_DIR || process.cwd();
const projectRoot = process.env.APS_PROJECT_ROOT;
const codexBin = process.env.APS_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const internalToken = process.env.APS_BRIDGE_INTERNAL_TOKEN;
const sessionId = process.env.APS_BRIDGE_SESSION_ID;
const simulation = process.env.APS_BRIDGE_SIMULATION === "1";
const communicationTarget = normalizeCommunicationTarget(JSON.parse(process.env.APS_COMMUNICATION_TARGET || "null"));
const conversationUrl = communicationTarget.conversationUrl;
const conversationId = new URL(conversationUrl).pathname.split("/").filter(Boolean).at(-1);
const conversationShortId = conversationId.split("-")[0];
let stopping = false;
let lastHeartbeatAt = 0;
let pendingAssistantSnapshot = null;
let pendingAssistantStableReads = 0;

if (!internalToken || !sessionId) throw new Error("bridge_session_configuration_required");

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `http_${response.status}`);
  return body;
}

async function updateWorker(patch) {
  return api("/api/collaboration/worker", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ sessionId, ...patch }),
  });
}

async function updateCheckpoint(patch) {
  return api("/api/sync/checkpoint", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function postEvent(event) {
  return api("/api/sync/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

async function updateTask(promptNumber, patch) {
  return api("/api/sync/tasks", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ promptNumber, ...patch }),
  });
}

async function saveTaskDraft(promptNumber, sourceContent, understanding) {
  return api("/api/task-drafts", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ promptNumber, sourceContent, ...understanding }),
  });
}

async function pendingWriteback() {
  return api(`/api/writebacks/pending?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${internalToken}` },
  });
}

async function updateWriteback(id, status, patch = {}) {
  return api(`/api/writebacks/${encodeURIComponent(id)}/worker`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ sessionId, status, ...patch }),
  });
}

function runProcess(command, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`process_failed:${command}:${code ?? signal}:${stderr.slice(-800)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

const safariScript = `
on run argv
  set targetUrl to item 1 of argv
  set browserJavascript to item 2 of argv
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
  if (count of matchingPayloads) is 0 then
    return "[{\\"error\\":\\"conversation_tab_not_found\\"}]"
  end if
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to ","
  set joinedPayloads to matchingPayloads as text
  set AppleScript's text item delimiters to previousDelimiters
  return "[" & joinedPayloads & "]"
end run`;

const safariWriteScript = `
on run argv
  set targetUrl to item 1 of argv
  set targetWindowId to (item 2 of argv) as integer
  set targetTabIndex to (item 3 of argv) as integer
  set insertJavascript to item 4 of argv
  set sendJavascript to item 5 of argv
  tell application "Safari"
    repeat with browserWindow in windows
      if ((id of browserWindow) as integer) = targetWindowId then
        set tabCounter to 0
        repeat with browserTab in tabs of browserWindow
          set tabCounter to tabCounter + 1
          if tabCounter = targetTabIndex then
            set insertResult to do JavaScript insertJavascript in browserTab
            delay 1
            set sendResult to do JavaScript sendJavascript in browserTab
            return sendResult
          end if
        end repeat
        return "{\\\"ok\\\":false,\\\"error\\\":\\\"selected_conversation_tab_not_found\\\"}"
      end if
    end repeat
  end tell
  return "{\\\"ok\\\":false,\\\"error\\\":\\\"selected_conversation_window_not_found\\\"}"
end run`;

const browserJavascript = `(() => {
  const hashText = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  };
  const messageNodes = [...document.querySelectorAll('main [data-message-author-role]')];
  const turns = [];
  for (const message of messageNodes) {
    const role = message.getAttribute('data-message-author-role');
    const contentNode = role === 'user'
      ? message.querySelector('[data-testid="collapsible-user-message-content"]')
      : null;
    const text = (contentNode?.innerText || message.innerText || '').trim();
    if ((role !== 'user' && role !== 'assistant') || !text) continue;
    const previousTurn = turns.at(-1);
    if (previousTurn?.role === role && previousTurn.text === text) continue;
    const messageId = message.getAttribute('data-message-id')
      || message.closest('[data-message-id]')?.getAttribute('data-message-id')
      || message.querySelector('[data-message-id]')?.getAttribute('data-message-id')
      || ('synthetic-' + role + '-' + hashText(text));
    turns.push({ role, messageId, text });
  }
  const promptNumbers = [...document.querySelectorAll('button[aria-label^="Prompt "]')]
    .map((button) => Number((button.getAttribute('aria-label') || '').match(/Prompt (\\d+)/)?.[1]))
    .filter(Number.isFinite);
  const pairs = [];
  let pendingUser = null;
  for (const turn of turns) {
    if (turn.role === 'user') pendingUser = turn;
    if (turn.role === 'assistant' && pendingUser) {
      pairs.push({
        user: pendingUser.text,
        userMessageId: pendingUser.messageId,
        assistant: turn.text,
        assistantMessageId: turn.messageId,
      });
      pendingUser = null;
    }
  }
  const maxPromptNumber = promptNumbers.length ? Math.max(...promptNumbers) : null;
  const numberedPairs = maxPromptNumber === null ? pairs : pairs.slice(-8).map((pair, index, visiblePairs) => ({
    ...pair,
    promptNumber: maxPromptNumber - (visiblePairs.length - 1 - index),
  }));
  const generating = [...document.querySelectorAll('button')].some((button) => /Stop generating|停止生成/.test(button.textContent || ''));
  return JSON.stringify({
    maxPromptNumber,
    pairs: numberedPairs,
    turns,
    generating,
    url: location.href,
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
  });
})()`;

function writebackInsertJavascript(message) {
  return `(() => {
    if (location.href !== ${JSON.stringify(conversationUrl)}) return JSON.stringify({ ok: false, error: 'selected_conversation_url_changed' });
    if (document.readyState !== 'complete' || !document.body?.isConnected || !document.querySelector('main')) {
      return JSON.stringify({ ok: false, error: 'selected_conversation_page_not_ready' });
    }
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[data-testid="prompt-textarea"]')
      || document.querySelector('main [contenteditable="true"]');
    if (!composer) return JSON.stringify({ ok: false, error: 'composer_not_found' });
    const existing = ((composer.value ?? composer.innerText) || '').trim();
    if (existing) return JSON.stringify({ ok: false, error: 'composer_not_empty' });
    composer.focus();
    const message = ${JSON.stringify(message)};
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, message); } catch {}
    if (!inserted) {
      if ('value' in composer) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(composer, message);
        else composer.value = message;
      } else {
        composer.textContent = message;
      }
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    }
    return JSON.stringify({ ok: true });
  })()`;
}

function writebackSendJavascript(message) {
  return `(() => {
  if (location.href !== ${JSON.stringify(conversationUrl)}) return JSON.stringify({ ok: false, error: 'selected_conversation_url_changed' });
  if (document.readyState !== 'complete' || !document.body?.isConnected || !document.querySelector('main')) {
    return JSON.stringify({ ok: false, error: 'selected_conversation_page_not_ready' });
  }
  const composer = document.querySelector('#prompt-textarea')
    || document.querySelector('[data-testid="prompt-textarea"]')
    || document.querySelector('main [contenteditable="true"]');
  const currentText = ((composer?.value ?? composer?.innerText) || '').trim();
  if (currentText !== ${JSON.stringify(message.trim())}) return JSON.stringify({ ok: false, error: 'composer_content_not_verified' });
  const button = document.querySelector('button[data-testid="send-button"]')
    || document.querySelector('button[aria-label="Send prompt"]')
    || document.querySelector('button[aria-label="发送提示"]');
  if (!button) return JSON.stringify({ ok: false, error: 'send_button_not_found' });
  if (button.disabled) return JSON.stringify({ ok: false, error: 'send_button_disabled' });
  button.click();
  return JSON.stringify({ ok: true });
})()`;
}

function normalizePairText(value) {
  return String(value || "").trim().replace(/\n+(?:展开|收起)$/, "").trim();
}

function pairKey(user, assistant) {
  return JSON.stringify([normalizePairText(user), normalizePairText(assistant)]);
}

function eventPairKey(event) {
  if (event?.source !== "safari-chatgpt" || typeof event.content !== "string") return null;
  const match = event.content.match(/^【用户】([\s\S]*?)\n\n【GPT】([\s\S]*)$/);
  return match ? pairKey(match[1], match[2]) : null;
}

function selectSafariConversation(payloads, checkpoint, seenPairKeys) {
  void checkpoint;
  void seenPairKeys;
  return selectBoundSafariConversation(payloads, communicationTarget);
}

async function readSafariConversation(checkpoint, seenPairKeys) {
  let stdout;
  try {
    ({ stdout } = await runProcess("/usr/bin/osascript", ["-e", safariScript, conversationUrl, browserJavascript]));
  } catch (error) {
    if (error.message.includes("Allow JavaScript from Apple Events")) {
      throw new Error("Safari 未开启“允许来自 Apple 事件的 JavaScript”。请在 Safari 设置的“开发者”中开启后重新启动同步。");
    }
    throw error;
  }
  const parsed = JSON.parse(stdout.trim());
  const wrappers = Array.isArray(parsed) ? parsed : [parsed];
  const payloads = wrappers.map((item) => item.page ? {
    ...item.page,
    location: {
      id: `safari-window-${item.windowId}-tab-${item.tabIndex}`,
      browser: "safari",
      windowId: item.windowId,
      windowIndex: item.windowIndex,
      tabIndex: item.tabIndex,
      label: `窗口 ${item.windowIndex} · 标签页 ${item.tabIndex}`,
    },
  } : item);
  return selectSafariConversation(payloads, checkpoint, seenPairKeys);
}

function conversationHasMarker(conversation, marker) {
  return Array.isArray(conversation?.turns)
    && conversation.turns.some((turn) => turn.role === "user" && String(turn.text).includes(marker));
}

async function writeToBoundSafari(message) {
  const location = communicationTarget.location;
  const { stdout } = await runProcess("/usr/bin/osascript", [
    "-e",
    safariWriteScript,
    conversationUrl,
    String(location.windowId),
    String(location.tabIndex),
    writebackInsertJavascript(message),
    writebackSendJavascript(message),
  ]);
  const result = JSON.parse(stdout.trim());
  if (!result.ok) throw new Error(result.error || "writeback_send_failed");
}

async function processPendingWriteback(checkpoint, seenPairKeys) {
  const response = await pendingWriteback();
  const message = response.message;
  if (!message) return false;
  try {
    let conversation = await readSafariConversation(checkpoint, seenPairKeys);
    if (conversationHasMarker(conversation, message.marker)) {
      await updateWriteback(message.id, "sent", { detail: "marker_found_before_send" });
      return true;
    }
    await updateWriteback(message.id, "sending", { detail: "writing_to_bound_conversation" });
    await writeToBoundSafari(message.content);
    await delay(1500);
    conversation = await readSafariConversation(checkpoint, seenPairKeys);
    if (!conversationHasMarker(conversation, message.marker)) throw new Error("sent_message_not_visible_after_send");
    await updateWriteback(message.id, "sent", { detail: "message_visible_in_bound_conversation" });
    await updateWorker({ bridgeStatus: "waiting_for_gpt", lastError: null, lastActivityAt: new Date().toISOString() });
    return true;
  } catch (error) {
    await updateWriteback(message.id, "failed", { error: error.message, detail: "writeback_attempt_failed" }).catch(() => {});
    await updateWorker({ bridgeStatus: "writeback_failed", lastError: error.message, lastActivityAt: new Date().toISOString() }).catch(() => {});
    return false;
  }
}

async function understandWithCodex(promptNumber, userText, assistantText, recentContext = "") {
  if (!projectRoot) throw new Error("aps_project_root_required");
  const outputFile = `/private/tmp/aps-understanding-${sessionId}-${promptNumber}.json`;
  const schemaFile = path.join(runtimeRoot, "task-understanding-schema.json");
  const prompt = buildIntentPrompt(userText, assistantText, recentContext);
  try {
    await runProcess(codexBin, [
      "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
      "--cd", projectRoot, "--output-schema", schemaFile, "--output-last-message", outputFile, "-",
    ], { cwd: projectRoot, input: prompt });
    return normalizeUnderstanding(JSON.parse(await readFile(outputFile, "utf8")), userText, assistantText, recentContext);
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}

async function processPair(pair, recentPairs = []) {
  const writebackId = extractWritebackId(pair.user);
  if (writebackId) {
    await updateWriteback(writebackId, "acknowledged", {
      promptNumber: pair.promptNumber,
      assistantReply: pair.assistant,
      detail: "gpt_response_captured",
    });
    await updateCheckpoint({
      lastPromptNumber: pair.promptNumber,
      lastAssistantMessageId: pair.assistantMessageId,
      collaborationMode: "active",
      bridgeStatus: "online",
      lastError: null,
    });
    await updateWorker({ bridgeStatus: "running", activePromptNumber: null, lastError: null, lastActivityAt: new Date().toISOString() });
    return;
  }
  const sourceId = `safari-${conversationShortId}-prompt-${pair.promptNumber}`;
  const sourceContent = `【用户】${pair.user}\n\n【GPT】${pair.assistant}`;
  const observedAt = new Date().toISOString();
  await updateTask(pair.promptNumber, {
    source: "safari-chatgpt",
    message: sourceContent,
    confirmed: false,
    status: "running",
    result: null,
    error: null,
    createdAt: observedAt,
    steps: {
      listened: { status: "success", at: observedAt },
      parsed: { status: "running", at: observedAt, detail: "正在判断内容类型与执行对象" },
      taskCreated: { status: "waiting", at: null, detail: "等待识别结果" },
      dispatched: { status: "waiting", at: null },
      codex: { status: "waiting", at: null },
      returned: { status: "waiting", at: null },
    },
  });
  await postEvent({
    id: sourceId,
    source: "safari-chatgpt",
    conversationId,
    turnId: `prompt-${pair.promptNumber}`,
    role: "assistant",
    content: sourceContent,
    confirmed: false,
    operations: [],
  });
  await updateCheckpoint({
    lastPromptNumber: pair.promptNumber,
    lastAssistantMessageId: pair.assistantMessageId,
    collaborationMode: "active",
    bridgeStatus: "online",
    lastError: null,
  });
  await updateWorker({ bridgeStatus: "understanding", activePromptNumber: pair.promptNumber, lastError: null });
  try {
    const recentContext = recentPairs.map((item) => `【用户】${item.user}\n【GPT】${item.assistant}`).join("\n\n");
    const understanding = await understandWithCodex(pair.promptNumber, pair.user, pair.assistant, recentContext);
    await saveTaskDraft(pair.promptNumber, sourceContent, understanding);
    const understoodAt = new Date().toISOString();
    await updateTask(pair.promptNumber, {
      status: "waiting",
      result: understanding.isTask ? `已生成任务草案：${understanding.title}` : understanding.reason,
      original_message: understanding.original_message,
      authorization_basis: understanding.authorization_basis,
      intent_type: understanding.intent_type,
      target_object: understanding.target_object,
      task_generated: understanding.task_generated,
      error: null,
      steps: {
        parsed: { status: "success", at: understoodAt, detail: understanding.reason },
        taskCreated: understanding.task_generated
          ? { status: "success", at: understoodAt, detail: "草案待用户修改与确认" }
          : { status: "waiting", at: null, detail: `${understanding.intent_type} · 不生成 Codex 任务` },
      },
    });
    await postEvent({
      id: `${sourceId}-understanding`,
      source: "aps-understanding",
      conversationId,
      turnId: `prompt-${pair.promptNumber}-understanding`,
      role: "system",
      content: understanding.task_generated
        ? `【任务理解】已生成草案“${understanding.title}”，等待用户在 APS 修改并确认。`
        : `【任务理解】${understanding.intent_type} / ${understanding.target_object}：${understanding.reason}`,
      confirmed: false,
      operations: [],
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await updateTask(pair.promptNumber, {
      status: "failed",
      error: error.message,
      errors: [error.message],
      steps: {
        parsed: { status: "failed", at: failedAt, detail: "任务理解失败" },
        taskCreated: { status: "failed", at: failedAt, detail: "未生成草案" },
      },
    });
    await postEvent({
      id: `${sourceId}-understanding-error`,
      source: "aps-understanding",
      conversationId,
      turnId: `prompt-${pair.promptNumber}-understanding-error`,
      role: "system",
      content: `【任务理解失败】${error.message}`,
      confirmed: false,
      operations: [],
    }).catch(() => {});
  }
  await updateWorker({ bridgeStatus: "running", activePromptNumber: null, lastError: null });
}

async function retryCurrentUnderstanding(checkpoint) {
  const taskResponse = await api("/api/sync/tasks");
  const tasks = Array.isArray(taskResponse) ? taskResponse : taskResponse.tasks || [];
  const task = tasks.find((item) => item.promptNumber === checkpoint.lastPromptNumber);
  if (task?.status !== "failed" || task.steps?.parsed?.status !== "failed") return false;

  const draftResponse = await api("/api/task-drafts");
  const drafts = Array.isArray(draftResponse) ? draftResponse : draftResponse.drafts || [];
  if (drafts.some((item) => item.promptNumber === checkpoint.lastPromptNumber)) return false;

  const match = typeof task.message === "string"
    ? task.message.match(/^【用户】([\s\S]*?)\n\n【GPT】([\s\S]*)$/)
    : null;
  if (!match || !checkpoint.lastAssistantMessageId) return false;

  await processPair({
    promptNumber: checkpoint.lastPromptNumber,
    user: match[1],
    assistant: match[2],
    assistantMessageId: checkpoint.lastAssistantMessageId,
  });
  return true;
}

async function runSimulation() {
  await updateWorker({ bridgeStatus: "simulation_running", lastError: null, lastActivityAt: new Date().toISOString() });
  await postEvent({
    id: `simulation-${sessionId}`,
    source: "simulation",
    role: "system",
    content: "隔离验收模式：页面已成功启动会话级 bridge，未读取 Safari 或 ChatGPT。",
    confirmed: false,
    operations: [],
  });
  while (!stopping) {
    const state = await api("/api/collaboration/status");
    if (state.mode !== "running" || state.sessionId !== sessionId) break;
    const pending = await pendingWriteback();
    if (pending.message) {
      await updateWriteback(pending.message.id, "sending", { detail: "simulation_send" });
      await updateWriteback(pending.message.id, "sent", { detail: "simulation_verified" });
      await updateWriteback(pending.message.id, "acknowledged", {
        detail: "simulation_gpt_response",
        assistantReply: "隔离模拟：已收到 APS 执行回传。",
      });
    }
    await delay(500);
  }
}

async function runLive() {
  await updateCheckpoint({ collaborationMode: "active", bridgeStatus: "connecting", lastError: null });
  await updateWorker({ bridgeStatus: "connecting", lastError: null });
  const eventResponse = await api("/api/sync/events");
  const events = Array.isArray(eventResponse) ? eventResponse : eventResponse.events || [];
  const seenPairKeys = new Set(events.map(eventPairKey).filter(Boolean));
  const startupCheckpoint = await api("/api/sync/checkpoint");
  await retryCurrentUnderstanding(startupCheckpoint);
  while (!stopping) {
    const collaboration = await api("/api/collaboration/status");
    if (collaboration.mode !== "running" || collaboration.sessionId !== sessionId) break;
    const checkpoint = await api("/api/sync/checkpoint");
    if (await processPendingWriteback(checkpoint, seenPairKeys)) {
      await delay(1500);
      continue;
    }
    const conversation = await readSafariConversation(checkpoint, seenPairKeys);
    const nativePromptNumbers = Number.isInteger(conversation.maxPromptNumber);
    const baselineIndex = checkpoint.lastAssistantMessageId
      ? conversation.pairs.findIndex((pair) => pair.assistantMessageId === checkpoint.lastAssistantMessageId)
      : -1;
    const hasVisibleBaseline = baselineIndex >= 0;
    const latestPair = conversation.pairs.at(-1);
    const hasUnpersistedLatest = Boolean(latestPair)
      && !seenPairKeys.has(pairKey(latestPair.user, latestPair.assistant));
    const hasNativeAdvance = nativePromptNumbers
      && conversation.maxPromptNumber > checkpoint.lastPromptNumber;
    const hasUnseenMessage = hasVisibleBaseline
      ? baselineIndex < conversation.pairs.length - 1
      : hasNativeAdvance
        || (hasUnpersistedLatest
          && (conversation.hasFocus === true || conversation.visibilityState === "visible"));
    const assistantSnapshot = latestPair ? `${latestPair.assistantMessageId}:${latestPair.assistant}` : null;
    if (hasUnseenMessage && assistantSnapshot) {
      if (assistantSnapshot === pendingAssistantSnapshot) pendingAssistantStableReads += 1;
      else {
        pendingAssistantSnapshot = assistantSnapshot;
        pendingAssistantStableReads = 1;
      }
    } else {
      pendingAssistantSnapshot = null;
      pendingAssistantStableReads = 0;
    }
    if (hasUnseenMessage && (conversation.generating || pendingAssistantStableReads < 2)) {
      await updateWorker({ bridgeStatus: "waiting_for_gpt", activePromptNumber: nativePromptNumbers ? conversation.maxPromptNumber : null });
      await delay(5000);
      continue;
    }
    let newPairs;
    if (hasVisibleBaseline) {
      newPairs = conversation.pairs.slice(baselineIndex + 1, baselineIndex + 4).map((pair, index) => ({
        ...pair,
        promptNumber: checkpoint.lastPromptNumber + index + 1,
      }));
    } else if (hasUnpersistedLatest) {
      newPairs = conversation.pairs
        .filter((pair) => !seenPairKeys.has(pairKey(pair.user, pair.assistant)))
        .slice(-1)
        .map((pair, index) => ({
          ...pair,
          promptNumber: checkpoint.lastPromptNumber + index + 1,
        }));
    } else if (nativePromptNumbers) {
      newPairs = conversation.pairs.filter((pair) => pair.promptNumber > checkpoint.lastPromptNumber).slice(0, 3);
    } else {
      if (!checkpoint.lastAssistantMessageId) throw new Error("message_id_baseline_required");
      if (baselineIndex < 0) throw new Error("message_id_baseline_not_visible");
      newPairs = conversation.pairs.slice(baselineIndex + 1, baselineIndex + 4).map((pair, index) => ({
        ...pair,
        promptNumber: checkpoint.lastPromptNumber + index + 1,
      }));
    }
    for (const pair of newPairs) {
      if (stopping) break;
      const pairIndex = conversation.pairs.findIndex((item) => item.assistantMessageId === pair.assistantMessageId);
      const recentPairs = pairIndex > 0 ? conversation.pairs.slice(Math.max(0, pairIndex - 2), pairIndex) : [];
      await processPair(pair, recentPairs);
      seenPairKeys.add(pairKey(pair.user, pair.assistant));
    }
    if (newPairs.length) {
      pendingAssistantSnapshot = null;
      pendingAssistantStableReads = 0;
    }
    if (Date.now() - lastHeartbeatAt > 30000) {
      lastHeartbeatAt = Date.now();
      await updateWorker({ bridgeStatus: "running", activePromptNumber: null, lastActivityAt: new Date().toISOString(), lastError: null });
    }
    await delay(5000);
  }
}

try {
  if (simulation) await runSimulation();
  else await runLive();
  await updateWorker({ bridgeStatus: "stopped", activePromptNumber: null, lastError: null });
  await updateCheckpoint({ collaborationMode: "paused", bridgeStatus: "paused_by_user", lastError: null });
} catch (error) {
  if (stopping && error.message === "stale_session") {
    await updateCheckpoint({ collaborationMode: "paused", bridgeStatus: "paused_by_user", lastError: null }).catch(() => {});
  } else {
    await updateWorker({ bridgeStatus: "blocked", activePromptNumber: null, lastError: error.message }).catch(() => {});
    await updateCheckpoint({ collaborationMode: "paused", bridgeStatus: "error", lastError: error.message }).catch(() => {});
    process.exitCode = 1;
  }
}
