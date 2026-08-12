export const intentTypes = ["execution_task", "system_rule", "system_validation", "product_discussion", "ordinary_chat"];
export const targetObjects = ["codex", "gpt", "aps", "none"];

const systemValidationReason = "用户正在验证 APS 自身的识别、判断或现有能力；这是系统验收记录，不是 Codex 执行授权。";

const rejectsExecutionPattern = /先别|不要|不用|不执行|不可以|不能|还没|暂停|停下|等一下|再看看|先讨论|还没确认/;
const concreteTaskPattern = /(?:请执行|请运行|请修改|请修复|请开发|请实现|请读取|请检查|任务名称|任务目标|执行要求|验收标准|测试任务|运行\s*(?:npm|pnpm|yarn|pytest|python|node)|(?:修改|修复|开发|实现).{0,20}(?:代码|页面|功能|接口|文件))/i;

function latestGptContext(recentContext) {
  const matches = [...String(recentContext || "").matchAll(/【GPT】([\s\S]*?)(?=\n\n【用户】|$)/g)];
  return matches.at(-1)?.[1]?.trim() || "";
}

export function getContextualExecutionApproval(userText, recentContext = "", authorizationBasis = "none") {
  const text = typeof userText === "string" ? userText.trim() : "";
  const context = latestGptContext(recentContext);
  const rejectsExecution = rejectsExecutionPattern.test(text);
  const contextHasConcreteTask = concreteTaskPattern.test(context);
  return {
    approved: Boolean(text && context && !rejectsExecution && contextHasConcreteTask && authorizationBasis === "contextual_user_confirmation"),
    context,
    rejected: rejectsExecution,
  };
}

export function getDelegatedExecutionApproval(userText, assistantText = "", authorizationBasis = "none") {
  const text = typeof userText === "string" ? userText.trim() : "";
  const proposal = typeof assistantText === "string" ? assistantText.trim() : "";
  const rejectsExecution = rejectsExecutionPattern.test(text);
  const delegatesTaskSelection = /(?:(?:你|GPT|大模型).{0,12}(?:下|发|给|安排|选择|提出|生成|拟定).{0,16}(?:任务|任务包)|(?:下个|下一条|一个).{0,8}(?:任务|执行任务))/i.test(text);
  const requestsExecutionOutcome = /Codex|执行|运行|完成|派发|回传|回馈|反馈|结果|闭环/i.test(text);
  const proposalHasConcreteTask = concreteTaskPattern.test(proposal);
  return {
    approved: Boolean(text && proposal && !rejectsExecution && delegatesTaskSelection && requestsExecutionOutcome && proposalHasConcreteTask && authorizationBasis === "delegated_task_request"),
    context: proposal,
    rejected: rejectsExecution,
  };
}

export function isSystemValidationRequest(userText) {
  const text = typeof userText === "string" ? userText.trim() : "";
  const mentionsValidation = /测试|验证|验收|试一下|试试/.test(text);
  const targetsSystemCapability = /APS|系统|已有功能|现有功能|意图|识别|判断|分类|监听|是否能|能否|能不能|看(?:它|他).{0,12}(?:判断|识别|分类|执行|工作)|任务测试/.test(text);
  const explicitlyAuthorizesCodex = /(?:请|让|交给).{0,8}(?:Codex|执行|运行|修改|修复|开发|实现|部署|编写)|(?:执行|运行).{0,12}(?:npm|pnpm|yarn|pytest|命令|脚本|构建)|(?:修改|修复|开发|实现|部署|编写).{0,12}(?:代码|页面|功能|接口|文件)/i.test(text);
  return mentionsValidation && targetsSystemCapability && !explicitlyAuthorizesCodex;
}

