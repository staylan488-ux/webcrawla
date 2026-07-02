# Webcrawla v2.1 — web_search Tool with Pluggable Backends

**Date:** 2026-07-01
**Status:** Approved by user
**Builds on:** v0.2.0 (follow-up chat, shipped)

## Purpose

Give the agent a `web_search` tool so it can discover pages beyond the original Startpage result set — the gap that makes drifted follow-up questions ("who's the favorite in the Belgium game?") unanswerable today. Two backends, user-selectable in options:

- **DuckDuckGo HTML (default, free):** background fetch of `https://html.duckduckgo.com/html/?q=<query>`, parsed in the offscreen document.
- **Perplexity Search API (BYOK, optional):** `POST https://api.perplexity.ai/search` with the user's Perplexity API key (verified response shape: `results[]` of `{ title, url, snippet, date?, last_updated? }`).

The tool SUPPLEMENTS the existing pipeline — it never replaces it. Summaries still start from the scraped Startpage SERP with parallel prefetch; `web_search` is available to the model in both summaries and follow-ups, invoked only when its current sources are insufficient.

## Tool semantics

- New OpenAI tool definition `WEB_SEARCH_TOOL`: `web_search(query: string)` — "Search the web for pages relevant to a query. Use when the provided sources cannot answer the question; then fetch_page the promising results."
- Offered alongside `FETCH_PAGE_TOOL` in every exchange (summary and follow-up).
- Tool result: a compact numbered candidate list, one per line: `- <title> — <url>\n  <snippet>` (max 5 results). Candidates are NOT sources — only pages the model subsequently `fetch_page`s get citation numbers (existing pipeline unchanged).
- Caps: **max 2 web_search calls per exchange** (tracked like `pagesFetched`); exceeding → tool error text `Error: search limit reached; work with what you have.`; empty results → `No results found.`; provider failure → `Error: search failed.` — never a crash. All inside the existing 45 s exchange budget (searches go through the budget race).

## Search provider abstraction (`src/background/search.ts`, new)

```ts
searchWeb(query: string, settings: Settings): Promise<SerpResult[]>  // ≤ 5 results
```

- Routes on `settings.searchProvider`; `'perplexity'` without a non-empty `perplexityApiKey` silently falls back to DDG.
- **DDG:** `fetchPage('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query))` (existing fetcher: 6 s timeout override, html-only, size caps), then parse in the offscreen document via a new `parse-serp` RPC kind: anchors `a.result__a` (title + href) and `.result__snippet` within `.result` blocks; skip DDG ad/redirect cleanup edge cases beyond unwrapping `uddg=` redirect params; return `SerpResult[]`.
- **Perplexity:** `fetch('https://api.perplexity.ai/search', { method: 'POST', headers: { authorization: Bearer <perplexityApiKey>, content-type: application/json }, body: { query, max_results: 5 } })`, map `results[]` → `SerpResult[]` (`snippet` may be long — truncate to 300 chars). Non-2xx → throw (becomes the tool error text). 6 s timeout via AbortController.
- The Perplexity key is sent ONLY to `api.perplexity.ai`; search queries go only to the selected backend, and only when the model invokes the tool.

## Agent integration (`src/background/agent.ts`)

- `AgentDeps` gains `searchWeb: (query: string) => Promise<SerpResult[]>` (settings pre-bound by the background index, fakes injected in tests).
- The shared exchange loop's tool handler gains a `web_search` branch: parse `{ query }` arg (non-empty string required, else tool error), enforce the 2-per-exchange cap, `budget.race(deps.searchWeb(query))`, format candidates.
- Both `runAgent` and `runFollowup` pass `tools: [FETCH_PAGE_TOOL, WEB_SEARCH_TOOL]` while rounds remain (final round stays answer-only).
- Round cap unchanged (3 tool rounds) — a search + follow-up fetches fit comfortably: round 1 search, round 2 fetches, round 3 more fetches, final answer.

## Prompt update (`src/background/prompt.ts`)

System prompt tool guidance becomes: "You may call web_search to find pages when the question needs information beyond the provided sources — especially follow-up questions about new aspects — and fetch_page to read search results or links referenced in a source. Prefer searching and reading over telling the user to look elsewhere. Do not call tools when you already have enough."

## Settings & options (`src/shared/types.ts`, `src/options/`)

- `Settings` gains `searchProvider: 'ddg' | 'perplexity'` (default `'ddg'`) and `perplexityApiKey: ''`.
- Options page: "Web search backend" `<select>` (DuckDuckGo — free / Perplexity — uses your API key) + a password input for the Perplexity key with hint "Only used when Perplexity is selected; stored on this device; sent only to api.perplexity.ai". Saved via the existing settings round-trip (trimmed).

## Error handling

| Failure | Behavior |
|---|---|
| Provider timeout / non-2xx / network | Tool message `Error: search failed.`; exchange continues |
| Zero results | Tool message `No results found.` |
| Search cap exceeded | Tool message `Error: search limit reached; work with what you have.` |
| Perplexity selected, no key | Runtime falls back to DDG silently |
| Malformed tool arg | Tool message `Error: invalid search query.` |

## Out of scope

- Replacing the summary's Startpage-SERP source discovery.
- Sonar/chat-completion Perplexity modes.
- Search-result caching, multi-provider fan-out, per-domain filters.

## Testing

- Unit: DDG parser against a fixture of the html.duckduckgo.com markup (incl. `uddg=` unwrapping); Perplexity mapper against a mocked API response (shape from live docs) + non-2xx throw; provider routing incl. silent DDG fallback; agent tool-handler branch (cap, empty, failure, candidate formatting) via injected `searchWeb` fake; prompt content mentions web_search.
- Existing 98 tests keep passing (tool list additions must not break turn-loop tests).
- Manual E2E: a drifted follow-up triggers search→fetch→cited answer on DDG; switch to Perplexity with the user's real key and repeat; verify options round-trip.

## README

Feature paragraph gains the search tool + backend choice; privacy section gains: "Search queries are sent to the selected search backend (DuckDuckGo or Perplexity) only when the model invokes web_search."
