# Copico

Copico is a local-first Chrome extension + Node backend + Telegram bot workflow.

## What it does

1. **Alt + C** in Chrome sends selected text to Telegram.
2. The same Alt+C text is also stored in the active session.
3. In Telegram:
   - `/createsession` starts a fresh session
   - `/submit` sends combined session input to AI and returns answer
   - `/clearsession` resets session content
4. AI providers supported in bot model picker:
   - OpenAI
   - Gemini
   - Claude
   - NVIDIA
   - OpenRouter
   - Ollama
5. **Alt + X** still works for direct single-question mode (`/ask` backend route).

## Folder structure

```text
Copico/
├── README.md
├── .gitignore
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── server.js
│   └── data/
│       └── .gitkeep
└── extension/
    ├── manifest.json
    └── background.js
```

## Setup

### 1) Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Set these in `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional tuning:

- `MAX_SESSION_MESSAGES`
- `MAX_SESSION_INPUT_CHARS`
- `SUBMIT_COOLDOWN_MS`
- `MAX_AI_OUTPUT_TOKENS`
- `OLLAMA_BASE_URL`

### 2) Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `Copico/extension`
5. (Optional) Open `chrome://extensions/shortcuts` and verify:
   - `Alt+C` for capture
   - `Alt+X` for quick ask

## Telegram bot flow

1. Open your bot chat.
2. Type `/start`.
3. Tap `/model` and choose provider from inline buttons.
4. Send provider setup:
   - NVIDIA: first send NVIDIA model ID (example `nvidia/ising-calibration-1-35b-a3b`), then send NVIDIA API key.
   - Ollama: you can send `SKIP` if no API key is needed.
   - Other providers: send API key directly.
5. Type `/createsession`.
6. Copy text from browser with **Alt+C** multiple times.
7. Type `/submit`.
   - Bot first sends full session input
   - Then sends analyzing status
   - Then sends final AI answer
8. Type `/clearsession` for fresh next round.

## Notes on API usage optimization

Copico reduces API cost by:

- capping session size (`MAX_SESSION_MESSAGES`, `MAX_SESSION_INPUT_CHARS`)
- adding `/submit` cooldown (`SUBMIT_COOLDOWN_MS`)
- capping output tokens (`MAX_AI_OUTPUT_TOKENS`)
- caching repeated same-input results for both `/submit` and quick `/ask`

## Troubleshooting

### Port already in use (`EADDRINUSE`)

If you get:

```text
Port 3000 is already in use
```

Either:

1. Stop previous backend process, or
2. Change `PORT` in `backend/.env`.

Quick check:

```bash
lsof -i :3000
```
