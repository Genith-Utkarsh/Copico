const BACKEND_BASE_URL = "http://localhost:3000";
const SEND_ENDPOINT = `${BACKEND_BASE_URL}/send`;
const ASK_ENDPOINT = `${BACKEND_BASE_URL}/ask`;

function isSupportedPageUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  return tab;
}

async function getSelectedText(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.getSelection()?.toString() || "",
  });

  return typeof result?.result === "string" ? result.result.trim() : "";
}

async function postTextToBackend(url, text) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    throw new Error("Cannot reach backend at http://localhost:3000. Is it running?");
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Backend error (${response.status})`);
  }

  return payload;
}

async function captureSelection(trigger, mode) {
  try {
    const tab = await getActiveTab();

    if (!isSupportedPageUrl(tab.url)) {
      console.warn(
        "[Copico] This page is restricted. Open a normal http/https page and try again."
      );
      return;
    }

    const selectedText = await getSelectedText(tab.id);

    if (!selectedText) {
      console.warn("[Copico] Empty selection. Nothing sent.");
      return;
    }

    if (mode === "send") {
      await postTextToBackend(SEND_ENDPOINT, selectedText);
      console.log(`[Copico] Sent selected text via ${trigger}.`);
      return;
    }

    if (mode === "ask") {
      await postTextToBackend(ASK_ENDPOINT, selectedText);
      console.log(`[Copico] Sent AI question via ${trigger}.`);
      return;
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (error) {
    console.error("[Copico] Failed to send selected text:", error?.message || error);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-selected-text") {
    captureSelection("Alt+C", "send");
  }

  if (command === "ask-ai-about-selection") {
    captureSelection("Alt+X", "ask");
  }
});

chrome.action.onClicked.addListener(() => {
  captureSelection("toolbar button", "send");
});
