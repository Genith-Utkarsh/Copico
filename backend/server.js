require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const app = express();

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const TELEGRAM_POLL_INTERVAL_MS = parsePositiveInteger(
  process.env.TELEGRAM_POLL_INTERVAL_MS,
  2000
);

const MAX_SESSION_MESSAGES = parsePositiveInteger(process.env.MAX_SESSION_MESSAGES, 80);
const MAX_SESSION_INPUT_CHARS = parsePositiveInteger(process.env.MAX_SESSION_INPUT_CHARS, 12000);
const SUBMIT_COOLDOWN_MS = parsePositiveInteger(process.env.SUBMIT_COOLDOWN_MS, 8000);
const MAX_AI_OUTPUT_TOKENS = parsePositiveInteger(process.env.MAX_AI_OUTPUT_TOKENS, 500);
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(
  /\/+$/,
  ""
);

const SETTINGS_FILE_PATH = path.join(__dirname, "data", "chat-settings.json");
const pendingSetupByChat = new Map();
const lastSubmitAtByChat = new Map();

const SESSION_MESSAGE_SEPARATOR = "\n\n";

const MODEL_OPTIONS = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
  },
  gemini: {
    label: "Gemini",
    defaultModel: "gemini-1.5-flash",
  },
  claude: {
    label: "Claude",
    defaultModel: "claude-3-5-haiku-latest",
  },
  nvidia: {
    label: "NVIDIA",
    defaultModel: "meta/llama-3.1-70b-instruct",
  },
  openrouter: {
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o-mini",
  },
  ollama: {
    label: "Ollama",
    defaultModel: "llama3.1:8b",
  },
};

let telegramOffset = 0;
let isPollingTelegram = false;

function ensureSettingsFile() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });

  if (!fs.existsSync(SETTINGS_FILE_PATH)) {
    fs.writeFileSync(SETTINGS_FILE_PATH, "{}\n", "utf8");
  }
}

