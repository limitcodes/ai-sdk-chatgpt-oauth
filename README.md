# ai-sdk-chatgpt-oauth

AI SDK provider for ChatGPT / OpenAI Codex OAuth.

This targets the ChatGPT Codex Responses endpoint (`https://chatgpt.com/backend-api/codex/responses`) and is meant for users who already have ChatGPT OAuth credentials, not an OpenAI API key.

## Install

```bash
# From npm, once published:
npm install ai-sdk-chatgpt-oauth ai

# Or directly from GitHub:
npm install github:Haripritamreddy/ai-sdk-chatgpt-oauth ai
# bun add github:Haripritamreddy/ai-sdk-chatgpt-oauth ai
```

## Auth

Preferred env vars:

```bash
export CHATGPT_ACCESS_TOKEN="eyJ..."       # OAuth access JWT
# optional, normally extracted from the JWT:
export CHATGPT_ACCOUNT_ID="acc_..."
# optional, for refreshing expired access tokens:
export CHATGPT_REFRESH_TOKEN="..."
```

Package rule: use access tokens for requests; use refresh tokens only in your app/CLI to mint a fresh access token. Don't publish or commit either.

Access tokens expire. This package does not mutate your env vars or persist refreshed credentials. In production, store the refresh token in your DB/secret store, refresh before/when expired, persist the rotated `next.refresh`, and pass `next.access` directly to `createChatGPTOAuth()`.

## Usage

```ts
import { generateText } from "ai";
import { chatgpt } from "ai-sdk-chatgpt-oauth";

const { text } = await generateText({
  model: chatgpt("gpt-5.2-codex"),
  prompt: "Say hi",
});
```

Or pass credentials explicitly:

```ts
import { createChatGPTOAuth } from "ai-sdk-chatgpt-oauth";

const chatgpt = createChatGPTOAuth({
  accessToken: process.env.CHATGPT_ACCESS_TOKEN,
  accountId: process.env.CHATGPT_ACCOUNT_ID, // optional
  sessionId: `chat:${chatId}`, // optional, improves prompt-cache routing
});
```

Refresh helper:

```ts
import { refreshChatGPTOAuthToken } from "ai-sdk-chatgpt-oauth";

const next = await refreshChatGPTOAuthToken(process.env.CHATGPT_REFRESH_TOKEN);
// persist next.refresh, use next.access for createChatGPTOAuth({ accessToken: next.access })
```

## Pi-style custom provider config

For tools like Pi, expose this as provider `chatgpt-oauth` and read `CHATGPT_ACCESS_TOKEN`. If Pi handles OAuth storage itself, store the access/refresh pair in its auth store and pass the access token to `createChatGPTOAuth`; refresh before expiry.

Provider defaults copied from Pi's OpenAI Codex implementation:

- base URL: `https://chatgpt.com/backend-api/codex`
- header: `chatgpt-account-id` from JWT claim or `CHATGPT_ACCOUNT_ID`
- header: `OpenAI-Beta: responses=experimental`
- if `sessionId` is set:
  - header: `session-id: <sessionId>`
  - header: `x-client-request-id: <sessionId>`
  - provider option: `openai.promptCacheKey = <sessionId>`
- provider option: `openai.store = false`
- provider option: `openai.include = ["reasoning.encrypted_content"]`
