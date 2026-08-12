const WRITEBACK_MARKER_PREFIX = "APS_WRITEBACK:";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function limitText(value, maxLength = 4000) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n……（APS 已截断过长结果）`;
}

function uniqueFiles(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.filter((item) => typeof item === "string" && item.trim()))];
}

function executionResult(execution) {
  return cleanText(execution?.result || execution?.executionResult || execution?.output);
}

function executionError(execution) {
  return cleanText(execution?.failureReason || execution?.error || execution?.lastError);
}

function testSummary(execution) {
  const test = execution?.testResult;
  if (!test || typeof test !== "object") return "未报告";
  const parts = [];
  if (Number.isFinite(test.passed) && Number.isFinite(test.total)) {
    parts.push(`${test.passed}/${test.total} passed`);
  }
  if (Number.isFinite(test.failed)) parts.push(`失败 ${test.failed}`);
  if (test.build) parts.push(`Build ${test.build}`);
  if (test.consoleErrors !== undefined && test.consoleErrors !== null) parts.push(`Console errors ${test.consoleErrors}`);
  return parts.join("；") || "未报告";
}

export function makeWritebackId(executionId, kind) {
  const safeExecutionId = cleanText(executionId).replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeKind = kind === "result" ? "result" : "progress";
  return `writeback-${safeExecutionId}-${safeKind}`;
}

export function writebackMarker(id) {
  return `[${WRITEBACK_MARKER_PREFIX}${id}]`;
}

export function extractWritebackId(text) {
  const match = cleanText(text).match(/\[APS_WRITEBACK:([a-zA-Z0-9._-]+)\]/);
  return match ? match[1] : null;
}

export function formatWritebackContent(execution, kind, id) {
  const isResult = kind === "result";
  const status = execution?.status === "completed" ? "已完成" : execution?.status === "failed" ? "失败" : "Codex 已开始执行";
  const lines = [
    isResult ? "【APS → GPT 执行结果回传】" : "【APS → GPT 执行进度回传】",
    writebackMarker(id),
    `回传编号：${id}`,
    `项目：${cleanText(execution?.projectName || execution?.project) || "未记录"}`,
    `任务：${cleanText(execution?.title || execution?.taskName) || "未记录"}`,
    `任务编号：${execution?.promptNumber ? `Prompt ${execution.promptNumber}` : cleanText(execution?.draftId) || "未记录"}`,
    `Execution ID：${cleanText(execution?.id || execution?.executionId) || "未记录"}`,
    `状态：${status}`,
  ];

  if (isResult) {
    const files = uniqueFiles(execution?.changedFiles);
    lines.push(`退出码：${execution?.exitCode ?? "未报告"}`);
    lines.push(`文件变化：${files.length ? files.join("、") : "未修改文件或未报告"}`);
    lines.push(`测试结果：${testSummary(execution)}`);
    const result = executionResult(execution);
    if (result) lines.push(`执行结果：\n${limitText(result)}`);
    const error = executionError(execution);
    if (error) lines.push(`错误信息：\n${limitText(error, 2000)}`);
  } else {
    lines.push("说明：APS 已完成派发，正在等待 Codex 执行与测试结果。");
  }

  lines.push("本消息由 APS 自动回传，仅用于同步执行进度与结果，不构成新的用户执行授权。");
  return lines.join("\n\n");
}

export function createWritebackRecord(execution, kind, target, now = new Date().toISOString()) {
  const executionId = cleanText(execution?.id || execution?.executionId);
  if (!executionId) throw new Error("execution_id_required");
  const id = makeWritebackId(executionId, kind);
  return {
    id,
    executionId,
    draftId: cleanText(execution?.draftId) || null,
    promptNumber: Number.isFinite(Number(execution?.promptNumber)) ? Number(execution.promptNumber) : null,
    kind: kind === "result" ? "result" : "progress",
    executionStatus: cleanText(execution?.status) || "running",
    provider: cleanText(target?.provider) || null,
    conversationTitle: cleanText(target?.conversationTitle) || null,
    conversationUrl: cleanText(target?.conversationUrl) || null,
    location: target?.location ? { ...target.location } : null,
    content: formatWritebackContent(execution, kind, id),
    marker: writebackMarker(id),
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    verifiedAt: null,
    acknowledgedAt: null,
    assistantReply: null,
    error: null,
    statusHistory: [{ status: "pending", at: now, detail: "execution_status_transition" }],
  };
}

export function writebackTargetMatches(record, target) {
  return Boolean(
    record &&
      target &&
      record.provider === target.provider &&
      record.conversationUrl === target.conversationUrl &&
      record.location?.windowId === target.location?.windowId &&
      Number(record.location?.tabIndex) === Number(target.location?.tabIndex),
  );
}
