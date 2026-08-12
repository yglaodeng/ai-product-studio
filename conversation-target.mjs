export const collaborationModels = [
  { id: "chatgpt", name: "ChatGPT", status: "available", browser: "safari" },
  { id: "claude", name: "Claude", status: "unavailable", browser: "safari", reason: "读取适配器尚未接入" },
  { id: "gemini", name: "Gemini", status: "unavailable", browser: "safari", reason: "读取适配器尚未接入" },
];

export const defaultCommunicationTarget = {
  provider: "chatgpt",
  providerName: "ChatGPT",
  browser: "safari",
  conversationTitle: "请配置会话",
  conversationUrl: "",
  location: null,
  configuredAt: null,
};

function targetError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validConversationUrl(provider, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw targetError("valid_conversation_url_required");
  }
  if (provider === "chatgpt" && (url.origin !== "https://chatgpt.com" || !/^\/c\/[^/]+$/.test(url.pathname))) {
    throw targetError("chatgpt_conversation_url_required");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeCommunicationTarget(input, { requireLocation = true } = {}) {
  const provider = String(input?.provider ?? "").trim().toLowerCase();
  const model = collaborationModels.find((item) => item.id === provider);
  if (!model) throw targetError("collaboration_provider_unknown");
  if (model.status !== "available") throw targetError("collaboration_provider_not_supported", 409);

  const conversationTitle = String(input?.conversationTitle ?? "").trim();
  if (!conversationTitle) throw targetError("conversation_title_required");
  const conversationUrl = validConversationUrl(provider, String(input?.conversationUrl ?? "").trim());
  const rawLocation = input?.location;
  const location = rawLocation ? {
    id: String(rawLocation.id ?? "").trim(),
    browser: "safari",
    windowId: Number(rawLocation.windowId),
    windowIndex: Number(rawLocation.windowIndex),
    tabIndex: Number(rawLocation.tabIndex),
    label: String(rawLocation.label ?? "").trim(),
  } : null;
  if (location && (!location.id || !Number.isInteger(location.windowId) || !Number.isInteger(location.windowIndex) || !Number.isInteger(location.tabIndex) || location.windowIndex < 1 || location.tabIndex < 1)) {
    throw targetError("valid_conversation_location_required");
  }
  if (requireLocation && !location) throw targetError("collaboration_target_location_required", 409);

  return {
    provider,
    providerName: model.name,
    browser: model.browser,
    conversationTitle,
    conversationUrl,
    location,
    configuredAt: typeof input?.configuredAt === "string" ? input.configuredAt : null,
  };
}

export function communicationTargetKey(target) {
  return JSON.stringify({
    provider: target?.provider ?? null,
    conversationTitle: target?.conversationTitle ?? null,
    conversationUrl: target?.conversationUrl ?? null,
    location: target?.location ? {
      windowId: target.location.windowId,
      tabIndex: target.location.tabIndex,
    } : null,
  });
}

export function selectBoundSafariConversation(payloads, target) {
  const exactUrlMatches = payloads.filter((payload) => payload?.url === target.conversationUrl);
  if (!exactUrlMatches.length) throw targetError("conversation_tab_not_found", 409);
  const selected = exactUrlMatches.find((payload) =>
    payload.location?.windowId === target.location?.windowId
    && payload.location?.tabIndex === target.location?.tabIndex
  );
  if (!selected) throw targetError("selected_conversation_location_not_found", 409);
  return selected;
}
