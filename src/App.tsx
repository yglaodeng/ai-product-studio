import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { hierarchy, tree } from "d3-hierarchy";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  ClockCounterClockwise,
  CircleNotch,
  Crosshair,
  FloppyDisk,
  GitBranch,
  LockKey,
  Minus,
  NotePencil,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Robot,
  ShieldCheck,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import projectMap from "./project-map.json";

type StudioNode = {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  kind?: "portfolio" | "product" | "module" | "capability";
  collapsed?: boolean;
};

type SyncOperation =
  | { type: "add_node"; node: Partial<StudioNode> & Pick<StudioNode, "title"> }
  | { type: "update_node"; id: string; title?: string; description?: string }
  | { type: "delete_node"; id: string }
  | { type: "move_node"; id: string; parentId: string | null };

type SyncEvent = {
  id: string;
  source?: string;
  conversationId?: string;
  turnId?: string;
  role?: "user" | "assistant" | "system";
  content: string;
  confirmed?: boolean;
  operations?: SyncOperation[];
  receivedAt: string;
};

type TaskStageStatus = "waiting" | "running" | "success" | "failed";
type IntentType = "execution_task" | "system_rule" | "system_validation" | "product_discussion" | "ordinary_chat" | "unclassified";
type TargetObject = "codex" | "gpt" | "aps" | "none" | "unclassified";
type CollaborationPanel = "pending" | "confirmed" | "non_task" | "rejected" | "records";
type CollaborationSectionState = Record<CollaborationPanel, boolean>;
type CollaborationPageState = Record<CollaborationPanel, number>;
type TaskStep = { status: TaskStageStatus; at: string | null; detail?: string };
type SyncTask = {
  id: string;
  promptNumber: number;
  source: string;
  message: string;
  confirmed: boolean;
  status: TaskStageStatus;
  result: string | null;
  error: string | null;
  errors: string[];
  createdAt: string;
  updatedAt: string;
  original_message?: string;
  intent_type?: IntentType;
  target_object?: TargetObject;
  task_generated?: boolean;
  steps: {
    listened: TaskStep;
    parsed: TaskStep;
    taskCreated: TaskStep;
    confirmed: TaskStep;
    dispatched: TaskStep;
    codex: TaskStep;
    returned: TaskStep;
  };
};

type TaskDraftStatus = "pending" | "confirmed" | "dispatching" | "running" | "testing" | "completed" | "failed" | "rejected" | "not_task";
type TaskDraft = {
  id: string;
  promptNumber: number;
  sourceContent: string;
  isTask: boolean;
  needsExecution: boolean;
  project: string;
  title: string;
  goal: string;
  type: "development" | "bugfix" | "design" | "research" | "testing" | "documentation" | "operations" | "discussion";
  priority: "unassigned" | "high" | "medium" | "low";
  executionSuggestion: string;
  acceptanceCriteria: string[];
  reason: string;
  original_message?: string;
  intent_type?: IntentType;
  target_object?: TargetObject;
  task_generated?: boolean;
  status: TaskDraftStatus;
  createdAt: string;
  updatedAt: string;
  executionId?: string;
  executionResult?: string | null;
  executionError?: string | null;
};

type ProjectRegistration = {
  id: string;
  name: string;
  path: string;
  description: string;
  status: "active" | "inactive";
  allowedExecutionScopes: string[];
};

type ExecutionStatus = "confirmed" | "dispatching" | "running" | "testing" | "completed" | "failed";
type ExecutionFileChanges = { added: string[]; modified: string[]; deleted: string[] };
type ExecutionTestResult = {
  status: "passed" | "failed" | "not_reported";
  total: number | null;
  passed: number | null;
  failed: number | null;
  build: "success" | "failed" | null;
  consoleErrors: number | null;
  evidenceSource: string;
  summary: string | null;
};
type ExecutionRecord = {
  id: string;
  draftId: string;
  promptNumber: number;
  project: string;
  title: string;
  status: ExecutionStatus;
  command?: string;
  executionMode?: string;
  workspacePath?: string;
  confirmedAt?: string | null;
  dispatchedAt?: string | null;
  startedAt?: string | null;
  testingAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  result?: string | null;
  error?: string | null;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  fileChanges?: ExecutionFileChanges;
  testResult?: ExecutionTestResult;
  statusHistory?: Array<{ status: ExecutionStatus; at: string; detail: string }>;
};

type Version = { id: string; createdAt: string; nodes: StudioNode[]; label: string };
type PositionMap = Record<string, { x: number; y: number }>;
type View = "map" | "discussion" | "history";
type TreeDatum = { item: StudioNode; children: TreeDatum[] };
type CollaborationModel = { id: string; name: string; status: "available" | "unavailable"; browser: "safari"; reason?: string };
type ConversationLocation = {
  id: string;
  browser: "safari";
  windowId: number;
  windowIndex: number;
  tabIndex: number;
  label: string;
  title?: string;
  conversationUrl?: string;
  isFrontWindow?: boolean;
  isCurrentTab?: boolean;
  hasFocus?: boolean;
  visibilityState?: string;
  maxPromptNumber?: number | null;
};
type CommunicationTarget = {
  provider: string;
  providerName: string;
  browser: "safari";
  conversationTitle: string;
  conversationUrl: string;
  location: ConversationLocation | null;
  configuredAt: string | null;
};
type CollaborationState = {
  approvalStatus: "pending" | "approved";
  approvedAt: string | null;
  mode: "stopped" | "running";
  bridgeStatus: string;
  processRunning: boolean;
  scheduledAutomation: "REMOVED";
  sessionStartedAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  conversationTitle: string;
  conversationUrl: string;
  communicationTarget: CommunicationTarget;
  executionScope: "aps-only" | "registered-projects";
  writebackPolicy: "disabled" | "progress_and_result";
  writebackApprovedAt: string | null;
};
type WritebackRecord = {
  id: string;
  executionId: string;
  promptNumber: number | null;
  kind: "progress" | "result";
  executionStatus: string;
  status: "pending" | "sending" | "sent" | "acknowledged" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  assistantReply: string | null;
  error: string | null;
};

const initialCommunicationTarget: CommunicationTarget = {
  provider: "chatgpt",
  providerName: "ChatGPT",
  browser: "safari",
  conversationTitle: "派",
  conversationUrl: "",
  location: null,
  configuredAt: null,
};

const initialCollaborationModels: CollaborationModel[] = [
  { id: "chatgpt", name: "ChatGPT", status: "available", browser: "safari" },
  { id: "claude", name: "Claude", status: "unavailable", browser: "safari", reason: "读取适配器尚未接入" },
  { id: "gemini", name: "Gemini", status: "unavailable", browser: "safari", reason: "读取适配器尚未接入" },
];

const initialCollaboration: CollaborationState = {
  approvalStatus: "pending",
  approvedAt: null,
  mode: "stopped",
  bridgeStatus: "ready_for_review",
  processRunning: false,
  scheduledAutomation: "REMOVED",
  sessionStartedAt: null,
  lastActivityAt: null,
  lastError: null,
  conversationTitle: "派",
  conversationUrl: "",
  communicationTarget: initialCommunicationTarget,
  executionScope: "registered-projects",
  writebackPolicy: "disabled",
  writebackApprovedAt: null,
};

const COLLABORATION_PAGE_SIZE = 10;
const initialSectionState: CollaborationSectionState = {
  pending: false,
  confirmed: false,
  non_task: false,
  rejected: false,
  records: false,
};
const initialPageState: CollaborationPageState = {
  pending: 1,
  confirmed: 1,
  non_task: 1,
  rejected: 1,
  records: 1,
};

const intentLabels: Record<IntentType, string> = {
  execution_task: "执行任务",
  system_rule: "系统规则",
  system_validation: "系统验收测试",
  product_discussion: "产品讨论",
  ordinary_chat: "普通交流",
  unclassified: "历史未分类",
};

const targetLabels: Record<TargetObject, string> = {
  codex: "Codex",
  gpt: "GPT",
  aps: "APS",
  none: "无",
  unclassified: "未记录",
};

function intentTypeOf(record: { intent_type?: IntentType }): IntentType {
  return record.intent_type ?? "unclassified";
}

function targetObjectOf(record: { target_object?: TargetObject }): TargetObject {
  return record.target_object ?? "unclassified";
}

function taskGeneratedOf(record: { task_generated?: boolean; isTask?: boolean; steps?: SyncTask["steps"] }): boolean {
  return record.task_generated ?? record.isTask ?? record.steps?.taskCreated.status === "success";
}

function IntentAudit({ record, reason }: { record: { original_message?: string; intent_type?: IntentType; target_object?: TargetObject; task_generated?: boolean; isTask?: boolean; steps?: SyncTask["steps"]; message?: string; sourceContent?: string }; reason: string }) {
  const intentType = intentTypeOf(record);
  const targetObject = targetObjectOf(record);
  return <div className="intent-audit">
    <div className="intent-audit__message"><small>原始内容</small><span>{record.original_message || record.sourceContent || record.message || "未记录"}</span></div>
    <div><small>内容类型</small><strong>{intentLabels[intentType]}</strong></div>
    <div><small>执行对象</small><strong>{targetLabels[targetObject]}</strong></div>
    <div><small>是否生成任务</small><strong>{taskGeneratedOf(record) ? "是" : "否"}</strong></div>
    <div className="intent-audit__reason"><small>判断原因</small><span>{reason}</span></div>
  </div>;
}

const STORAGE = {
  nodes: "aps.v01.nodes",
  positions: "aps.v01.positions",
  discussions: "aps.v01.discussions",
  versions: "aps.v01.versions",
  processed: "aps.v01.processed-sync-events",
};

const initialNodes: StudioNode[] = projectMap as StudioNode[];

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readCollaborationPanels(): CollaborationPanel[] {
  const stored = readStorage<string[]>("aps.v01.collaboration-panels", ["pending"]);
  const valid: CollaborationPanel[] = ["pending", "confirmed", "non_task", "rejected", "records"];
  const migrated = stored.map((panel) => panel === "understanding" ? "pending" : panel);
  const panels = [...new Set(migrated.filter((panel): panel is CollaborationPanel => valid.includes(panel as CollaborationPanel)))];
  return panels.length ? panels : ["pending"];
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / COLLABORATION_PAGE_SIZE));
}

