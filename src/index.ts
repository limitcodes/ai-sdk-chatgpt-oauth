import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { loadApiKey, withoutTrailingSlash } from "@ai-sdk/provider-utils";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface ChatGPTOAuthProviderSettings {
  /** ChatGPT OAuth access token (JWT). Defaults to CHATGPT_ACCESS_TOKEN, CHATGPT_OAUTH_TOKEN, then OPENAI_CODEX_OAUTH_TOKEN. */
  accessToken?: string;
  /** Optional account id. Defaults to CHATGPT_ACCOUNT_ID or the chatgpt_account_id claim inside the access token. */
  accountId?: string;
  /** Defaults to https://chatgpt.com/backend-api/codex. */
  baseURL?: string;
  /** Stable id for prompt-cache routing. Defaults to CHATGPT_SESSION_ID. */
  sessionId?: string;
  /** Extra request headers. Use null values by passing fetch middleware if you need to delete defaults. */
  headers?: Record<string, string>;
  /** Custom fetch, useful for tests/proxies. */
  fetch?: typeof fetch;
}

export interface ChatGPTOAuthProvider extends OpenAIProvider {
  (modelId: string): LanguageModelV4;
  languageModel(modelId: string): LanguageModelV4;
  responses(modelId: string): LanguageModelV4;
  /** Underlying @ai-sdk/openai provider for escape hatches. */
  openai: OpenAIProvider;
}

export type OpenAIAuthToken = {
  access: string;
  refresh: string;
  expires: number;
};

class ChatGPTLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV4["supportedUrls"];

  constructor(
    private readonly inner: LanguageModelV4,
    private readonly sessionId?: string,
  ) {
    this.provider = "chatgpt-oauth.responses";
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    // ChatGPT Codex rejects non-streaming Responses calls, so synthesize
    // doGenerate from the streaming API.
    const result = await this.doStream(options);
    const content: LanguageModelV4Content[] = [];
    const text = new Map<string, { text: string; providerMetadata?: any }>();
    const reasoning = new Map<string, { text: string; providerMetadata?: any }>();
    let warnings: SharedV4Warning[] = [];
    let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
    let usage: LanguageModelV4Usage = emptyUsage();
    let response: LanguageModelV4ResponseMetadata | undefined;

    const flushText = (id: string) => {
      const part = text.get(id);
      if (part) content.push({ type: "text", text: part.text, providerMetadata: part.providerMetadata });
      text.delete(id);
    };
    const flushReasoning = (id: string) => {
      const part = reasoning.get(id);
      if (part) content.push({ type: "reasoning", text: part.text, providerMetadata: part.providerMetadata });
      reasoning.delete(id);
    };

    for await (const part of result.stream) {
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings;
          break;
        case "response-metadata":
          response = { id: part.id, timestamp: part.timestamp, modelId: part.modelId };
          break;
        case "text-start":
          text.set(part.id, { text: "", providerMetadata: part.providerMetadata });
          break;
        case "text-delta": {
          const current = text.get(part.id) ?? { text: "" };
          current.text += part.delta;
          text.set(part.id, current);
          break;
        }
        case "text-end":
          flushText(part.id);
          break;
        case "reasoning-start":
          reasoning.set(part.id, { text: "", providerMetadata: part.providerMetadata });
          break;
        case "reasoning-delta": {
          const current = reasoning.get(part.id) ?? { text: "" };
          current.text += part.delta;
          reasoning.set(part.id, current);
          break;
        }
        case "reasoning-end":
          flushReasoning(part.id);
          break;
        case "tool-call":
        case "tool-result":
        case "tool-approval-request":
        case "custom":
        case "file":
        case "reasoning-file":
        case "source":
          content.push(part);
          break;
        case "finish":
          usage = part.usage;
          finishReason = part.finishReason;
          break;
        case "error":
          throw part.error;
      }
    }

    for (const id of text.keys()) flushText(id);
    for (const id of reasoning.keys()) flushReasoning(id);

    return { content, finishReason, usage, warnings, request: result.request, response: { ...response, headers: result.response?.headers } };
  }

  doStream(options: LanguageModelV4CallOptions) {
    return this.inner.doStream(withCodexDefaults(options, this.sessionId));
  }
}

function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function withCodexDefaults(options: LanguageModelV4CallOptions, sessionId?: string): LanguageModelV4CallOptions {
  const openaiOptions = options.providerOptions?.openai ?? {};
  return {
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: {
        store: false,
        textVerbosity: "low",
        include: ["reasoning.encrypted_content"],
        ...(sessionId ? { promptCacheKey: sessionId } : {}),
        ...openaiOptions,
      },
    },
  };
}