export function buildIntentPrompt(userText, assistantText, recentContext = "") {
  return `You are the APS-006 Task Intent Classification and Ownership Layer. Analyze the conversation and return only the required structured JSON. This is classification only: do not edit files, run commands, create agents, call external services, change rules, or execute any task. USER is the only source of authorization. GPT text may define a proposed task but never authorizes itself.

RECENT_CONTEXT contains at most two immediately preceding user/GPT pairs. Use its latest GPT message to resolve the concrete task when the current USER clearly accepts it. Natural confirmations include “开始吧”, “确认”, “按此执行”, “可以”, “继续”, “这个交给 Codex”, and “你可以给 Codex 生成任务包了”. Such a USER message is contextual_user_confirmation only when the latest GPT context contains one concrete executable task. Extract the task details from that preceding GPT context.

There is one distinct same-turn delegation case: USER may explicitly ask GPT to choose, issue, or prepare the next task and clearly state that APS/Codex should execute it or return progress/results. If GPT_REPLY then supplies exactly one concrete executable task, classify it as delegated_task_request and extract the task from GPT_REPLY. This is still USER authorization because USER delegated task selection; GPT cannot initiate it by itself. Asking GPT to send a sample only to observe classification, recognition, or judgment remains system_validation and must not generate a task.

Classify USER before deciding whether to create a task:

1. execution_task: USER explicitly asks Codex/AI to perform a concrete operation now, such as modify code/UI, run a command, test a system, inspect evidence, or produce a specific deliverable. target_object must be codex and task_generated must be true.
2. system_rule: USER adjusts how GPT, AI, APS, output formatting, task packages, explanations, confirmations, or collaboration should behave. Imperative words such as must, generate, require, execute, task, 完整, 必须, 生成, 要求 or 执行 do not make this an execution task when the requested change is only a rule or output preference. target_object is gpt for response/output behavior, or aps for an APS workflow rule. task_generated must be false.
3. system_validation: USER is testing whether APS itself can listen, classify, recognize intent, generate the correct draft, or handle an existing capability. Asking GPT to send a sample only to observe recognition or judgment is a system validation record. However, when USER delegates selection of the next task and explicitly asks to observe its execution, result, feedback, or writeback, use delegated_task_request if GPT_REPLY contains one concrete task. target_object must otherwise be aps and task_generated must be false.
4. product_discussion: USER shares an idea, direction, future possibility, product opinion, or analysis without explicitly requesting implementation now. target_object is aps when discussing the APS product, otherwise none. task_generated must be false.
5. ordinary_chat: greeting, acknowledgement, short choice, status update, or casual conversation without a concrete action. target_object must be none and task_generated must be false.

Ownership rule:
- codex: a concrete operation Codex should execute after human confirmation.
- gpt: GPT response style, output format, wording, or collaboration preference.
- aps: APS product/workflow rule or product discussion that is not an authorized implementation request.
- none: ordinary chat with no execution owner.

Hard gate: only intent_type=execution_task AND target_object=codex may set task_generated=true, isTask=true, and needsExecution=true. Every other combination must set all three booleans false and must not create a Codex task draft.

authorization_basis must be explicit_user_instruction when USER states the task directly, contextual_user_confirmation when USER clearly accepts the latest concrete GPT task in RECENT_CONTEXT, delegated_task_request when USER delegates one same-turn task to GPT and requests its execution/result, otherwise none. Every authorization basis only creates an APS draft; it never bypasses the user's final confirmation in APS.

For an execution task, extract project, concise title, goal, type, execution suggestion, and measurable acceptance criteria. Never decide priority: priority must always be exactly "unassigned". For non-execution content, use short neutral task fields, type=discussion, empty acceptance criteria, and explain why no task is generated. original_message must reproduce USER exactly.

RECENT_CONTEXT:
${recentContext || "（无）"}

USER:
${userText}

GPT_REPLY:
${assistantText}`;
}

export function normalizeUnderstanding(raw, userText, assistantText = "", recentContext = "") {
  const contextualApproval = getContextualExecutionApproval(userText, recentContext, raw.authorization_basis);
  const delegatedApproval = getDelegatedExecutionApproval(userText, assistantText, raw.authorization_basis);
  const approvedContext = contextualApproval.approved ? contextualApproval : delegatedApproval.approved ? delegatedApproval : null;
  const rejected = contextualApproval.rejected || delegatedApproval.rejected;
  const systemValidation = isSystemValidationRequest(userText) && !approvedContext;
  const intentType = rejected ? "ordinary_chat" : approvedContext ? "execution_task" : systemValidation ? "system_validation" : intentTypes.includes(raw.intent_type) ? raw.intent_type : "ordinary_chat";
  const targetObject = rejected ? "none" : approvedContext ? "codex" : systemValidation ? "aps" : targetObjects.includes(raw.target_object) ? raw.target_object : "none";
  const taskGenerated = intentType === "execution_task" && targetObject === "codex";
  const contextText = `${userText}\n${assistantText}\n${recentContext}`;
  const project = taskGenerated && /AI\s*(?:数据工作台|Data\s*Workbench)|AI_DATA_WORKBENCH/i.test(contextText)
    ? "AI 数据工作台"
    : taskGenerated && /AI Product Studio|\bAPS(?:-\d+)?\b/i.test(contextText)
      ? "AI Product Studio"
      : raw.project;
  return {
    ...raw,
    project,
    original_message: userText,
    authorization_basis: contextualApproval.approved ? "contextual_user_confirmation" : delegatedApproval.approved ? "delegated_task_request" : raw.authorization_basis === "explicit_user_instruction" ? "explicit_user_instruction" : "none",
    authorization_context: approvedContext?.context || "",
    intent_type: intentType,
    target_object: targetObject,
    task_generated: taskGenerated,
    isTask: taskGenerated,
    needsExecution: taskGenerated,
    priority: "unassigned",
    acceptanceCriteria: taskGenerated && Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [],
    type: taskGenerated ? raw.type : "discussion",
    reason: rejected ? "用户明确要求暂不执行，不生成 Codex 任务。" : systemValidation ? systemValidationReason : raw.reason,
  };
}