function pageItems<T>(items: T[], page: number): T[] {
  const start = (page - 1) * COLLABORATION_PAGE_SIZE;
  return items.slice(start, start + COLLABORATION_PAGE_SIZE);
}

function SectionPagination({ label, page, total, onChange }: { label: string; page: number; total: number; onChange: (page: number) => void }) {
  const pages = pageCount(total);
  if (pages <= 1) return null;
  return <nav className="section-pagination" aria-label={`${label}分页`}>
    <button aria-label={`${label}上一页`} title="上一页" disabled={page === 1} onClick={() => onChange(page - 1)}><CaretLeft size={13} /></button>
    <div>{Array.from({ length: pages }, (_, index) => index + 1).map((number) => <button key={number} className={number === page ? "active" : ""} aria-label={`${label}第 ${number} 页`} aria-current={number === page ? "page" : undefined} onClick={() => onChange(number)}>{number}</button>)}</div>
    <button aria-label={`${label}下一页`} title="下一页" disabled={page === pages} onClick={() => onChange(page + 1)}><CaretRight size={13} /></button>
    <span>第 {page} / {pages} 页</span>
  </nav>;
}

function CollaborationSectionHeading({ label, description, total, collapsed, onToggle, live }: { label: string; description: string; total: number; collapsed: boolean; onToggle: () => void; live?: boolean }) {
  return <div className="understanding-heading">
    <div><h2>{label}</h2><span>{description}</span></div>
    <div className="section-heading-actions">
      {live && <em><CircleNotch size={13} className="spin" />监听中，等待新回合</em>}
      <small>{total} 条</small>
      <button className="section-collapse" aria-label={collapsed ? `展开${label}` : `折叠${label}`} aria-expanded={!collapsed} title={collapsed ? "展开" : "折叠"} onClick={onToggle}>{collapsed ? <CaretRight size={14} /> : <CaretDown size={14} />}</button>
    </div>
  </div>;
}

function diagnosticText(error?: string | null): string {
  if (!error) return "";
  if (error.includes("collaboration_target_locked_while_running")) return "同步运行期间不能切换沟通目标，请先停止本次协作";
  if (error.includes("collaboration_target_location_required")) return "尚未指定 Safari 窗口和标签页";
  if (error.includes("collaboration_provider_not_supported")) return "该大模型读取适配器尚未接入";
  if (error.includes("selected_conversation_location_not_found")) return "已绑定的 Safari 位置不存在或已移动，请重新检测并选择";
  if (error.includes("safari_not_running")) return "Safari 未运行，无法检测会话位置";
  if (error.includes("safari_javascript_disabled")) return "Safari 未允许来自 Apple 事件的 JavaScript";
  if (error.includes("conversation_tab_not_found")) return "Safari 中没有找到已绑定的精确会话地址";
  if (error.includes("conversation_url_mismatch")) return "Safari 会话地址与已绑定目标不一致";
  if (error.includes("message_id_baseline_not_visible")) return "同步基线不可见：无法可靠定位上次已同步回复";
  if (error.includes("message_id_baseline_required")) return "尚未建立消息基线：需要重新初始化同步位置";
  if (error.includes("spawn codex ENOENT")) return "Codex 启动失败：系统未找到 Codex 可执行文件";
  if (error.includes("unsupported_execution_request")) return "任务未进入 Codex：当前执行策略仅允许用户明确要求的 npm run build 构建验收";
  return error.replace(/^codex_execution_failed:/, "Codex 执行失败：");
}

function isExecutionPolicyRejection(error?: string | null): boolean {
  return Boolean(error?.includes("unsupported_execution_request"));
}

function descendantsOf(nodes: StudioNode[], id: string): Set<string> {
  const result = new Set<string>();
  const visit = (parentId: string) => {
    nodes.filter((item) => item.parentId === parentId).forEach((item) => {
      result.add(item.id);
      visit(item.id);
    });
  };
  visit(id);
  return result;
}

function visibleNodes(nodes: StudioNode[]): StudioNode[] {
  const hidden = new Set<string>();
  nodes.filter((item) => item.collapsed).forEach((item) => {
    descendantsOf(nodes, item.id).forEach((id) => hidden.add(id));
  });
  return nodes.filter((item) => !hidden.has(item.id));
}

function autoPositions(nodes: StudioNode[]): PositionMap {
  const root = nodes.find((item) => item.parentId === null);
  if (!root) return {};
  const makeTree = (item: StudioNode): TreeDatum => ({
    item,
    children: nodes.filter((child) => child.parentId === item.id).map(makeTree),
  });
  const layout = tree<TreeDatum>().nodeSize([118, 250]);
  const laidOut = layout(hierarchy(makeTree(root)));
  const minX = Math.min(...laidOut.descendants().map((item) => item.x));
  return Object.fromEntries(
    laidOut.descendants().map((item) => [item.data.item.id, { x: item.depth * 250 + 80, y: item.x - minX + 90 }]),
  );
}

type MapNodeData = {
  studio: StudioNode;
  selected: boolean;
  childCount: number;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
};