function readAllSettings() {
  ensureSettingsFile();

  try {
    const raw = fs.readFileSync(SETTINGS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("[SETTINGS_READ_ERROR]", error);
    return {};
  }
}

function writeAllSettings(settingsByChatId) {
  ensureSettingsFile();
  fs.writeFileSync(
    SETTINGS_FILE_PATH,
    `${JSON.stringify(settingsByChatId, null, 2)}\n`,
    "utf8"
  );
}

function getChatSettings(chatId) {
  const allSettings = readAllSettings();
  const settings = allSettings[String(chatId)];
  return settings && typeof settings === "object" ? settings : null;
}

function updateChatSettings(chatId, updates) {
  const key = String(chatId);
  const allSettings = readAllSettings();
  const current = allSettings[key] && typeof allSettings[key] === "object" ? allSettings[key] : {};

  allSettings[key] = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  writeAllSettings(allSettings);
  return allSettings[key];
}

function getSessionState(chatId) {
  const settings = getChatSettings(chatId);
  const session = settings?.session;

  if (!session || typeof session !== "object") {
    return { active: false, messages: [], createdAt: null, updatedAt: null };
  }

  const messages = Array.isArray(session.messages)
    ? session.messages.filter((item) => typeof item === "string" && item.trim())
    : [];

  return {
    active: Boolean(session.active),
    messages,
    createdAt: typeof session.createdAt === "string" ? session.createdAt : null,
    updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : null,
  };
}

function createNewSession(chatId) {
  const now = new Date().toISOString();
  const session = {
    active: true,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  updateChatSettings(chatId, { session });
  return session;
}

function clearSession(chatId) {
  const now = new Date().toISOString();
  const session = {
    active: false,
    messages: [],
    createdAt: null,
    updatedAt: now,
    clearedAt: now,
  };

  updateChatSettings(chatId, { session });
  return session;
}

function addMessageToSession(chatId, text) {
  const currentSession = getSessionState(chatId);

  if (!currentSession.active) {
    return {
      added: false,
      active: false,
      count: currentSession.messages.length,
      reason: "Session is not active",
    };
  }

  const message = String(text || "").trim();

  if (!message) {
    return {
      added: false,
      active: true,
      count: currentSession.messages.length,
      reason: "Message is empty",
    };
  }

  const now = new Date().toISOString();
  const nextMessages = [...currentSession.messages, message];
  const session = {
    active: true,
    messages: nextMessages,
    createdAt: currentSession.createdAt || now,
    updatedAt: now,
  };

  updateChatSettings(chatId, { session });

  return {
    added: true,
    active: true,
    count: nextMessages.length,
    reason: null,
  };
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function prepareSessionInput(messages) {
  const normalized = messages.map((item) => compactWhitespace(item)).filter(Boolean);
  const originalCount = normalized.length;
  const recent = normalized.slice(-MAX_SESSION_MESSAGES);

  const selected = [];
  let totalChars = 0;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const separatorLength = selected.length > 0 ? SESSION_MESSAGE_SEPARATOR.length : 0;
    const projected = totalChars + separatorLength + message.length;

    if (projected > MAX_SESSION_INPUT_CHARS) {
      break;
    }

    selected.push(message);
    totalChars = projected;
  }

  selected.reverse();

  return {
    input: selected.join(SESSION_MESSAGE_SEPARATOR),
    usedCount: selected.length,
    originalCount,
    truncated: selected.length < originalCount,
    totalChars,
  };
}

function splitTelegramMessage(text, maxChunkLength = 3900) {
  const chunks = [];
  let rest = String(text || "");

  while (rest.length > maxChunkLength) {
    chunks.push(rest.slice(0, maxChunkLength));
    rest = rest.slice(maxChunkLength);
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

function parseRequestText(inputText) {
  if (typeof inputText !== "string") {
    return { error: "text must be a string" };
  }

  const text = inputText.trim();

  if (!text) {
    return { error: "text cannot be empty" };
  }

  return { text };
}

function normalizeModel(modelInput) {
  const value = String(modelInput || "")
    .trim()
    .toLowerCase();

  if (value === "openai" || value === "open ai") {
    return "openai";
  }

  if (value === "gemini") {
    return "gemini";
  }

  if (value === "claude") {
    return "claude";
  }

  if (value === "nvidia") {
    return "nvidia";
  }

  if (value === "openrouter" || value === "open router" || value === "other") {
    return "openrouter";
  }

  if (value === "ollama") {
    return "ollama";
  }

  return null;
}

function getProviderDefaults(model) {
  const modelKey = normalizeModel(model);
  return modelKey ? MODEL_OPTIONS[modelKey] || null : null;
}

function getConfiguredModelName(modelKey, settings) {
  const provider = getProviderDefaults(modelKey);

  if (!provider) {
    return "";
  }

  if (modelKey === "nvidia") {
    const configured = String(settings?.nvidiaModel || "").trim();
    return configured || provider.defaultModel;
  }

  return provider.defaultModel;
}

function isApiKeyRequired(modelKey) {
  return modelKey !== "ollama";
}

function isModelConfigurationComplete(modelKey, settings) {
  if (modelKey === "nvidia") {
    return Boolean(String(settings?.nvidiaModel || "").trim());
  }

  return true;
}

function getProviderLabel(model) {
  return getProviderDefaults(model)?.label || "Unknown";
}

function maskApiKey(key) {
  const value = String(key || "").trim();

  if (!value) {
    return "not set";
  }

  if (value.length <= 8) {
    return "set";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isAuthorizedChat(chatId) {
  if (!TELEGRAM_CHAT_ID) {
    return true;
  }

  return String(chatId) === TELEGRAM_CHAT_ID;
}

function buildModelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "OpenAI", callback_data: "set_model:openai" },
        { text: "Gemini", callback_data: "set_model:gemini" },
      ],
      [
        { text: "Claude", callback_data: "set_model:claude" },
        { text: "NVIDIA", callback_data: "set_model:nvidia" },
      ],
      [
        { text: "OpenRouter", callback_data: "set_model:openrouter" },
        { text: "Ollama", callback_data: "set_model:ollama" },
      ],
    ],
  };
}

function buildCommandKeyboard() {
  return {
    keyboard: [
      [{ text: "/createsession" }, { text: "/submit" }],
      [{ text: "/clearsession" }, { text: "/settings" }],
      [{ text: "/model" }, { text: "/change_model" }],
      [{ text: "/help" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

function getDefaultMessageOptions(extra = {}) {
  if (Object.prototype.hasOwnProperty.call(extra, "reply_markup")) {
    return extra;
  }

  return {
    ...extra,
    reply_markup: buildCommandKeyboard(),
  };
}

function getHelpMessage() {
  return [
    "Copico bot commands:",
    "/createsession - start a fresh session",
    "/submit - send session input to AI",
    "/clearsession - clear session content",
    "/model - choose or change AI model",
    "/change_model - same as /model",
    "/settings - show model/API/session state",
    "/help - show help",
    "",
    "Flow: /createsession -> copy text with Alt+C -> /submit -> /clearsession",
    "For NVIDIA: choose model in /model, then send NVIDIA model ID and API key.",
    "Alt+X also works for direct quick question mode.",
  ].join("\n");
}

function getSettingsMessage(chatId) {
  const settings = getChatSettings(chatId);
  const session = getSessionState(chatId);
  const provider = getProviderDefaults(settings?.model);

  if (!settings || !provider) {
    return [
      "Model: not configured",
      "API key: not set",
      `Session: ${session.active ? "active" : "inactive"} (${session.messages.length} messages)`,
      "Use /model to set provider and API key.",
    ].join("\n");
  }

  const modelKey = normalizeModel(settings.model);
  const apiKeyRequired = isApiKeyRequired(modelKey);
  const configuredModelName = String(settings?.nvidiaModel || "").trim();
  const modelLine =
    modelKey === "nvidia"
      ? `Model: ${provider.label} (${configuredModelName || "not set"})`
      : `Model: ${provider.label}`;
  const nvidiaNoteLine =
    modelKey === "nvidia" && !configuredModelName
      ? "NVIDIA model name: missing (run /model and pick NVIDIA again)."
      : null;

  const lines = [
    modelLine,
    `API key: ${apiKeyRequired ? maskApiKey(settings.apiKey) : "optional for Ollama"}`,
    `Session: ${session.active ? "active" : "inactive"} (${session.messages.length} messages)`,
    `Limits: ${MAX_SESSION_MESSAGES} messages, ${MAX_SESSION_INPUT_CHARS} chars`,
    "Use /createsession, /submit, /clearsession for session flow.",
  ];

  if (nvidiaNoteLine) {
    lines.splice(1, 0, nvidiaNoteLine);
  }

  return lines.join("\n");
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function getSubmitCooldownState(chatId) {
  const now = Date.now();
  const key = String(chatId);
  const lastSubmittedAt = lastSubmitAtByChat.get(key) || 0;
  const elapsed = now - lastSubmittedAt;

  if (elapsed < SUBMIT_COOLDOWN_MS) {
    return {
      allowed: false,
      waitMs: SUBMIT_COOLDOWN_MS - elapsed,
    };
  }

  lastSubmitAtByChat.set(key, now);
  return { allowed: true, waitMs: 0 };
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function extractErrorMessage(data, fallbackStatus) {
  if (!data || typeof data !== "object") {
    return `HTTP ${fallbackStatus}`;
  }

  if (typeof data.description === "string") {
    return data.description;
  }

  if (typeof data.error === "string") {
    return data.error;
  }

  if (data.error && typeof data.error.message === "string") {
    return data.error.message;
  }

  return `HTTP ${fallbackStatus}`;
}

async function callTelegram(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await parseJsonSafe(response);

  if (!response.ok || !data?.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`Telegram API failed: ${detail}`);
  }

  return data.result;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  return callTelegram("sendMessage", {
    chat_id: String(chatId),
    text,
    ...getDefaultMessageOptions(extra),
  });
}

async function sendLongTelegramMessage(chatId, text, extra = {}) {
  const chunks = splitTelegramMessage(text);

  for (let index = 0; index < chunks.length; index += 1) {
    const options = index === 0 ? extra : {};
    await sendTelegramMessage(chatId, chunks[index], options);
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function sendModelPicker(chatId) {
  await sendTelegramMessage(chatId, "Select AI provider:", {
    reply_markup: buildModelKeyboard(),
  });
}

async function configureTelegramCommands() {
  try {
    await callTelegram("setMyCommands", {
      commands: [
        { command: "createsession", description: "Start a fresh session" },
        { command: "submit", description: "Submit session to AI" },
        { command: "clearsession", description: "Clear session messages" },
        { command: "model", description: "Select AI provider model" },
        { command: "change_model", description: "Change AI provider model" },
        { command: "settings", description: "Show current settings" },
        { command: "help", description: "Show bot usage" },
      ],
    });
  } catch (error) {
    console.error("[TELEGRAM_COMMAND_SETUP_ERROR]", error);
  }
}

async function setModelAndAskForApiKey(chatId, model) {
  const modelKey = normalizeModel(model);

  if (!modelKey) {
    await sendTelegramMessage(chatId, "Unknown model. Use /model to pick one.");
    return;
  }

  pendingSetupByChat.delete(String(chatId));
  updateChatSettings(chatId, {
    model: modelKey,
    apiKey: "",
    nvidiaModel: "",
  });

  if (modelKey === "nvidia") {
    pendingSetupByChat.set(String(chatId), {
      model: modelKey,
      step: "nvidia_model",
    });

    await sendTelegramMessage(
      chatId,
      [
        "Model selected: NVIDIA",
        "Now send the NVIDIA model ID you want to use.",
        "Example: nvidia/ising-calibration-1-35b-a3b",
      ].join("\n")
    );
    return;
  }

  pendingSetupByChat.set(String(chatId), {
    model: modelKey,
    step: "api_key",
  });

  if (modelKey === "ollama") {
    await sendTelegramMessage(
      chatId,
      [
        "Model selected: Ollama",
        "Send API key if your Ollama endpoint requires auth.",
        "Or send SKIP to use local Ollama without API key.",
      ].join("\n")
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    [
      `Model selected: ${getProviderLabel(modelKey)}`,
      "Now send your API key for this model.",
      "You can send /model anytime to change provider.",
    ].join("\n")
  );
}

async function submitSessionForChat(chatId) {
  const session = getSessionState(chatId);
  const settings = getChatSettings(chatId);

  if (!session.active) {
    await sendTelegramMessage(chatId, "No active session. Use /createsession first.");
    return;
  }

  if (session.messages.length === 0) {
    await sendTelegramMessage(chatId, "Session is empty. Copy text with Alt+C first.");
    return;
  }

  const modelKey = normalizeModel(settings?.model);

  if (!modelKey) {
    await sendTelegramMessage(chatId, "Model not configured. Run /model first.");
    return;
  }

  if (!isModelConfigurationComplete(modelKey, settings)) {
    await sendTelegramMessage(
      chatId,
      "NVIDIA model name is missing. Run /model and select NVIDIA again."
    );
    return;
  }

  if (isApiKeyRequired(modelKey) && !settings?.apiKey) {
    await sendTelegramMessage(chatId, "API key missing. Run /model and send your API key.");
    return;
  }

  const provider = getProviderDefaults(modelKey);
  const configuredModelName = getConfiguredModelName(modelKey, settings);
  const modelDisplayName =
    modelKey === "nvidia" ? `${provider?.label} (${configuredModelName})` : provider?.label;

  if (!provider) {
    await sendTelegramMessage(chatId, "Unsupported model in settings. Run /change_model.");
    return;
  }

  const cooldown = getSubmitCooldownState(chatId);

  if (!cooldown.allowed) {
    const waitSeconds = Math.ceil(cooldown.waitMs / 1000);
    await sendTelegramMessage(chatId, `Please wait ${waitSeconds}s before /submit again.`);
    return;
  }

  const prepared = prepareSessionInput(session.messages);

  if (!prepared.input) {
    await sendTelegramMessage(chatId, "Session input became empty after cleanup. Add text again.");
    return;
  }

  await sendLongTelegramMessage(
    chatId,
    [
      `Session Input (${prepared.usedCount}/${prepared.originalCount} messages):`,
      "",
      prepared.input,
    ].join("\n")
  );

  if (prepared.truncated) {
    await sendTelegramMessage(
      chatId,
      [
        "Note: Input was optimized to control API usage.",
        `Used latest ${prepared.usedCount} messages within ${MAX_SESSION_INPUT_CHARS} chars.`,
      ].join("\n")
    );
  }

  const inputHash = hashText(`${modelKey}\n${configuredModelName}\n${prepared.input}`);
  const cached = settings?.sessionCache;

  if (
    cached &&
    cached.model === modelKey &&
    cached.modelName === configuredModelName &&
    cached.inputHash === inputHash &&
    typeof cached.answer === "string" &&
    cached.answer.trim()
  ) {
    await sendLongTelegramMessage(
      chatId,
        [
          `Session submitted: ${prepared.usedCount} messages`,
          `Model: ${modelDisplayName}`,
          "",
          "AI Answer (cached):",
          cached.answer.trim(),
        ].join("\n")
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    modelKey === "nvidia"
      ? `Analyzing with ${provider.label} (${configuredModelName})...`
      : `Analyzing with ${provider.label}...`
  );

  try {
    const answer = await generateAiAnswer(modelKey, settings?.apiKey, prepared.input, {
      configuredModelName,
    });

    updateChatSettings(chatId, {
      model: modelKey,
      sessionCache: {
        model: modelKey,
        modelName: configuredModelName,
        inputHash,
        answer,
        cachedAt: new Date().toISOString(),
      },
    });

    await sendLongTelegramMessage(
      chatId,
      [
        `Session submitted: ${prepared.usedCount} messages`,
        `Model: ${modelDisplayName}`,
        "",
        "AI Answer:",
        answer,
      ].join("\n")
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    await sendTelegramMessage(chatId, `Submit failed: ${detail}`);
  }
}

async function handleTelegramMessage(message) {
  const chatId = String(message?.chat?.id || "");
  const rawText = message?.text;

  if (!chatId || typeof rawText !== "string") {
    return;
  }

  if (!isAuthorizedChat(chatId)) {
    return;
  }

  const text = rawText.trim();
  const command = text.split(/\s+/)[0].toLowerCase();

  if (command === "/start") {
    await sendTelegramMessage(chatId, getHelpMessage());
    await sendModelPicker(chatId);
    return;
  }

  if (command === "/help") {
    await sendTelegramMessage(chatId, getHelpMessage());
    return;
  }

  if (command === "/createsession") {
    createNewSession(chatId);
    await sendTelegramMessage(
      chatId,
      "New session created. Copy text from laptop with Alt+C, then run /submit."
    );
    return;
  }

  if (command === "/submit") {
    await submitSessionForChat(chatId);
    return;
  }

  if (command === "/clearsession") {
    clearSession(chatId);
    await sendTelegramMessage(
      chatId,
      "Session cleared. Use /createsession when you want a fresh session."
    );
    return;
  }

  if (command === "/model" || command === "/change_model") {
    await sendModelPicker(chatId);
    return;
  }

  if (command === "/settings") {
    await sendTelegramMessage(chatId, getSettingsMessage(chatId));
    return;
  }

  const typedModel = normalizeModel(text);

  if (typedModel) {
    await setModelAndAskForApiKey(chatId, typedModel);
    return;
  }

  const pendingSetup = pendingSetupByChat.get(chatId);

  if (pendingSetup?.model === "nvidia" && pendingSetup.step === "nvidia_model") {
    const nvidiaModel = text.trim();

    if (!nvidiaModel) {
      await sendTelegramMessage(chatId, "NVIDIA model name cannot be empty. Send it again.");
      return;
    }

    pendingSetupByChat.set(chatId, {
      model: "nvidia",
      step: "api_key",
      nvidiaModel,
    });

    updateChatSettings(chatId, {
      model: "nvidia",
      nvidiaModel,
      apiKey: "",
    });

    await sendTelegramMessage(
      chatId,
      [
        `NVIDIA model saved: ${nvidiaModel}`,
        "Now send your NVIDIA API key.",
      ].join("\n")
    );
    return;
  }

  if (pendingSetup?.step === "api_key") {
    const modelKey = normalizeModel(pendingSetup.model);

    if (!modelKey) {
      pendingSetupByChat.delete(chatId);
      await sendTelegramMessage(chatId, "Setup state expired. Run /model again.");
      return;
    }

    const lowered = text.toLowerCase();
    let apiKey = text;

    if (modelKey === "ollama" && (lowered === "skip" || lowered === "/skip")) {
      apiKey = "";
    }

    if (isApiKeyRequired(modelKey) && !apiKey.trim()) {
      await sendTelegramMessage(chatId, "API key cannot be empty. Send it again.");
      return;
    }

    const updates = {
      model: modelKey,
      apiKey: apiKey.trim(),
      nvidiaModel: modelKey === "nvidia" ? String(pendingSetup.nvidiaModel || "").trim() : "",
    };

    updateChatSettings(chatId, {
      ...updates,
    });

    pendingSetupByChat.delete(chatId);

    const configuredModelLine =
      modelKey === "nvidia" && updates.nvidiaModel
        ? `NVIDIA model: ${updates.nvidiaModel}`
        : null;

    const messageLines = [
      `API key saved for ${getProviderLabel(modelKey)}.`,
      "Now /submit and Alt+X can use this model.",
      "Use /settings to verify or /change_model to switch.",
    ];

    if (configuredModelLine) {
      messageLines.splice(1, 0, configuredModelLine);
    }

    await sendTelegramMessage(
      chatId,
      messageLines.join("\n")
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "Use /createsession to start, Alt+C to collect text, and /submit to ask AI."
  );
}

async function handleTelegramCallbackQuery(callbackQuery) {
  const callbackQueryId = callbackQuery?.id;
  const callbackData = callbackQuery?.data;
  const chatId = String(callbackQuery?.message?.chat?.id || "");

  if (!callbackQueryId || typeof callbackData !== "string" || !chatId) {
    return;
  }

  if (!isAuthorizedChat(chatId)) {
    await answerCallbackQuery(callbackQueryId, "This chat is not authorized.");
    return;
  }

  if (!callbackData.startsWith("set_model:")) {
    await answerCallbackQuery(callbackQueryId, "Unsupported action.");
    return;
  }

  const selectedModel = normalizeModel(callbackData.slice("set_model:".length));

  if (!selectedModel) {
    await answerCallbackQuery(callbackQueryId, "Unknown model.");
    return;
  }

  await answerCallbackQuery(callbackQueryId, `${getProviderLabel(selectedModel)} selected.`);
  await setModelAndAskForApiKey(chatId, selectedModel);
}

async function handleTelegramUpdate(update) {
  if (update?.callback_query) {
    await handleTelegramCallbackQuery(update.callback_query);
    return;
  }

  if (update?.message) {
    await handleTelegramMessage(update.message);
  }
}

async function initializeTelegramOffset() {
  if (!TELEGRAM_BOT_TOKEN) {
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1&limit=1&timeout=0`
    );
    const data = await parseJsonSafe(response);

    if (response.ok && data?.ok && Array.isArray(data.result) && data.result.length > 0) {
      telegramOffset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch (error) {
    console.error("[TELEGRAM_INIT_ERROR]", error);
  }
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || isPollingTelegram) {
    return;
  }

  isPollingTelegram = true;

  try {
    const updates = await callTelegram("getUpdates", {
      offset: telegramOffset,
      limit: 50,
      timeout: 0,
    });

    for (const update of updates) {
      telegramOffset = update.update_id + 1;
      await handleTelegramUpdate(update);
    }
  } catch (error) {
    console.error("[TELEGRAM_POLL_ERROR]", error);
  } finally {
    isPollingTelegram = false;
  }
}

async function askOpenAi(apiKey, question) {
  const model = MODEL_OPTIONS.openai.defaultModel;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: MAX_AI_OUTPUT_TOKENS,
      messages: [
        {
          role: "system",
          content: "You are a concise, helpful assistant.",
        },
        {
          role: "user",
          content: question,
        },
      ],
    }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`OpenAI request failed: ${detail}`);
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("OpenAI returned an empty answer.");
  }

  return answer.trim();
}

async function askGemini(apiKey, question) {
  const model = MODEL_OPTIONS.gemini.defaultModel;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: question }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: MAX_AI_OUTPUT_TOKENS,
        },
      }),
    }
  );

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`Gemini request failed: ${detail}`);
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const answer = Array.isArray(parts)
    ? parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim()
    : "";

  if (!answer) {
    throw new Error("Gemini returned an empty answer.");
  }

  return answer;
}

async function askClaude(apiKey, question) {
  const model = MODEL_OPTIONS.claude.defaultModel;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_AI_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`Claude request failed: ${detail}`);
  }

  const answer = Array.isArray(data?.content)
    ? data.content
        .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
        .join("")
        .trim()
    : "";

  if (!answer) {
    throw new Error("Claude returned an empty answer.");
  }

  return answer;
}

async function askNvidia(apiKey, modelName, question) {
  const stream = false;
  const model = String(modelName || "").trim() || MODEL_OPTIONS.nvidia.defaultModel;

  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 32768,
      temperature: 0.2,
      top_p: 1.0,
      stream,
      chat_template_kwargs: {
        enable_thinking: true,
      },
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`NVIDIA request failed: ${detail}`);
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("NVIDIA returned an empty answer.");
  }

  return answer.trim();
}

async function askOpenRouter(apiKey, question) {
  const model = MODEL_OPTIONS.openrouter.defaultModel;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Copico",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: question }],
      temperature: 0.2,
      max_tokens: MAX_AI_OUTPUT_TOKENS,
    }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`OpenRouter request failed: ${detail}`);
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("OpenRouter returned an empty answer.");
  }

  return answer.trim();
}

async function askOllama(apiKey, question) {
  const model = MODEL_OPTIONS.ollama.defaultModel;
  const headers = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      prompt: question,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: MAX_AI_OUTPUT_TOKENS,
      },
    }),
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = extractErrorMessage(data, response.status);
    throw new Error(`Ollama request failed: ${detail}`);
  }

  const answer = typeof data?.response === "string" ? data.response.trim() : "";

  if (!answer) {
    throw new Error("Ollama returned an empty answer.");
  }

  return answer;
}

async function generateAiAnswer(model, apiKey, question, options = {}) {
  const modelKey = normalizeModel(model);

  if (!modelKey) {
    throw new Error("Unsupported model.");
  }

  if (modelKey !== "ollama" && (!apiKey || typeof apiKey !== "string")) {
    throw new Error("API key is missing.");
  }

  if (modelKey === "openai") {
    return askOpenAi(apiKey, question);
  }

  if (modelKey === "gemini") {
    return askGemini(apiKey, question);
  }

  if (modelKey === "claude") {
    return askClaude(apiKey, question);
  }

  if (modelKey === "nvidia") {
    return askNvidia(apiKey, options.configuredModelName, question);
  }

  if (modelKey === "openrouter") {
    return askOpenRouter(apiKey, question);
  }

  if (modelKey === "ollama") {
    return askOllama(apiKey, question);
  }

  throw new Error("Unsupported model.");
}

app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON body",
    });
  }

  return next(error);
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "copico-backend",
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    limits: {
      maxSessionMessages: MAX_SESSION_MESSAGES,
      maxSessionInputChars: MAX_SESSION_INPUT_CHARS,
      submitCooldownMs: SUBMIT_COOLDOWN_MS,
    },
  });
});

app.post("/send", async (req, res) => {
  const parsed = parseRequestText(req.body?.text);

  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({
      ok: false,
      error: "Telegram credentials are missing in .env",
    });
  }

  try {
    const sessionResult = addMessageToSession(TELEGRAM_CHAT_ID, parsed.text);
    await sendLongTelegramMessage(TELEGRAM_CHAT_ID, `${SESSION_MESSAGE_SEPARATOR}${parsed.text}`);

    if (sessionResult.added) {
      console.log(`[SESSION] Added message to active session. Total: ${sessionResult.count}`);
    } else {
      console.log(`[SESSION] Message not added (${sessionResult.reason}).`);
    }

    return res.json({
      ok: true,
      message: "Message sent to Telegram",
      sessionActive: sessionResult.active,
      sessionCount: sessionResult.count,
    });
  } catch (error) {
    console.error("[SEND_ERROR]", error);
    const detail = error instanceof Error ? error.message : "Unknown error";

    return res.status(502).json({
      ok: false,
      error: detail,
    });
  }
});

app.post("/ask", async (req, res) => {
  const parsed = parseRequestText(req.body?.text);

  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({
      ok: false,
      error: "Telegram credentials are missing in .env",
    });
  }

  const settings = getChatSettings(TELEGRAM_CHAT_ID);
  const modelKey = normalizeModel(settings?.model);

  if (!modelKey) {
    return res.status(400).json({
      ok: false,
      error: "Model not configured. Open Telegram bot and run /model first.",
    });
  }

  if (!isModelConfigurationComplete(modelKey, settings)) {
    return res.status(400).json({
      ok: false,
      error: "NVIDIA model name is missing. Select NVIDIA in /model and set model name.",
    });
  }

  if (isApiKeyRequired(modelKey) && !settings?.apiKey) {
    return res.status(400).json({
      ok: false,
      error: "API key missing. Open Telegram bot and send API key after selecting model.",
    });
  }

  const provider = getProviderDefaults(modelKey);

  if (!provider) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported model in saved settings. Use /change_model in Telegram.",
    });
  }

  const configuredModelName = getConfiguredModelName(modelKey, settings);
  const modelDisplayName =
    modelKey === "nvidia" ? `${provider.label} (${configuredModelName})` : provider.label;
  const question = compactWhitespace(parsed.text).slice(0, MAX_SESSION_INPUT_CHARS);
  const questionHash = hashText(`${modelKey}\n${configuredModelName}\n${question}`);
  const cached = settings?.quickAskCache;

  try {
    if (
      cached &&
      cached.model === modelKey &&
      cached.modelName === configuredModelName &&
      cached.inputHash === questionHash &&
      typeof cached.answer === "string" &&
      cached.answer.trim()
    ) {
      const outputMessage = [
        `Model: ${modelDisplayName}`,
        "",
        `Question: ${question}`,
        "",
        `Answer (cached): ${cached.answer.trim()}`,
      ].join("\n");

      await sendLongTelegramMessage(TELEGRAM_CHAT_ID, outputMessage);

      return res.json({
        ok: true,
        message: "AI answer sent to Telegram (cached)",
        model: modelKey,
      });
    }

    const answer = await generateAiAnswer(modelKey, settings?.apiKey, question, {
      configuredModelName,
    });
    const outputMessage = [
      `Model: ${modelDisplayName}`,
      "",
      `Question: ${question}`,
      "",
      `Answer: ${answer}`,
    ].join("\n");

    updateChatSettings(TELEGRAM_CHAT_ID, {
      model: modelKey,
      quickAskCache: {
        model: modelKey,
        modelName: configuredModelName,
        inputHash: questionHash,
        answer,
        cachedAt: new Date().toISOString(),
      },
    });

    await sendLongTelegramMessage(TELEGRAM_CHAT_ID, outputMessage);

    return res.json({
      ok: true,
      message: "AI answer sent to Telegram",
      model: modelKey,
    });
  } catch (error) {
    console.error("[ASK_ERROR]", error);
    const detail = error instanceof Error ? error.message : "Unknown error";

    return res.status(502).json({
      ok: false,
      error: detail,
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Route not found" });
});

async function startTelegramBotPolling() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[TELEGRAM_BOT] TELEGRAM_BOT_TOKEN missing. Bot controls disabled.");
    return;
  }

  await configureTelegramCommands();
  await initializeTelegramOffset();
  await pollTelegramUpdates();

  const interval = TELEGRAM_POLL_INTERVAL_MS >= 1000 ? TELEGRAM_POLL_INTERVAL_MS : 2000;

  setInterval(() => {
    pollTelegramUpdates();
  }, interval);

  console.log(`[TELEGRAM_BOT] Polling every ${interval}ms`);
}

const server = app.listen(PORT, async () => {
  console.log(`[STARTED] Copico backend listening at http://localhost:${PORT}`);
  await startTelegramBotPolling();
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `[STARTUP_ERROR] Port ${PORT} is already in use. Stop the existing backend process or change PORT in .env.`
    );
    process.exit(1);
  }

  console.error("[STARTUP_ERROR]", error);
  process.exit(1);
});
