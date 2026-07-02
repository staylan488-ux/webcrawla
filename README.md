# ✨ Webcrawla — BYOK AI Search Overviews

A Chrome MV3 extension (built for Vivaldi, works in any Chromium browser) that injects an AI-generated answer card at the top of [Startpage](https://www.startpage.com) search results — like Google's AI Overviews, but **bring-your-own-key**: point it at any OpenAI-compatible endpoint (Ollama Cloud, OpenRouter, a local Ollama, vLLM, …) with your own API key and model.

Unlike a plain "summarize the snippets" tool, Webcrawla does a real crawl: it fetches the top result pages in parallel, extracts their readable text (Mozilla Readability), and streams a grounded, citation-linked answer. The model can call a `fetch_page` tool mid-generation to read more pages when the first batch isn't enough (capped at 3 tool rounds / 8 pages / 45 s).

Every finished overview becomes a conversation: type into the "Ask a follow-up" box to chat with the model about the summary. Follow-ups can crawl additional pages too (same caps per question), citations keep numbering across the conversation, and the chat survives page reloads for the browser session (stored in `chrome.storage.session`, last 5 conversations, gone when the browser closes). Regenerate starts the conversation fresh.

When the model needs information beyond the crawled sources — typical for follow-up questions — it can call a `web_search` tool (max 2 searches per exchange) and then read the promising results. The search backend is configurable in options: DuckDuckGo's HTML endpoint (free, default) or the Perplexity Search API with your own key.

## Build

```bash
npm install
npm run build      # bundles to dist/
npm test           # vitest unit suite
npm run typecheck  # tsc --noEmit
```

## Install in Vivaldi

1. `npm run build`
2. Open `vivaldi://extensions` (or `chrome://extensions`)
3. Enable **Developer Mode** (top right)
4. **Load unpacked** → select the `dist/` folder

## Configure

Open the extension's options page and set:

- **Endpoint base URL** — must expose `POST /chat/completions`. Ollama Cloud: `https://ollama.com/v1`
- **API key** — stored only on this device (`chrome.storage.local`), sent only to your endpoint
- **Model name** — e.g. `glm-5.2`
- **Trigger** — *Smart* (auto-runs on question-like searches, button otherwise), *Always*, or *Manual*

Then search something on Startpage like *"how do heat pumps work"* — the answer card streams in above the results.

## Architecture

| Piece | Role |
|---|---|
| `src/content/` | Scrapes the Startpage results DOM, injects the shadow-DOM answer panel, smart trigger |
| `src/background/` | The agent: parallel prefetch of top results + streaming LLM call with `fetch_page` tool loop |
| `src/offscreen/` | Readability text extraction (MV3 service workers have no DOM) |
| `src/options/` | BYOK settings UI |

## Maintenance: Startpage markup drift

Startpage's result markup is not a public API. Every Startpage-specific selector lives in **`src/content/serp-selectors.ts`** (`RESULT_CONTAINER_SELECTORS`, `SNIPPET_SELECTORS`). If Startpage changes their markup, the scraper falls back to generic heading+link detection; to restore first-class extraction, inspect the live results page, update the selector candidates there, and mirror the new structure in the `KNOWN_MARKUP` fixture in `tests/serp.test.ts`.

## Security notes

- The API key never leaves `chrome.storage.local` except in the `Authorization` header to your configured endpoint.
- Model output is rendered through a sanitizing markdown renderer — it never becomes raw HTML, and only `http(s)` URLs may appear in links (including citation links).
- Fetched pages are size-capped and non-HTML content types are skipped.
- Search queries are sent to the selected search backend (DuckDuckGo or Perplexity) only when the model invokes `web_search`. The Perplexity key is stored on-device and sent only to api.perplexity.ai.