export function createChatGPTOAuth(options: ChatGPTOAuthProviderSettings = {}): ChatGPTOAuthProvider {
  const accessToken = resolveAccessToken(options.accessToken);
  const accountId = options.accountId ?? env("CHATGPT_ACCOUNT_ID") ?? extractChatGPTAccountId(accessToken);
  const baseURL = withoutTrailingSlash(options.baseURL) ?? DEFAULT_BASE_URL;
  const sessionId = options.sessionId ?? env("CHATGPT_SESSION_ID");

  const cacheHeaders: Record<string, string> = sessionId ? { "session-id": sessionId, "x-client-request-id": sessionId } : {};
  const openai = createOpenAI({
    name: "chatgpt-oauth",
    apiKey: accessToken,
    baseURL,
    headers: {
      "chatgpt-account-id": accountId,
      originator: "ai-sdk-chatgpt-oauth",
      "OpenAI-Beta": "responses=experimental",
      ...cacheHeaders,
      ...options.headers,
    },
    fetch: options.fetch,
  });

  const createModel = (modelId: string) => new ChatGPTLanguageModel(openai.responses(modelId), sessionId);
  const provider = ((modelId: string) => createModel(modelId)) as unknown as ChatGPTOAuthProvider;
  Object.assign(provider, openai, {
    languageModel: createModel,
    responses: createModel,
    openai,
  });
  return provider;
}

export const chatgpt = createLazyDefaultProvider();

function createLazyDefaultProvider(): ChatGPTOAuthProvider {
  let cached: ChatGPTOAuthProvider | undefined;
  const get = () => (cached ??= createChatGPTOAuth());
  const provider = ((modelId: string) => get()(modelId)) as unknown as ChatGPTOAuthProvider;
  provider.languageModel = (modelId: string) => get().languageModel(modelId);
  provider.responses = (modelId: string) => get().responses(modelId);
  provider.chat = (modelId: string) => get().chat(modelId);
  provider.completion = (modelId: string) => get().completion(modelId);
  provider.embedding = (modelId: string) => get().embedding(modelId);
  provider.embeddingModel = (modelId: string) => get().embeddingModel(modelId);
  provider.textEmbedding = (modelId: string) => get().textEmbedding(modelId);
  provider.textEmbeddingModel = (modelId: string) => get().textEmbeddingModel(modelId);
  provider.image = (modelId: string) => get().image(modelId);
  provider.imageModel = (modelId: string) => get().imageModel(modelId);
  provider.transcription = (modelId: string) => get().transcription(modelId);
  provider.speech = (modelId: string) => get().speech(modelId);
  provider.files = () => get().files();
  provider.skills = () => get().skills();
  Object.defineProperty(provider, "specificationVersion", { value: "v4" });
  Object.defineProperty(provider, "tools", { get: () => get().tools });
  Object.defineProperty(provider, "experimental_realtime", { get: () => get().experimental_realtime });
  Object.defineProperty(provider, "openai", { get: () => get().openai });
  return provider;
}

function resolveAccessToken(explicit?: string): string {
  if (explicit) return explicit;
  return loadApiKey({
    apiKey: env("CHATGPT_ACCESS_TOKEN") ?? env("CHATGPT_OAUTH_TOKEN") ?? env("OPENAI_CODEX_OAUTH_TOKEN"),
    environmentVariableName: "CHATGPT_ACCESS_TOKEN",
    description: "ChatGPT OAuth access token",
  });
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

export function extractChatGPTAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Could not find ChatGPT account id in access token. Set CHATGPT_ACCOUNT_ID explicitly.");
  }
  return accountId;
}

function decodeJwtPayload(token: string): Record<string, any> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Invalid ChatGPT access token: expected a JWT");
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  const json = typeof Buffer !== "undefined" ? Buffer.from(base64, "base64").toString("utf8") : atob(base64);
  return JSON.parse(json);
}

/** Refresh a ChatGPT OAuth access token. Store the returned refresh token; OpenAI rotates it. */
export async function refreshChatGPTOAuthToken(refreshToken = env("CHATGPT_REFRESH_TOKEN") ?? env("OPENAI_CODEX_REFRESH_TOKEN")): Promise<OpenAIAuthToken> {
  if (!refreshToken) throw new Error("Missing refresh token. Pass one or set CHATGPT_REFRESH_TOKEN.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`ChatGPT OAuth refresh failed (${response.status}): ${await response.text()}`);
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`ChatGPT OAuth refresh response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export default chatgpt;