function ProductMapNode({ data }: NodeProps<Node<MapNodeData>>) {
  const { studio, selected, childCount, onSelect, onToggle } = data;
  const kindLabel = studio.kind === "portfolio" ? "PORTFOLIO" : studio.kind === "product" ? "PRODUCT" : studio.kind === "module" ? "MODULE" : "CAPABILITY";
  return (
    <div className={`map-node ${selected ? "map-node--selected" : ""}`} onClick={() => onSelect(studio.id)}>
      <Handle type="target" position={Position.Left} />
      <div className="map-node__eyebrow">{kindLabel}</div>
      <div className="map-node__title">{studio.title}</div>
      {studio.description && <div className="map-node__description">{studio.description}</div>}
      {childCount > 0 && (
        <button
          className="map-node__toggle"
          aria-label={studio.collapsed ? "展开节点" : "折叠节点"}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(studio.id);
          }}
        >
          {studio.collapsed ? <Plus size={12} weight="bold" /> : <Minus size={12} weight="bold" />}
          <span>{childCount}</span>
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { product: ProductMapNode };

function formatExecutionTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未记录";
}

function legacyTestResult(execution: ExecutionRecord): ExecutionTestResult {
  const text = `${execution.result ?? ""}\n${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;
  const fraction = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:tests?\s*)?(?:passed|通过)/i);
  const passedOnly = text.match(/(?:^|\s)(\d+)\s+(?:tests?\s+)?passed\b/i);
  const allPassedZh = text.match(/(\d+)\s*项[^\n。；;]{0,30}(?:全部通过|全通过)/);
  const passed = fraction ? Number(fraction[1]) : passedOnly ? Number(passedOnly[1]) : allPassedZh ? Number(allPassedZh[1]) : null;
  const total = fraction ? Number(fraction[2]) : passed;
  const failed = total === null || passed === null ? null : Math.max(0, total - passed);
  const build = execution.executionMode === "build" ? (execution.exitCode === 0 ? "success" : "failed") : null;
  return {
    status: execution.exitCode !== 0 ? "failed" : total !== null || build === "success" ? "passed" : "not_reported",
    total,
    passed,
    failed,
    build,
    consoleErrors: null,
    evidenceSource: "historical_execution_result",
    summary: total === null && build === null ? "历史执行结果中未识别到结构化测试计数。" : "从历史 Codex 返回结果中提取。",
  };
}

function ExecutionDetails({ draft, execution }: { draft: TaskDraft; execution: ExecutionRecord }) {
  const history = execution.statusHistory ?? [];
  const historyStatuses = new Set(history.map((item) => item.status));
  const lifecycle: Array<{ key: "pending" | ExecutionStatus; label: string }> = [
    { key: "pending", label: "任务生成" },
    { key: "confirmed", label: "用户确认" },
    { key: "dispatching", label: "派发 Codex" },
    { key: "running", label: "Codex 执行" },
    { key: "testing", label: "结果核验" },
    { key: execution.status === "failed" ? "failed" : "completed", label: execution.status === "failed" ? "执行失败" : "结果返回" },
  ];
  const fileChanges = execution.fileChanges;
  const legacyChanges = !fileChanges ? execution.changedFiles ?? [] : [];
  const testResult = execution.testResult ?? legacyTestResult(execution);
  const executionLog = [execution.stdout, execution.stderr].filter((item) => item?.trim()).join("\n\n").trim();
  const suggestions = execution.status === "completed"
    ? ["查看并验收实际修改内容", "根据测试结果决定是否继续下一项开发任务", "如需进一步验证，创建新的待确认任务草案"]
    : execution.status === "failed"
      ? ["先查看失败原因和执行日志", "修正任务范围或验收条件后再决定是否重试"]
      : ["等待当前执行阶段完成", "执行期间无需重复确认或创建同名任务"];

  return <section className="execution-center" aria-label={`Prompt ${draft.promptNumber} Codex 执行详情`}>
    <div className="execution-center__heading"><div><h3>Codex 执行详情</h3><span>依据 Execution ID 关联的真实持久化记录</span></div><b className={`execution-status execution-status--${execution.status}`}>{execution.status === "completed" ? "已完成" : execution.status === "failed" ? "失败" : execution.status === "testing" ? "核验中" : execution.status === "running" ? "执行中" : execution.status === "dispatching" ? "派发中" : "已确认"}</b></div>
    <ol className="execution-lifecycle">
      {lifecycle.map((stage, index) => {
        const codexStarted = Boolean(execution.startedAt);
        const historicalTestingMissing = stage.key === "testing" && codexStarted && !historyStatuses.has("testing") && ["completed", "failed"].includes(execution.status);
        const active = stage.key === execution.status;
        const dispatchFailed = stage.key === "dispatching" && execution.status === "failed" && !codexStarted;
        const complete = stage.key === "pending"
          || stage.key === "confirmed" && historyStatuses.has("confirmed")
          || stage.key === "dispatching" && codexStarted
          || stage.key === "running" && codexStarted && ["testing", "completed", "failed"].includes(execution.status)
          || stage.key === "testing" && historyStatuses.has("testing") && ["completed", "failed"].includes(execution.status);
        const stageClass = active ? `active ${execution.status === "failed" ? "failed" : ""}` : dispatchFailed ? "failed" : complete ? "complete" : historicalTestingMissing ? "unrecorded" : "waiting";
        const stageText = historicalTestingMissing ? "历史未记录" : dispatchFailed ? "派发失败" : active ? "当前阶段" : complete ? "已完成" : stage.key === "running" && !codexStarted && execution.status === "failed" ? "未开始" : "等待";
        return <li key={`${stage.key}-${index}`} className={stageClass}><span>{active && !["completed", "failed"].includes(execution.status) ? <CircleNotch size={14} className="spin" /> : complete ? <Check size={14} weight="bold" /> : <Minus size={14} />}</span><div><strong>{stage.label}</strong><small>{stageText}</small></div></li>;
      })}
    </ol>
    <div className="execution-facts">
      <div><small>Execution ID</small><code>{execution.id}</code></div>
      <div><small>执行项目</small><strong>{execution.project}</strong></div>
      <div className="execution-facts__wide"><small>执行目录</small><code>{execution.workspacePath || "尚未派发"}</code></div>
      <div><small>执行方式</small><strong>{execution.command || execution.executionMode || "尚未记录"}</strong></div>
      <div><small>Exit Code</small><strong>{execution.exitCode ?? "尚未结束"}</strong></div>
      <div><small>开始时间</small><span>{formatExecutionTime(execution.startedAt)}</span></div>
      <div><small>结束时间</small><span>{formatExecutionTime(execution.completedAt)}</span></div>
    </div>
    <div className="execution-block">
      <h4>执行时间线</h4>
      <ol className="execution-timeline">
        <li><time>{formatExecutionTime(draft.createdAt)}</time><span>任务草案生成</span></li>
        {history.map((item) => <li key={`${item.status}-${item.at}`}><time>{formatExecutionTime(item.at)}</time><span>{item.detail}</span></li>)}
      </ol>
    </div>
    <div className="execution-block">
      <h4>文件变化</h4>
      {fileChanges ? <div className="file-change-groups">
        {(["added", "modified", "deleted"] as const).map((kind) => <div key={kind}><strong>{kind === "added" ? "新增文件" : kind === "modified" ? "修改文件" : "删除文件"} <span>{fileChanges[kind].length}</span></strong>{fileChanges[kind].length ? <ul>{fileChanges[kind].map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <small>无</small>}</div>)}
      </div> : legacyChanges.length ? <div className="legacy-file-changes"><small>该历史任务只保存了变更文件清单，无法可靠区分新增、修改和删除。</small><ul>{legacyChanges.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div> : <p className="execution-empty">未修改文件。</p>}
    </div>
    <div className="execution-block">
      <h4>测试结果</h4>
      <div className="test-evidence">
        <div><small>测试状态</small><strong className={`test-evidence--${testResult.status}`}>{testResult.status === "passed" ? "通过" : testResult.status === "failed" ? "失败" : "未报告"}</strong></div>
        <div><small>通过 / 总数</small><strong>{testResult.passed ?? "-"} / {testResult.total ?? "-"}</strong></div>
        <div><small>失败数量</small><strong>{testResult.failed ?? "-"}</strong></div>
        <div><small>Build</small><strong>{testResult.build ?? "未单独执行"}</strong></div>
        <div><small>Console errors</small><strong>{testResult.consoleErrors ?? "未报告"}</strong></div>
      </div>
      {testResult.summary && <p className="execution-note">{testResult.summary}</p>}
    </div>
    {execution.error && <div className="record-error execution-failure"><WarningCircle size={15} /><div><small>失败原因</small><span>{diagnosticText(execution.error)}</span></div></div>}
    <details className="execution-log"><summary>执行日志与返回结果</summary>{executionLog && <><h4>进程日志</h4><pre>{executionLog}</pre></>}<h4>Codex 返回结果</h4><pre>{execution.result || "尚未返回结果。"}</pre>{execution.error && <div className="record-error"><WarningCircle size={15} /><div><small>失败原因</small><span>{diagnosticText(execution.error)}</span></div></div>}</details>
    <div className="execution-block execution-next"><h4>下一步建议</h4><ul>{suggestions.map((item) => <li key={item}>{item}</li>)}</ul><small>仅提供建议，不会自动执行。</small></div>
  </section>;
}

function TaskDraftCard({ draft, execution, projects, onChanged }: { draft: TaskDraft; execution?: ExecutionRecord; projects: ProjectRegistration[]; onChanged: (draft: TaskDraft) => void }) {
  const [form, setForm] = useState(draft);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(draft.status !== "pending");
  useEffect(() => {
    setForm(draft);
    setCollapsed(draft.status !== "pending");
  }, [draft.id, draft.updatedAt, draft.status]);

  if (!draft.isTask) {
    const intentType = intentTypeOf(draft);
    return <article className={`understanding-item understanding-item--discussion understanding-item--${intentType} ${collapsed ? "understanding-item--collapsed" : ""}`}>
      <div className="draft-meta"><span>Prompt {draft.promptNumber}</span><b>{intentLabels[intentType]}</b><em>不生成 Codex 任务</em><time>{new Date(draft.createdAt).toLocaleString("zh-CN")}</time><button className="draft-collapse" onClick={() => setCollapsed((current) => !current)} aria-label={collapsed ? `展开非任务记录 Prompt ${draft.promptNumber}` : `收起非任务记录 Prompt ${draft.promptNumber}`} title={collapsed ? "展开" : "收起"}>{collapsed ? <CaretRight size={14} /> : <CaretDown size={14} />}</button></div>
      {!collapsed && <IntentAudit record={draft} reason={draft.reason} />}
    </article>;
  }

  const editable = draft.status === "pending";
  const acceptanceText = form.acceptanceCriteria.join("\n");
  const updateField = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const response = await fetch(`/api/task-drafts/${draft.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: form.project,
        title: form.title,
        goal: form.goal,
        type: form.type,
        priority: form.priority,
        executionSuggestion: form.executionSuggestion,
        acceptanceCriteria: form.acceptanceCriteria,
      }),
    });
    const payload = await response.json().catch(() => ({})) as { draft?: TaskDraft; error?: string };
    if (!response.ok || !payload.draft) throw new Error(payload.error || "draft_save_failed");
    onChanged(payload.draft);
    return payload.draft;
  };
  const runAction = async (action: "save" | "confirm" | "reject") => {
    setUpdating(true);
    setError(null);
    try {
      if (action === "save") {
        await save();
        return;
      }
      if (action === "confirm") await save();
      const response = await fetch(`/api/task-drafts/${draft.id}/${action}`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { draft?: TaskDraft; error?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.error || `draft_${action}_failed`);
      onChanged(payload.draft);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "草案操作失败");
    } finally {
      setUpdating(false);
    }
  };
  const retryFailedExecution = async () => {
    if (!draft.executionId) return;
    setUpdating(true);
    setError(null);
    try {
      const response = await fetch(`/api/executions/${draft.executionId}/retry`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { draft?: TaskDraft; error?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.error || "execution_retry_failed");
      onChanged(payload.draft);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "失败任务检查失败");
    } finally {
      setUpdating(false);
    }
  };
  const confirmReady = Boolean(form.project.trim() && form.title.trim() && form.goal.trim() && form.priority !== "unassigned" && form.acceptanceCriteria.length);
  const selectedProject = projects.find((project) => project.name === form.project);
  const scopeLabels: Record<string, string> = { build: "构建验收", read_document: "注册文档只读", development: "受控开发" };
  const allowedScopeText = selectedProject?.allowedExecutionScopes.map((scope) => scopeLabels[scope] ?? scope).join("、") || "未配置执行范围";
  const projectGuidance = editable && !form.project
    ? "项目需要你选择：APS 没有从用户原始消息中得到唯一项目名称，当前同步记录也没有包含截图内容，无法仅凭“右侧这部分”可靠确定执行目录。"
    : editable && error === "unsupported_execution_workspace" && selectedProject
      ? `项目范围不匹配：${selectedProject.name} 当前只允许“${allowedScopeText}”，本任务没有命中允许范围。请在上方选择页面实际所属项目，或修改任务要求。`
      : null;
  const statusCopy: Record<TaskDraftStatus, { label: string; detail: string }> = {
    pending: { label: "待确认", detail: draft.needsExecution ? "需后续执行" : "仅记录" },
    confirmed: { label: "已确认", detail: draft.executionId ? "等待串行派发" : "历史确认，未进入 APS-005" },
    dispatching: { label: "派发中", detail: "正在创建执行请求" },
    running: { label: "执行中", detail: "Codex 正在构建验收" },
    testing: { label: "核验中", detail: "正在核验真实执行证据" },
    completed: { label: "已完成", detail: "执行结果已回写" },
    failed: { label: "执行失败", detail: "错误已回写" },
    rejected: { label: "已拒绝", detail: "不会派发" },
    not_task: { label: "普通交流", detail: "仅记录" },
  };
  const policyRejected = draft.status === "failed" && isExecutionPolicyRejection(draft.executionError);
  const status = policyRejected
    ? { label: "未派发", detail: "执行策略已拦截" }
    : statusCopy[draft.status];

  return <article className={`understanding-item understanding-item--${draft.status} ${collapsed ? "understanding-item--collapsed" : ""}`}>
    <div className="draft-meta"><span>Prompt {draft.promptNumber}</span><b>{status.label}</b><em>{status.detail}</em><time>{new Date(draft.createdAt).toLocaleString("zh-CN")}</time>{draft.status !== "pending" && <button className="draft-collapse" onClick={() => setCollapsed((current) => !current)} aria-label={collapsed ? `展开${status.label}任务 Prompt ${draft.promptNumber}` : `收起${status.label}任务 Prompt ${draft.promptNumber}`} title={collapsed ? "展开" : "收起"}>{collapsed ? <CaretRight size={14} /> : <CaretDown size={14} />}</button>}</div>
    {!collapsed && <><div className="draft-fields">
      <label><span>执行项目</span><select value={form.project} disabled={!editable} onChange={(event) => { updateField("project", event.target.value); setError(null); }}><option value="">请选择执行项目</option>{projects.filter((project) => project.status === "active").map((project) => <option key={project.id} value={project.name}>{project.name}</option>)}</select></label>
      <label><span>任务名称</span><input value={form.title} disabled={!editable} onChange={(event) => updateField("title", event.target.value)} /></label>
      <label className="draft-field--wide"><span>任务目标</span><textarea value={form.goal} disabled={!editable} onChange={(event) => updateField("goal", event.target.value)} /></label>
      <label><span>类型</span><select value={form.type} disabled={!editable} onChange={(event) => updateField("type", event.target.value as TaskDraft["type"])}><option value="development">开发</option><option value="bugfix">修复</option><option value="design">设计</option><option value="research">研究</option><option value="testing">测试</option><option value="documentation">文档</option><option value="operations">运维</option></select></label>
      <label><span>优先级（由你决定）</span><select value={form.priority} disabled={!editable} onChange={(event) => updateField("priority", event.target.value as TaskDraft["priority"])}><option value="unassigned">未设置</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      <label className="draft-field--wide"><span>执行建议</span><textarea value={form.executionSuggestion} disabled={!editable} onChange={(event) => updateField("executionSuggestion", event.target.value)} /></label>
      <label className="draft-field--wide"><span>验收标准（每行一项）</span><textarea value={acceptanceText} disabled={!editable} onChange={(event) => updateField("acceptanceCriteria", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label>
    </div>
    {projectGuidance && <div className="draft-guidance"><WarningCircle size={14} /><div><strong>需要确认执行项目</strong><span>{projectGuidance}</span></div></div>}
    <IntentAudit record={draft} reason={draft.reason} />
    {execution && <ExecutionDetails draft={draft} execution={execution} />}
    {draft.executionResult && <div className="record-result"><Check size={15} /><div><small>Codex 返回结果</small><span>{draft.executionResult}</span></div></div>}
    {draft.executionError && <div className="record-error"><WarningCircle size={15} /><div><small>{policyRejected ? "派发说明" : "执行错误"}</small><span>{diagnosticText(draft.executionError)}</span></div></div>}
    {error && !["project_selection_required", "unsupported_execution_workspace"].includes(error) && <div className="draft-error"><WarningCircle size={14} />{error === "unregistered_project" ? "该项目未注册，不能保存或执行。" : error === "complete_draft_and_priority_required" ? "请补全草案、选择优先级并至少填写一条验收标准。" : error === "retry_review_failed_workspace_unresolved" ? "检查未能解析受控项目，未重新派发。" : error === "retry_already_active" ? "该失败任务已有一条重试正在执行。" : error}</div>}
    {editable && <div className="draft-actions"><button onClick={() => runAction("reject")} disabled={updating}>拒绝</button><button onClick={() => runAction("save")} disabled={updating}>保存修改</button><button className="draft-confirm" onClick={() => runAction("confirm")} disabled={updating || !confirmReady}><Check size={14} weight="bold" />确认草案</button></div>}
    {draft.status === "failed" && draft.executionId && <div className="draft-actions"><button className="draft-retry" onClick={retryFailedExecution} disabled={updating}><ArrowClockwise size={14} weight="bold" />{updating ? "正在检查" : "检查并重新执行"}</button></div>}</>}
  </article>;
}

function AppContent() {
  const [nodes, setNodes] = useState<StudioNode[]>(() => readStorage(STORAGE.nodes, initialNodes));
  const [positions, setPositions] = useState<PositionMap>(() => readStorage(STORAGE.positions, {}));
  const [discussions, setDiscussions] = useState<SyncEvent[]>(() => readStorage(STORAGE.discussions, []));
  const [versions, setVersions] = useState<Version[]>(() => readStorage(STORAGE.versions, []));
  const [processed, setProcessed] = useState<string[]>(() => readStorage(STORAGE.processed, []));
  const [studioHydrated, setStudioHydrated] = useState(false);
  const processedRef = useRef(new Set(processed));
  const [selectedId, setSelectedId] = useState("understand");
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [view, setView] = useState<View>("map");
  const [syncState, setSyncState] = useState<"connecting" | "online" | "offline">("connecting");
  const [collaboration, setCollaboration] = useState<CollaborationState>(initialCollaboration);
  const [collaborationModels, setCollaborationModels] = useState<CollaborationModel[]>(initialCollaborationModels);
  const [targetDraft, setTargetDraft] = useState<CommunicationTarget>(initialCommunicationTarget);
  const [targetLocations, setTargetLocations] = useState<ConversationLocation[]>([]);
  const [targetDirty, setTargetDirty] = useState(false);
  const [targetDiscovering, setTargetDiscovering] = useState(false);
  const [targetSaving, setTargetSaving] = useState(false);
  const [syncTasks, setSyncTasks] = useState<SyncTask[]>([]);
  const [taskDrafts, setTaskDrafts] = useState<TaskDraft[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRegistration[]>([]);
  const [writebacks, setWritebacks] = useState<WritebackRecord[]>([]);
  const [sessionUpdating, setSessionUpdating] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalChecks, setApprovalChecks] = useState([false, false, false, false]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(() => readStorage("aps.v01.rail-collapsed", false));
  const [structureCollapsed, setStructureCollapsed] = useState(() => readStorage("aps.v01.structure-collapsed", false));
  const [collaborationMenuOpen, setCollaborationMenuOpen] = useState(() => readStorage("aps.v01.collaboration-menu-open", true));
  const [collaborationPanels, setCollaborationPanels] = useState<CollaborationPanel[]>(readCollaborationPanels);
  const [collapsedSections, setCollapsedSections] = useState<CollaborationSectionState>(() => readStorage("aps.v01.collaboration-section-collapsed", initialSectionState));
  const [collaborationPages, setCollaborationPages] = useState<CollaborationPageState>(initialPageState);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => localStorage.setItem(STORAGE.nodes, JSON.stringify(nodes)), [nodes]);
  useEffect(() => localStorage.setItem(STORAGE.positions, JSON.stringify(positions)), [positions]);
  useEffect(() => localStorage.setItem(STORAGE.discussions, JSON.stringify(discussions)), [discussions]);
  useEffect(() => localStorage.setItem(STORAGE.versions, JSON.stringify(versions)), [versions]);
  useEffect(() => localStorage.setItem(STORAGE.processed, JSON.stringify(processed)), [processed]);
  useEffect(() => localStorage.setItem("aps.v01.rail-collapsed", JSON.stringify(railCollapsed)), [railCollapsed]);
  useEffect(() => localStorage.setItem("aps.v01.structure-collapsed", JSON.stringify(structureCollapsed)), [structureCollapsed]);
  useEffect(() => localStorage.setItem("aps.v01.collaboration-menu-open", JSON.stringify(collaborationMenuOpen)), [collaborationMenuOpen]);
  useEffect(() => localStorage.setItem("aps.v01.collaboration-panels", JSON.stringify(collaborationPanels)), [collaborationPanels]);
  useEffect(() => localStorage.setItem("aps.v01.collaboration-section-collapsed", JSON.stringify(collapsedSections)), [collapsedSections]);

  useEffect(() => {
    if (!targetDirty) setTargetDraft(collaboration.communicationTarget ?? initialCommunicationTarget);
  }, [collaboration.communicationTarget, targetDirty]);

  useEffect(() => {
    fetch("/api/studio/state")
      .then((response) => response.json())
      .then((state: { nodes?: StudioNode[]; positions?: PositionMap; versions?: Version[] }) => {
        if (Array.isArray(state.nodes) && state.nodes.length) setNodes(state.nodes);
        if (state.positions && typeof state.positions === "object") setPositions(state.positions);
        if (Array.isArray(state.versions)) setVersions(state.versions);
      })
      .finally(() => setStudioHydrated(true));
  }, []);

  useEffect(() => {
    if (!studioHydrated) return;
    const save = window.setTimeout(() => {
      fetch("/api/studio/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, positions, versions, updatedAt: new Date().toISOString() }),
      }).catch(() => setSyncState("offline"));
    }, 500);
    return () => window.clearTimeout(save);
  }, [nodes, positions, studioHydrated, versions]);

  const selected = nodes.find((item) => item.id === selectedId) ?? nodes[0];
  const shownNodes = useMemo(() => visibleNodes(nodes), [nodes]);
  const generatedPositions = useMemo(() => autoPositions(shownNodes), [shownNodes]);

  const toggleNode = useCallback((id: string) => {
    setNodes((current) => current.map((item) => (item.id === id ? { ...item, collapsed: !item.collapsed } : item)));
  }, []);

  const applyOperations = useCallback((operations: SyncOperation[]) => {
    setNodes((current) => {
      let next = [...current];
      operations.forEach((operation) => {
        if (operation.type === "add_node") {
          const parentId = operation.node.parentId ?? next[0]?.id ?? null;
          const id = operation.node.id ?? `node-${crypto.randomUUID()}`;
          if (!next.some((item) => item.id === id)) {
            next.push({ id, parentId, title: operation.node.title, description: operation.node.description ?? "" });
          }
        }
        if (operation.type === "update_node") {
          next = next.map((item) => item.id === operation.id ? { ...item, title: operation.title ?? item.title, description: operation.description ?? item.description } : item);
        }
        if (operation.type === "move_node") {
          const illegal = operation.parentId === operation.id || descendantsOf(next, operation.id).has(operation.parentId ?? "");
          if (!illegal) next = next.map((item) => item.id === operation.id ? { ...item, parentId: operation.parentId } : item);
        }
        if (operation.type === "delete_node") {
          const remove = descendantsOf(next, operation.id);
          remove.add(operation.id);
          next = next.filter((item) => !remove.has(item.id));
        }
      });
      return next;
    });
  }, []);

  const acceptSyncEvent = useCallback((event: SyncEvent) => {
    if (!event.id || processedRef.current.has(event.id)) return;
    processedRef.current.add(event.id);
    setProcessed((current) => [...current, event.id]);
    setDiscussions((current) => [...current, event]);
    if (event.confirmed && event.operations?.length) applyOperations(event.operations);
  }, [applyOperations]);

  useEffect(() => {
    const pullEvents = () => fetch("/api/sync/events")
      .then((response) => response.json())
      .then((payload: { events: SyncEvent[] }) => payload.events.forEach(acceptSyncEvent))
      .catch(() => setSyncState("offline"));
    const pullCollaboration = () => fetch("/api/collaboration/status")
      .then((response) => response.json())
      .then((state: CollaborationState) => setCollaboration({
        ...initialCollaboration,
        ...state,
        communicationTarget: { ...initialCommunicationTarget, ...(state.communicationTarget ?? {}) },
      }))
      .catch(() => setSyncState("offline"));
    const pullCollaborationModels = () => fetch("/api/collaboration/models")
      .then((response) => response.json())
      .then((payload: { models: CollaborationModel[] }) => setCollaborationModels(payload.models))
      .catch(() => setCollaborationModels(initialCollaborationModels));
    const pullTasks = () => fetch("/api/sync/tasks")
      .then((response) => response.json())
      .then((payload: { tasks: SyncTask[] }) => setSyncTasks(payload.tasks))
      .catch(() => setSyncState("offline"));
    const pullDrafts = () => fetch("/api/task-drafts")
      .then((response) => response.json())
      .then((payload: { drafts: TaskDraft[] }) => setTaskDrafts(payload.drafts))
      .catch(() => setSyncState("offline"));
    const pullExecutions = () => fetch("/api/executions")
      .then((response) => response.json())
      .then((payload: { executions: ExecutionRecord[] }) => setExecutions(payload.executions))
      .catch(() => setSyncState("offline"));
    const pullProjects = () => fetch("/api/projects")
      .then((response) => response.json())
      .then((payload: { projects: ProjectRegistration[] }) => setProjects(payload.projects))
      .catch(() => setSyncState("offline"));
    const pullWritebacks = () => fetch("/api/writebacks")
      .then((response) => response.json())
      .then((payload: { messages: WritebackRecord[] }) => setWritebacks(payload.messages))
      .catch(() => setSyncState("offline"));
    pullEvents();
    pullCollaboration();
    pullCollaborationModels();
    pullTasks();
    pullDrafts();
    pullExecutions();
    pullProjects();
    pullWritebacks();
    const polling = window.setInterval(() => {
      pullEvents();
      pullCollaboration();
      pullTasks();
      pullDrafts();
      pullExecutions();
      pullWritebacks();
    }, 2000);
    const stream = new EventSource("/api/sync/stream");
    stream.onopen = () => setSyncState("online");
    stream.onmessage = (message) => acceptSyncEvent(JSON.parse(message.data) as SyncEvent);
    stream.onerror = () => setSyncState("offline");
    return () => {
      window.clearInterval(polling);
      stream.close();
    };
  }, [acceptSyncEvent]);

  const bridgeRunning = collaboration.mode === "running" && collaboration.processRunning;
  const selectedCollaborationModel = collaborationModels.find((model) => model.id === targetDraft.provider);
  const targetReady = selectedCollaborationModel?.status === "available"
    && Boolean(targetDraft.conversationTitle.trim())
    && Boolean(targetDraft.conversationUrl.trim())
    && Boolean(targetDraft.location);
  const targetStartReady = targetReady && !targetDirty && Boolean(collaboration.communicationTarget.location);
  const latestTask = syncTasks.at(-1);
  const latestWriteback = writebacks[0];
  const pendingTaskDrafts = taskDrafts.filter((draft) => draft.isTask && draft.status === "pending");
  const confirmedTaskDrafts = taskDrafts.filter((draft) => draft.isTask && ["confirmed", "dispatching", "running", "testing", "completed", "failed"].includes(draft.status));
  const nonTaskDrafts = taskDrafts.filter((draft) => !draft.isTask || draft.status === "not_task");
  const rejectedTaskDrafts = taskDrafts.filter((draft) => draft.status === "rejected");
  useEffect(() => {
    const totals: Record<CollaborationPanel, number> = {
      pending: pendingTaskDrafts.length,
      confirmed: confirmedTaskDrafts.length,
      non_task: nonTaskDrafts.length,
      rejected: rejectedTaskDrafts.length,
      records: syncTasks.length,
    };
    setCollaborationPages((current) => {
      const next = { ...current };
      let changed = false;
      (Object.keys(totals) as CollaborationPanel[]).forEach((section) => {
        const clamped = Math.min(current[section], pageCount(totals[section]));
        if (clamped !== current[section]) {
          next[section] = clamped;
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [confirmedTaskDrafts.length, nonTaskDrafts.length, pendingTaskDrafts.length, rejectedTaskDrafts.length, syncTasks.length]);
  const toggleSection = (section: CollaborationPanel) => setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  const setSectionPage = (section: CollaborationPanel, page: number) => setCollaborationPages((current) => ({ ...current, [section]: page }));
  const sessionStartedAt = collaboration.sessionStartedAt ? new Date(collaboration.sessionStartedAt).getTime() : 0;
  const latestCodexTask = [...syncTasks].reverse().find((task) =>
    task.steps.codex.status !== "waiting"
    && !isExecutionPolicyRejection(task.error)
    && new Date(task.updatedAt).getTime() >= sessionStartedAt,
  );
  const stageLabels: Array<[keyof SyncTask["steps"], string, string]> = [
    ["listened", "消息监听", "读取固定会话新回合"],
    ["parsed", "内容解析", "校验用户与模型回复"],
    ["taskCreated", "任务生成", "识别明确执行指令"],
    ["confirmed", "任务确认", "用户人工确认草案"],
    ["dispatched", "任务派发", "提交给本地 Codex"],
    ["codex", "Codex 执行", "仅限 APS 工作区"],
    ["returned", "结果返回", "写入协作记录"],
  ];
  const statusText: Record<TaskStageStatus, string> = {
    waiting: "等待",
    running: "执行中",
    success: "成功",
    failed: "失败",
  };
  const bridgeHealth: TaskStageStatus = ["error", "blocked"].includes(collaboration.bridgeStatus)
    ? "failed"
    : bridgeRunning
      ? "success"
      : "waiting";
  const listenerHealth: TaskStageStatus = collaboration.bridgeStatus === "waiting_for_gpt"
    ? "running"
    : bridgeHealth;
  const codexHealth: TaskStageStatus = latestCodexTask?.steps.codex.status ?? "waiting";
  const recentHealth: TaskStageStatus = latestTask?.status ?? "waiting";
  const writebackHealth: TaskStageStatus = !latestWriteback
    ? "waiting"
    : latestWriteback.status === "failed"
      ? "failed"
      : latestWriteback.status === "acknowledged"
        ? "success"
        : "running";
  const displayedSyncState = syncState === "offline" || ["error", "blocked"].includes(collaboration.bridgeStatus)
    ? "offline"
    : !bridgeRunning || collaboration.bridgeStatus === "paused_locked"
      ? "paused"
      : syncState;
  const displayedSyncText = displayedSyncState === "offline"
    ? diagnosticText(collaboration.lastError) || "协作通道异常"
    : collaboration.approvalStatus !== "approved"
      ? "待你验收，未启动"
      : !bridgeRunning
        ? `${collaboration.communicationTarget.providerName} 协作已停止`
      : collaboration.bridgeStatus === "paused_locked"
        ? "Safari 锁屏，同步暂停"
      : ["online", "running"].includes(collaboration.bridgeStatus)
        ? `${collaboration.communicationTarget.providerName} 同步运行中`
        : collaboration.bridgeStatus === "understanding"
          ? "正在理解任务意图"
        : collaboration.bridgeStatus === "executing"
          ? "Codex 正在执行任务"
          : "协作进程正在启动";

  const refreshCollaboration = async () => {
    const response = await fetch("/api/collaboration/status");
    if (!response.ok) throw new Error("无法读取协作状态");
    const state = await response.json() as CollaborationState;
    setCollaboration({
      ...initialCollaboration,
      ...state,
      communicationTarget: { ...initialCommunicationTarget, ...(state.communicationTarget ?? {}) },
    });
  };
  const acceptDraftChange = (changed: TaskDraft) => setTaskDrafts((current) => {
    const index = current.findIndex((draft) => draft.id === changed.id);
    if (index < 0) return [...current, changed];
    return current.map((draft) => draft.id === changed.id ? changed : draft);
  });

  const runCollaborationAction = async (action: "start" | "stop") => {
    setSessionUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/collaboration/${action}`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "collaboration_action_failed");
      await refreshCollaboration();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setSessionUpdating(false);
    }
  };

  const updateTargetField = (field: "provider" | "conversationTitle" | "conversationUrl", value: string) => {
    const model = collaborationModels.find((item) => item.id === (field === "provider" ? value : targetDraft.provider));
    setTargetDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "provider" ? { providerName: model?.name ?? value } : {}),
      location: null,
    }));
    setTargetLocations([]);
    setTargetDirty(true);
    setActionError(null);
  };

  const discoverTargetLocations = async () => {
    setTargetDiscovering(true);
    setActionError(null);
    try {
      const search = new URLSearchParams({
        provider: targetDraft.provider,
        conversationTitle: targetDraft.conversationTitle,
        conversationUrl: targetDraft.conversationUrl,
      });
      const response = await fetch(`/api/collaboration/locations?${search.toString()}`);
      const payload = await response.json().catch(() => ({})) as { locations?: ConversationLocation[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "conversation_location_discovery_failed");
      const locations = payload.locations ?? [];
      setTargetLocations(locations);
      const selected = locations.find((item) => item.id === targetDraft.location?.id) ?? null;
      setTargetDraft((current) => ({ ...current, location: selected }));
      if (!selected) setTargetDirty(true);
      if (!locations.length) throw new Error("conversation_tab_not_found");
    } catch (error) {
      setActionError(diagnosticText(error instanceof Error ? error.message : "位置检测失败"));
    } finally {
      setTargetDiscovering(false);
    }
  };

  const saveCommunicationTarget = async () => {
    if (!targetReady || bridgeRunning) return;
    setTargetSaving(true);
    setActionError(null);
    try {
      const response = await fetch("/api/collaboration/target", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetDraft),
      });
      const payload = await response.json().catch(() => ({})) as { state?: CollaborationState; error?: string };
      if (!response.ok || !payload.state) throw new Error(payload.error || "collaboration_target_save_failed");
      const state = {
        ...initialCollaboration,
        ...payload.state,
        communicationTarget: { ...initialCommunicationTarget, ...(payload.state.communicationTarget ?? {}) },
      };
      setCollaboration(state);
      setTargetDraft(state.communicationTarget);
      setTargetDirty(false);
    } catch (error) {
      setActionError(diagnosticText(error instanceof Error ? error.message : "沟通目标保存失败"));
    } finally {
      setTargetSaving(false);
    }
  };

  const openApproval = () => {
    setApprovalChecks([false, false, false, false]);
    setApprovalOpen(true);
  };

  const approveAndStart = async () => {
    if (!approvalChecks.every(Boolean)) return;
    setSessionUpdating(true);
    setActionError(null);
    try {
      const response = await fetch("/api/collaboration/approval", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, writebackPolicy: "progress_and_result" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "approval_failed");
      const startResponse = await fetch("/api/collaboration/start", { method: "POST" });
      const startPayload = await startResponse.json().catch(() => ({})) as { error?: string };
      if (!startResponse.ok) throw new Error(startPayload.error || "collaboration_start_failed");
      setApprovalOpen(false);
      await refreshCollaboration();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "验收保存失败");
    } finally {
      setSessionUpdating(false);
    }
  };

  const flowNodes: Node<MapNodeData>[] = useMemo(() => shownNodes.map((item) => ({
    id: item.id,
    type: "product",
    position: positions[item.id] ?? generatedPositions[item.id] ?? { x: 0, y: 0 },
    data: {
      studio: item,
      selected: item.id === selectedId,
      childCount: nodes.filter((child) => child.parentId === item.id).length,
      onSelect: setSelectedId,
      onToggle: toggleNode,
    },
  })), [generatedPositions, nodes, positions, selectedId, shownNodes, toggleNode]);

  const flowEdges: Edge[] = useMemo(() => shownNodes
    .filter((item) => item.parentId && shownNodes.some((parent) => parent.id === item.parentId))
    .map((item) => ({
      id: `${item.parentId}-${item.id}`,
      source: item.parentId!,
      target: item.id,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: "#a9b8c8" },
      style: { stroke: "#a9b8c8", strokeWidth: 1.5 },
    })), [shownNodes]);

  const updateSelected = (patch: Partial<StudioNode>) => {
    setNodes((current) => current.map((item) => item.id === selectedId ? { ...item, ...patch } : item));
  };

  const addChildTo = (parentId: string) => {
    const id = `node-${crypto.randomUUID()}`;
    const parent = nodes.find((item) => item.id === parentId);
    const kind = parent?.kind === "portfolio" ? "product" : parent?.kind === "product" ? "module" : "capability";
    setNodes((current) => [...current, { id, parentId, title: kind === "product" ? "新项目" : "新节点", description: "", kind }]);
    setSelectedId(id);
    setNodeEditorOpen(true);
  };

  const addChild = () => addChildTo(selectedId);

  const deleteSelected = () => {
    if (!selected || selected.parentId === null) return;
    const remove = descendantsOf(nodes, selected.id);
    remove.add(selected.id);
    setNodes((current) => current.filter((item) => !remove.has(item.id)));
    setSelectedId(selected.parentId);
    setNodeEditorOpen(false);
  };

  const saveVersion = () => {
    const now = new Date();
    setVersions((current) => [{ id: crypto.randomUUID(), createdAt: now.toISOString(), nodes, label: `V0.1 · ${now.toLocaleString("zh-CN")}` }, ...current]);
    setSavedAt(now);
  };

  const restoreVersion = (version: Version) => {
    setNodes(version.nodes);
    setPositions({});
    setView("map");
    setSelectedId(version.nodes[0]?.id ?? "");
  };

  const toggleCollaborationPanel = (panel: CollaborationPanel) => {
    setView("discussion");
    setCollaborationPanels((current) => current.includes(panel) ? current.filter((item) => item !== panel) : [...current, panel]);
  };

  const renderOutline = (parentId: string | null, depth = 0): React.ReactNode => nodes
    .filter((item) => item.parentId === parentId)
    .map((item) => {
      const children = nodes.filter((child) => child.parentId === item.id);
      return (
        <div key={item.id}>
          <button
            className={`outline-item ${selectedId === item.id ? "outline-item--selected" : ""}`}
            style={{ paddingLeft: 16 + depth * 22 }}
            onClick={() => { setSelectedId(item.id); setView("map"); }}
            onDoubleClick={() => setNodeEditorOpen(true)}
          >
            <span className="outline-caret" onClick={(event) => { event.stopPropagation(); if (children.length) toggleNode(item.id); }}>
              {children.length ? (item.collapsed ? <CaretRight size={13} /> : <CaretDown size={13} />) : <span />}
            </span>
            <span>{item.title}</span>
            {children.length > 0 && <small>{children.length}</small>}
          </button>
          {!item.collapsed && renderOutline(item.id, depth + 1)}
        </div>
      );
    });

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand-mark"><GitBranch size={20} weight="bold" /></div>
        <div className="brand-copy"><strong>AI Product Studio</strong><span>V0.1</span></div>
        <div className="stage-badge">设计阶段</div>
        <div className="topbar-spacer" />
        <div className={`sync-pill sync-pill--${displayedSyncState}`}><span />{displayedSyncText}</div>
        <div className="saved-copy"><Check size={16} weight="bold" />{savedAt ? `${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 已保存` : "本地自动保存"}</div>
        <button className="primary-button" onClick={saveVersion}><FloppyDisk size={17} />保存版本</button>
      </header>

      <div className={`workspace ${railCollapsed ? "workspace--rail-collapsed" : ""} ${structureCollapsed ? "workspace--structure-collapsed" : ""}`}>
        <nav className={`rail ${railCollapsed ? "rail--collapsed" : ""}`}>
          <button className="sidebar-toggle sidebar-toggle--rail" aria-label={railCollapsed ? "展开功能导航" : "折叠功能导航"} aria-expanded={!railCollapsed} title={railCollapsed ? "展开功能导航" : "折叠功能导航"} onClick={() => setRailCollapsed((current) => !current)}>{railCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button>
          <button title="产品地图" className={view === "map" ? "active" : ""} onClick={() => setView("map")}><GitBranch size={21} /><span>产品地图</span></button>
          <div className={`rail-group ${view === "discussion" ? "rail-group--active" : ""}`}>
            <button title="协作中心" className={view === "discussion" ? "active" : ""} onClick={() => { const alreadyOpen = view === "discussion"; setView("discussion"); setCollaborationMenuOpen((current) => alreadyOpen ? !current : true); }} aria-expanded={collaborationMenuOpen}><NotePencil size={21} /><span>协作中心</span><CaretDown className={`rail-group__caret ${collaborationMenuOpen ? "rail-group__caret--open" : ""}`} size={13} /></button>
            {!railCollapsed && collaborationMenuOpen && <div className="rail-submenu" aria-label="协作中心显示内容">
              <div className="rail-submenu__heading">任务分类</div>
              <label className="rail-submenu__nested"><input type="checkbox" checked={collaborationPanels.includes("pending")} onChange={() => toggleCollaborationPanel("pending")} /><i><Check size={11} weight="bold" /></i><span>待确认任务</span><small>{pendingTaskDrafts.length}</small></label>
              <label className="rail-submenu__nested"><input type="checkbox" checked={collaborationPanels.includes("confirmed")} onChange={() => toggleCollaborationPanel("confirmed")} /><i><Check size={11} weight="bold" /></i><span>已确认任务</span><small>{confirmedTaskDrafts.length}</small></label>
              <label className="rail-submenu__nested"><input type="checkbox" checked={collaborationPanels.includes("non_task")} onChange={() => toggleCollaborationPanel("non_task")} /><i><Check size={11} weight="bold" /></i><span>非任务记录</span><small>{nonTaskDrafts.length}</small></label>
              <label className="rail-submenu__nested"><input type="checkbox" checked={collaborationPanels.includes("rejected")} onChange={() => toggleCollaborationPanel("rejected")} /><i><Check size={11} weight="bold" /></i><span>已拒绝任务</span><small>{rejectedTaskDrafts.length}</small></label>
              <label><input type="checkbox" checked={collaborationPanels.includes("records")} onChange={() => toggleCollaborationPanel("records")} /><i><Check size={11} weight="bold" /></i><span>协作链路记录</span><small>{syncTasks.length}</small></label>
            </div>}
          </div>
          <button title="版本历史" className={view === "history" ? "active" : ""} onClick={() => setView("history")}><ClockCounterClockwise size={21} /><span>版本历史</span></button>
          <div className="rail-project"><span>APS</span><div><strong>AI Product Studio</strong><small>MVP 开发阶段</small></div></div>
        </nav>

        <aside className={`structure-panel ${structureCollapsed ? "structure-panel--collapsed" : ""}`}>
          <button className="sidebar-toggle sidebar-toggle--structure" aria-label={structureCollapsed ? "展开产品结构" : "折叠产品结构"} aria-expanded={!structureCollapsed} title={structureCollapsed ? "展开产品结构" : "折叠产品结构"} onClick={() => setStructureCollapsed((current) => !current)}>{structureCollapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button>
          {!structureCollapsed && <><div className="panel-heading"><div><span>产品结构</span><small>{nodes.length} 个节点</small></div><button onClick={() => addChildTo("root")} aria-label="创建节点"><Plus size={18} /></button></div>
          <div className="outline-tree">{renderOutline(null)}</div></>}
        </aside>

        <main className="content-area">
          {view === "map" && (
            <>
              <div className="canvas-heading"><div><h1>产品地图</h1><p>大模型沟通中确认的产品决策将在这里同步执行</p></div><button onClick={() => setPositions({})}><ArrowClockwise size={16} />自动布局</button></div>
              <div className="flow-wrap">
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  minZoom={0.35}
                  maxZoom={1.7}
                  onNodeDragStop={(_, node) => setPositions((current) => ({ ...current, [node.id]: node.position }))}
                  onPaneClick={() => { setSelectedId(""); setNodeEditorOpen(false); }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color="#d9e1e8" gap={24} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable nodeColor={(node) => node.id === selectedId ? "#4c7df0" : "#d7e0eb"} />
                </ReactFlow>
                {selected && <div className="selection-toolbar"><button onClick={() => setNodeEditorOpen(true)}><PencilSimple size={16} />编辑</button><button onClick={addChild}><Plus size={16} />子节点</button><button onClick={() => toggleNode(selected.id)}>{selected.collapsed ? <CaretRight size={16} /> : <CaretDown size={16} />}展开/折叠</button><button className="danger" aria-label="删除当前节点" onClick={deleteSelected} disabled={selected.parentId === null}><Trash size={16} /></button></div>}
                {selected && nodeEditorOpen && <div className="node-editor" role="dialog" aria-label="编辑产品节点">
                  <div className="node-editor__heading"><div><span>编辑节点</span><small>{selected.kind === "product" ? "项目" : selected.kind === "portfolio" ? "项目组合" : "功能模块"}</small></div><button onClick={() => setNodeEditorOpen(false)} aria-label="完成编辑" title="完成编辑"><Check size={16} weight="bold" /></button></div>
                  <input value={selected.title} onChange={(event) => updateSelected({ title: event.target.value })} aria-label="节点名称" autoFocus />
                  <textarea value={selected.description} onChange={(event) => updateSelected({ description: event.target.value })} placeholder="节点描述" aria-label="节点描述" />
                  <label>父级节点<select value={selected.parentId ?? ""} disabled={selected.parentId === null} onChange={(event) => updateSelected({ parentId: event.target.value || null })}>
                    <option value="">无</option>
                    {nodes.filter((item) => item.id !== selected.id && !descendantsOf(nodes, selected.id).has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                  </select></label>
                  <div className="node-editor__actions"><button onClick={addChild}><Plus size={15} />添加子节点</button><button className="danger" aria-label="删除当前节点" onClick={deleteSelected} disabled={selected.parentId === null}><Trash size={15} /></button></div>
                </div>}
              </div>
            </>
          )}

          {view === "discussion" && (
            <section className="collaboration-view">
              <div className="records-heading collaboration-heading">
                <div><h1>大模型 → Codex 协作中心</h1><p>{collaboration.communicationTarget.location ? `${collaboration.communicationTarget.providerName} · ${collaboration.communicationTarget.conversationTitle} · ${collaboration.communicationTarget.location.label}` : "启动前必须绑定大模型、精确会话和 Safari 位置"}</p></div>
                <div className="collaboration-controls">
                  <div className={`sync-pill sync-pill--${displayedSyncState}`}><span />{displayedSyncText}</div>
                  {bridgeRunning ? (
                    <button className="session-button session-button--pause" onClick={() => runCollaborationAction("stop")} disabled={sessionUpdating}><Pause size={15} weight="fill" />{sessionUpdating ? "正在停止" : `停止 ${collaboration.communicationTarget.providerName}→Codex 同步`}</button>
                  ) : (
                    <button className="session-button session-button--trigger" onClick={() => collaboration.approvalStatus === "approved" && collaboration.writebackPolicy === "progress_and_result" ? runCollaborationAction("start") : openApproval()} disabled={sessionUpdating || !targetStartReady}><Play size={16} weight="fill" />{sessionUpdating ? "正在启动" : collaboration.approvalStatus === "approved" && collaboration.writebackPolicy === "progress_and_result" ? `重新启动 ${targetDraft.providerName}→Codex 同步` : `启动 ${targetDraft.providerName}→Codex 同步`}</button>
                  )}
                </div>
              </div>

              {actionError && <div className="collaboration-error"><WarningCircle size={17} />{actionError}</div>}

              <section className="communication-target" aria-label="沟通目标设置">
                <div className="communication-target__heading">
                  <div><Crosshair size={17} /><div><h2>沟通目标</h2><span>{bridgeRunning ? "当前会话已锁定" : targetDirty ? "有未保存修改" : targetStartReady ? "已绑定" : "待绑定"}</span></div></div>
                  <small>{collaboration.communicationTarget.configuredAt ? `更新于 ${new Date(collaboration.communicationTarget.configuredAt).toLocaleString("zh-CN")}` : "尚未配置具体位置"}</small>
                </div>
                <div className="communication-target__fields">
                  <label><span>大模型</span><select value={targetDraft.provider} disabled={bridgeRunning} onChange={(event) => updateTargetField("provider", event.target.value)}>{collaborationModels.map((model) => <option key={model.id} value={model.id} disabled={model.status !== "available"}>{model.name}{model.status === "available" ? "" : " · 尚未接入"}</option>)}</select></label>
                  <label><span>浏览器</span><input value="Safari" disabled /></label>
                  <label><span>会话名称</span><input value={targetDraft.conversationTitle} disabled={bridgeRunning} onChange={(event) => updateTargetField("conversationTitle", event.target.value)} /></label>
                  <label className="communication-target__url"><span>精确会话 URL</span><input value={targetDraft.conversationUrl} disabled={bridgeRunning} onChange={(event) => updateTargetField("conversationUrl", event.target.value)} /></label>
                </div>
                <div className="communication-target__actions">
                  <button onClick={discoverTargetLocations} disabled={bridgeRunning || targetDiscovering || selectedCollaborationModel?.status !== "available"}><ArrowClockwise size={14} className={targetDiscovering ? "spin" : ""} />{targetDiscovering ? "正在检测" : "检测打开位置"}</button>
                  <button className="communication-target__save" onClick={saveCommunicationTarget} disabled={bridgeRunning || targetSaving || !targetReady}><FloppyDisk size={14} />{targetSaving ? "正在保存" : "保存沟通目标"}</button>
                </div>
                {selectedCollaborationModel?.status !== "available" && <div className="communication-target__notice"><WarningCircle size={14} />{selectedCollaborationModel?.reason || "该模型尚未接入"}</div>}
                {targetLocations.length > 0 && <div className="communication-locations" role="radiogroup" aria-label="Safari 具体沟通位置">
                  {targetLocations.map((location) => <label key={location.id} className={targetDraft.location?.id === location.id ? "selected" : ""}>
                    <input type="radio" name="communication-location" checked={targetDraft.location?.id === location.id} onChange={() => { setTargetDraft((current) => ({ ...current, location })); setTargetDirty(true); setActionError(null); }} />
                    <span><strong>{location.label}</strong><small>{[location.isFrontWindow ? "前台窗口" : "", location.isCurrentTab ? "当前标签" : "", location.hasFocus ? "页面焦点" : "", Number.isInteger(location.maxPromptNumber) ? `Prompt ${location.maxPromptNumber}` : ""].filter(Boolean).join(" · ") || "已匹配精确 URL"}</small></span>
                  </label>)}
                </div>}
                <div className="communication-target__current"><small>当前绑定</small><strong>{collaboration.communicationTarget.location ? `${collaboration.communicationTarget.providerName} · ${collaboration.communicationTarget.conversationTitle} · ${collaboration.communicationTarget.location.label}` : "未指定具体沟通位置"}</strong></div>
              </section>

              <section className="system-monitor" aria-label="系统状态面板">
                <div className="monitor-heading">
                  <div><h2>系统状态面板</h2><span>{latestTask ? `当前任务 Prompt ${latestTask.promptNumber}` : "等待首个同步任务"}</span></div>
                  <small>最近活动 {collaboration.lastActivityAt ? new Date(collaboration.lastActivityAt).toLocaleTimeString("zh-CN") : "--"}</small>
                </div>
                <div className="monitor-grid">
                  {[
                    ["Bridge", bridgeHealth, bridgeHealth === "failed" ? diagnosticText(collaboration.lastError) || "Bridge 异常" : bridgeRunning ? "运行正常" : "等待网页启动"],
                    ["大模型监听", listenerHealth, listenerHealth === "failed" ? diagnosticText(collaboration.lastError) || "监听失败" : bridgeRunning ? `${collaboration.communicationTarget.providerName} · ${collaboration.communicationTarget.conversationTitle} · ${collaboration.communicationTarget.location?.label ?? "位置未记录"}` : "当前未监听"],
                    ["Codex 执行", codexHealth, latestCodexTask?.steps.codex.detail || (codexHealth === "success" ? `Prompt ${latestCodexTask?.promptNumber} 本会话执行成功` : codexHealth === "failed" ? diagnosticText(latestCodexTask?.error) || "本会话执行失败" : "等待本会话的明确任务")],
                    ["结果回传", writebackHealth, latestWriteback ? `${latestWriteback.executionId} · ${latestWriteback.status === "acknowledged" ? "GPT 已回应" : latestWriteback.status === "sent" ? "已发送，等待 GPT" : latestWriteback.status === "failed" ? diagnosticText(latestWriteback.error) : "等待发送"}` : "本次会话尚无回传"],
                    ["最近任务", recentHealth, latestTask ? `Prompt ${latestTask.promptNumber} · ${statusText[recentHealth]}` : "暂无任务"],
                  ].map(([title, status, detail]) => (
                    <div className="monitor-item" key={String(title)}>
                      <div><i className={`status-dot status-dot--${status}`} /><strong>{title}</strong><b className={`status-label status-label--${status}`}>{statusText[status as TaskStageStatus]}</b></div>
                      <span title={String(detail)}>{detail}</span>
                    </div>
                  ))}
                </div>
                {collaboration.lastError && <div className="monitor-diagnostic"><WarningCircle size={16} /><div><strong>当前故障位置：{collaboration.bridgeStatus}</strong><span>{diagnosticText(collaboration.lastError)}</span></div></div>}
              </section>

              <details className="writeback-panel" open>
                <summary><span>GPT 执行回传</span><small>{writebacks.length} 条 · 仅显示最近 5 条</small><CaretDown size={14} /></summary>
                <div className="writeback-list">
                  {writebacks.length === 0
                    ? <div className="writeback-empty">任务开始与完成后，APS 会在已授权的精确会话中回传状态。</div>
                    : writebacks.slice(0, 5).map((item) => <div className="writeback-row" key={item.id}>
                      <div><strong>{item.promptNumber ? `Prompt ${item.promptNumber}` : item.executionId}</strong><span>{item.kind === "progress" ? "执行进度" : "执行结果"}</span></div>
                      <code>{item.executionId}</code>
                      <time>{new Date(item.updatedAt).toLocaleString("zh-CN")}</time>
                      <b className={`writeback-status writeback-status--${item.status}`}>{item.status === "acknowledged" ? "GPT 已回应" : item.status === "sent" ? "已发送" : item.status === "sending" ? "发送中" : item.status === "failed" ? "发送失败" : "待发送"}</b>
                      {item.error && <p>{diagnosticText(item.error)}</p>}
                    </div>)}
                </div>
              </details>

              {collaborationPanels.includes("pending") && <section className="task-understanding" aria-label="待确认任务区域">
                <CollaborationSectionHeading label="待确认任务" description="修改 → 选择优先级 → 人工确认" total={pendingTaskDrafts.length} collapsed={collapsedSections.pending} onToggle={() => toggleSection("pending")} />
                {!collapsedSections.pending && (pendingTaskDrafts.length === 0
                  ? <div className="understanding-empty"><Robot size={22} /><span>新同步回合先生成草案；只有你确认后才会串行派发。</span></div>
                  : <><div className="understanding-list">{pageItems([...pendingTaskDrafts].reverse(), collaborationPages.pending).map((draft) => <TaskDraftCard key={draft.id} draft={draft} execution={executions.find((item) => item.id === draft.executionId)} projects={projects} onChanged={acceptDraftChange} />)}</div><SectionPagination label="待确认任务" page={collaborationPages.pending} total={pendingTaskDrafts.length} onChange={(page) => setSectionPage("pending", page)} /></>)}
              </section>}

              {collaborationPanels.includes("confirmed") && <section className="task-understanding" aria-label="已确认任务区域">
                <CollaborationSectionHeading label="已确认任务" description="确认与执行历史 · 单条默认折叠" total={confirmedTaskDrafts.length} collapsed={collapsedSections.confirmed} onToggle={() => toggleSection("confirmed")} />
                {!collapsedSections.confirmed && (confirmedTaskDrafts.length === 0
                  ? <div className="understanding-empty"><Check size={20} /><span>暂无已确认任务。</span></div>
                  : <><div className="understanding-list">{pageItems([...confirmedTaskDrafts].reverse(), collaborationPages.confirmed).map((draft) => <TaskDraftCard key={draft.id} draft={draft} execution={executions.find((item) => item.id === draft.executionId)} projects={projects} onChanged={acceptDraftChange} />)}</div><SectionPagination label="已确认任务" page={collaborationPages.confirmed} total={confirmedTaskDrafts.length} onChange={(page) => setSectionPage("confirmed", page)} /></>)}
              </section>}

              {collaborationPanels.includes("non_task") && <section className="task-understanding" aria-label="非任务记录区域">
                <CollaborationSectionHeading label="非任务记录" description="系统验收 · 系统规则 · 产品讨论 · 普通交流" total={nonTaskDrafts.length} collapsed={collapsedSections.non_task} onToggle={() => toggleSection("non_task")} />
                {!collapsedSections.non_task && (nonTaskDrafts.length === 0
                  ? <div className="understanding-empty"><NotePencil size={20} /><span>暂无非任务记录。</span></div>
                  : <><div className="understanding-list">{pageItems([...nonTaskDrafts].reverse(), collaborationPages.non_task).map((draft) => <TaskDraftCard key={draft.id} draft={draft} execution={executions.find((item) => item.id === draft.executionId)} projects={projects} onChanged={acceptDraftChange} />)}</div><SectionPagination label="非任务记录" page={collaborationPages.non_task} total={nonTaskDrafts.length} onChange={(page) => setSectionPage("non_task", page)} /></>)}
              </section>}

              {collaborationPanels.includes("rejected") && <section className="task-understanding task-understanding--rejected" aria-label="已拒绝任务区域">
                <CollaborationSectionHeading label="已拒绝任务" description="保留记录 · 单条默认折叠" total={rejectedTaskDrafts.length} collapsed={collapsedSections.rejected} onToggle={() => toggleSection("rejected")} />
                {!collapsedSections.rejected && (rejectedTaskDrafts.length === 0
                  ? <div className="understanding-empty"><Check size={20} /><span>暂无已拒绝任务。</span></div>
                  : <><div className="understanding-list">{pageItems([...rejectedTaskDrafts].reverse(), collaborationPages.rejected).map((draft) => <TaskDraftCard key={draft.id} draft={draft} execution={executions.find((item) => item.id === draft.executionId)} projects={projects} onChanged={acceptDraftChange} />)}</div><SectionPagination label="已拒绝任务" page={collaborationPages.rejected} total={rejectedTaskDrafts.length} onChange={(page) => setSectionPage("rejected", page)} /></>)}
              </section>}

              <div className="workflow-band workflow-band--live" aria-label="当前任务生命周期">
                {stageLabels.map(([key, title, detail], index) => {
                  const step = latestTask?.steps[key] ?? { status: "waiting" as const, at: null };
                  return <div className={`workflow-step workflow-step--${step.status}`} key={key}>
                    <span>{step.status === "success" ? <Check size={18} weight="bold" /> : step.status === "failed" ? <WarningCircle size={18} weight="fill" /> : step.status === "running" ? <CircleNotch size={18} className="spin" /> : <Minus size={18} />}</span>
                    <div><strong>{title}</strong><small>{step.detail || detail}</small><b>{statusText[step.status]}{step.at ? ` · ${new Date(step.at).toLocaleTimeString("zh-CN")}` : ""}</b></div>
                    {index < stageLabels.length - 1 && <ArrowRight className="workflow-arrow" size={16} />}
                  </div>;
                })}
              </div>

              <div className="collaboration-status-band">
                <div><small>定时自动化</small><strong className="status-safe"><LockKey size={15} />已彻底移除</strong><span>不会在 Codex 左侧新建同名任务</span></div>
                <div><small>用户触发门禁</small><strong>{collaboration.approvalStatus === "approved" ? "已授权" : "待你触发"}</strong><span>{collaboration.approvalStatus === "approved" ? `授权于 ${new Date(collaboration.approvedAt!).toLocaleString("zh-CN")}` : "最终确认前不会启动"}</span></div>
                <div><small>本次协作进程</small><strong>{bridgeRunning ? "正在运行" : "未运行"}</strong><span>{bridgeRunning ? "点击“停止协作”即结束" : "只有按钮触发才会启动"}</span></div>
                <div><small>执行范围</small><strong>已注册项目</strong><span>只访问人工确认的受控目录</span></div>
              </div>

              {collaborationPanels.includes("records") && <section className="task-understanding task-activity" aria-label="协作链路记录区域">
              <CollaborationSectionHeading label="协作链路记录" description="消息、判断、派发和结果回写" total={syncTasks.length} collapsed={collapsedSections.records} onToggle={() => toggleSection("records")} live={bridgeRunning} />
              {!collapsedSections.records && (syncTasks.length === 0 ? <div className="empty-state"><NotePencil size={36} /><strong>尚未产生同步记录</strong><span>新同步回合会在此留痕；只有确认后的草案才会派发执行。</span></div> :
                <><div className="task-record-list">{pageItems([...syncTasks].reverse(), collaborationPages.records).map((task) => (
                  <article key={task.id} className={`task-record task-record--${task.status}`}>
                    <div className="record-meta"><span>{collaboration.communicationTarget.providerName} 对话</span><time>{new Date(task.createdAt).toLocaleString("zh-CN")}</time><em>Prompt {task.promptNumber}</em><b className={`status-label status-label--${task.status}`}>{statusText[task.status]}</b></div>
                    <p>{task.message}</p>
                    <IntentAudit record={task} reason={task.steps.parsed.detail || task.result || "未记录判断原因"} />
                    <div className="record-status-grid">
                      {[
                        ["同步", task.steps.listened],
                        ["解析", task.steps.parsed],
                        ["任务生成", task.steps.taskCreated],
                        ["确认", task.steps.confirmed],
                        ["派发", task.steps.dispatched],
                        ["Codex", task.steps.codex],
                        ["返回", task.steps.returned],
                      ].map(([label, value]) => {
                        const step = value as TaskStep;
                        return <div key={String(label)}><small>{String(label)}</small><strong className={`step-value step-value--${step.status}`}>{statusText[step.status]}</strong></div>;
                      })}
                    </div>
                    {task.result && <div className="record-result"><Check size={15} /><div><small>返回结果</small><span>{task.result}</span></div></div>}
                    {(task.error || task.errors.length > 0) && <div className="record-error"><WarningCircle size={15} /><div><small>错误信息</small><span>{[...new Set([...(task.errors || []), ...(task.error ? [task.error] : [])])].map(diagnosticText).join("；")}</span></div></div>}
                  </article>
                ))}</div><SectionPagination label="协作链路记录" page={collaborationPages.records} total={syncTasks.length} onChange={(page) => setSectionPage("records", page)} /></>)}
              </section>}
            </section>
          )}

          {view === "history" && (
            <section className="records-view">
              <div className="records-heading"><div><h1>版本历史</h1><p>恢复前确认当前修改已经保存</p></div></div>
              {versions.length === 0 ? <div className="empty-state"><ClockCounterClockwise size={36} /><strong>暂无手动保存版本</strong><span>点击右上角“保存版本”建立快照。</span></div> :
                <div className="version-list">{versions.map((version) => <article key={version.id}><div><strong>{version.label}</strong><span>{version.nodes.length} 个节点</span></div><button onClick={() => restoreVersion(version)}>恢复此版本</button></article>)}</div>}
            </section>
          )}
        </main>
      </div>
      {approvalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setApprovalOpen(false); }}>
          <section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="approval-modal__icon"><ShieldCheck size={22} /></div>
            <h2 id="approval-title">启动大模型→Codex 同步</h2>
            <p>{targetDraft.providerName} · {targetDraft.conversationTitle} · {targetDraft.location?.label}</p>
            <div className="approval-checks">
              {[`沟通模型：${targetDraft.providerName}`, `具体位置：${targetDraft.location?.label}`, "只读取该精确会话位置，Codex 仍仅执行人工确认的受控任务", "允许 APS 在本次会话中自动回传 Codex 开始状态与最终结果"].map((label, index) => (
                <label key={label}><input type="checkbox" checked={approvalChecks[index]} onChange={(event) => setApprovalChecks((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} /><span><Check size={14} weight="bold" /></span>{label}</label>
              ))}
            </div>
            <div className="approval-modal__actions"><button onClick={() => setApprovalOpen(false)}>取消</button><button className="session-button session-button--trigger" onClick={approveAndStart} disabled={!approvalChecks.every(Boolean) || sessionUpdating}><Play size={16} weight="fill" />{sessionUpdating ? "正在启动" : "确认并启动同步"}</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

export function App() {
  return <ReactFlowProvider><AppContent /></ReactFlowProvider>;
}
