import { afterEach, expect, test, vi } from "vitest";
import { AnthropicModel } from "../src/model/anthropic.ts";
import { OpenAICompatibleModel, rejectedParameter } from "../src/model/openai-compatible.ts";
import { createModel, resolveModel, type ModelSettings } from "../src/model/providers.ts";

afterEach(() => vi.unstubAllGlobals());

const ok = (s: ReturnType<typeof resolveModel>): ModelSettings => {
  if ("problem" in s) throw new Error(s.problem);
  return s;
};

test("DeepSeek stays the default, with known prices and the old env names", () => {
  const s = ok(resolveModel({ DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-v4-pro" }));
  expect(s).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "k", vision: false, maxCostPerReply: 1 });
  expect(s.prices.output).toBe(3.96);
  expect(ok(resolveModel({ DEEPSEEK_API_KEY: "k" })).model).toBe("deepseek-flash");
});

test("other providers need a model, a key and prices", () => {
  expect(resolveModel({ COMPANION_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toHaveProperty("problem", expect.stringContaining("COMPANION_MODEL"));
  expect(resolveModel({ COMPANION_PROVIDER: "openai", COMPANION_MODEL: "m" })).toHaveProperty("problem", expect.stringContaining("OPENAI_API_KEY"));
  expect(resolveModel({ COMPANION_PROVIDER: "openai", COMPANION_MODEL: "m", OPENAI_API_KEY: "k" })).toHaveProperty(
    "problem",
    expect.stringContaining("COMPANION_PRICE_INPUT"),
  );
  const s = ok(
    resolveModel({ COMPANION_PROVIDER: "OpenAI", COMPANION_MODEL: "m", COMPANION_API_KEY: "k", COMPANION_PRICE_INPUT: "2", COMPANION_PRICE_OUTPUT: "8" }),
  );
  expect(s).toMatchObject({ provider: "openai", baseUrl: "https://api.openai.com/v1", vision: true, prices: { input: 2, cached: 2, output: 8 } });
});

test("Ollama needs no key and costs nothing; custom needs a base URL; unknown providers are named", () => {
  expect(ok(resolveModel({ COMPANION_PROVIDER: "ollama", COMPANION_MODEL: "qwen3" })).prices).toEqual({ input: 0, cached: 0, output: 0 });
  expect(resolveModel({ COMPANION_PROVIDER: "custom", COMPANION_MODEL: "m" })).toHaveProperty("problem", expect.stringContaining("COMPANION_BASE_URL"));
  expect(resolveModel({ COMPANION_PROVIDER: "nope" })).toHaveProperty("problem", expect.stringContaining("deepseek"));
});

test("whether a model reads images is guessed from its name", () => {
  const withModel = (provider: string, model: string) =>
    ok(resolveModel({ COMPANION_PROVIDER: provider, COMPANION_MODEL: model, COMPANION_API_KEY: "k", COMPANION_PRICE_INPUT: "1", COMPANION_PRICE_OUTPUT: "1" })).vision;
  // Providers whose default is off, with image models.
  expect(withModel("qwen", "qwen-vl-max")).toBe(true);
  expect(withModel("qwen", "qwen3-vl-plus")).toBe(true);
  expect(withModel("zhipu", "glm-4.5v")).toBe(true);
  expect(withModel("moonshot", "moonshot-v1-8k-vision-preview")).toBe(true);
  expect(withModel("openrouter", "anthropic/claude-sonnet-4.5")).toBe(true);
  expect(withModel("openrouter", "google/gemini-2.5-flash")).toBe(true);
  expect(withModel("ollama", "llava:13b")).toBe(true);
  expect(withModel("ollama", "gemma3:12b")).toBe(true);
  // Text-only names, even where the provider's default is on.
  expect(withModel("qwen", "qwen-plus")).toBe(false);
  expect(withModel("openai", "gpt-3.5-turbo")).toBe(false);
  expect(withModel("deepseek", "deepseek-chat")).toBe(false);
  expect(withModel("qwen", "qwen2.5-coder-32b")).toBe(false);
  // Nothing in the name: the provider's default.
  expect(withModel("openai", "some-new-model")).toBe(true);
  expect(withModel("moonshot", "kimi-k2")).toBe(false);
  // The setting always wins.
  expect(ok(resolveModel({ COMPANION_PROVIDER: "qwen", COMPANION_MODEL: "qwen-plus", COMPANION_API_KEY: "k", COMPANION_PRICE_INPUT: "1", COMPANION_PRICE_OUTPUT: "1", COMPANION_VISION: "true" })).vision).toBe(true);
});

test("the cap and vision can be set", () => {
  const base = { DEEPSEEK_API_KEY: "k" };
  expect(ok(resolveModel({ ...base, COMPANION_MAX_COST_PER_REPLY: "0.2" })).maxCostPerReply).toBe(0.2);
  expect(ok(resolveModel({ ...base, COMPANION_MAX_COST_PER_REPLY: "0" })).maxCostPerReply).toBe(0);
  expect(ok(resolveModel({ ...base, COMPANION_MAX_COST_PER_REPLY: "-3" })).maxCostPerReply).toBe(1);
  expect(ok(resolveModel({ ...base, COMPANION_MAX_COST_PER_REPLY: "" })).maxCostPerReply).toBe(1); // blank never turns it off
  expect(resolveModel({ ...base, COMPANION_PRICE_INPUT: "1" })).toHaveProperty("problem", expect.stringContaining("一起写"));
  expect(ok(resolveModel({ ...base, COMPANION_VISION: "false" })).vision).toBe(false);
});

function stubFetch(...responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const prices = { input: 1, cached: 0.1, output: 4 };

test("an OpenAI-compatible model drops or renames a parameter the model rejects, once", async () => {
  const calls = stubFetch(
    { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } },
    { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } } },
    { body: { choices: [{ message: { content: '```json\n{"bubbles":["嗯"]}\n```' } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } } },
    { body: { choices: [{ message: { content: "{}" } }], usage: {} } },
  );
  const m = new OpenAICompatibleModel({ label: "OpenAI", name: "m", baseUrl: "https://x/v1/", apiKey: "k", vision: true, prices });
  const c = await m.complete([{ role: "user", content: "hi" }], { json: true, temperature: 0, maxTokens: 500 });
  expect(c.text).toBe('{"bubbles":["嗯"]}');
  expect(c.usage).toEqual({ promptTokens: 100, cacheHitTokens: 40, completionTokens: 10 });
  expect(calls[0].url).toBe("https://x/v1/chat/completions");
  expect(calls[0].body).toMatchObject({ max_tokens: 500, temperature: 0, response_format: { type: "json_object" } });
  expect(calls[2].body).toMatchObject({ max_completion_tokens: 500 });
  expect(calls[2].body).not.toHaveProperty("temperature");
  await m.complete([{ role: "user", content: "again" }], { json: true, temperature: 0 });
  expect(calls).toHaveLength(4); // remembered: no more retries
  expect(m.cost(c.usage)).toBeCloseTo((60 * 1 + 40 * 0.1 + 10 * 4) / 1e6);
});

test("only the rename error switches to max_completion_tokens", () => {
  expect(rejectedParameter("Use 'max_completion_tokens' instead.")).toBe("max_tokens");
  expect(rejectedParameter("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]")).toBeNull();
});

test("missing usage is flagged, and hidden thinking in total_tokens is counted", async () => {
  stubFetch(
    { body: { choices: [{ message: { content: "{}" } }] } },
    { body: { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 510 } } },
  );
  const m = new OpenAICompatibleModel({ label: "Qwen", name: "m", baseUrl: "https://x", apiKey: "k", vision: false, prices });
  expect((await m.complete([{ role: "user", content: "hi" }], { json: false })).usage.unreported).toBe(true);
  expect((await m.complete([{ role: "user", content: "hi" }], { json: false })).usage.completionTokens).toBe(410);
});

test("Claude: a /v1 base URL works, and history starting with 小拜 gets a user turn first", async () => {
  const calls = stubFetch({ body: { content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const m = new AnthropicModel({ name: "c", baseUrl: "https://proxy/v1", apiKey: "k", vision: false, prices });
  await m.complete([{ role: "system", content: "s" }, { role: "assistant", content: "早" }, { role: "user", content: "嗯" }], { json: true });
  expect(calls[0].url).toBe("https://proxy/v1/messages");
  expect((calls[0].body.messages as Array<{ role: string }>).map((t) => t.role)).toEqual(["user", "assistant", "user"]);
});

test("an OpenAI-compatible error names the provider", async () => {
  stubFetch({ status: 401, body: { error: { message: "bad key" } } });
  const m = new OpenAICompatibleModel({ label: "Kimi", name: "m", baseUrl: "https://x", apiKey: "k", vision: false, prices });
  await expect(m.complete([{ role: "user", content: "hi" }], { json: false })).rejects.toThrow("Kimi HTTP 401: bad key");
});

test("Claude gets the system prompt apart, images as base64 blocks, and cache usage priced", async () => {
  const calls = stubFetch({
    body: { content: [{ type: "text", text: '{"bubbles":["在"]}' }], usage: { input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 20 } },
  });
  const m = new AnthropicModel({ name: "claude-x", baseUrl: "https://api.anthropic.com", apiKey: "k", vision: true, prices });
  const c = await m.complete(
    [
      { role: "system", content: "你是小拜" },
      { role: "user", content: [{ type: "text", text: "看" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }] },
    ],
    { json: true, temperature: 0 },
  );
  expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect(calls[0].init.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
  expect(calls[0].body).toMatchObject({
    model: "claude-x",
    max_tokens: 2000,
    temperature: 0,
    system: [{ type: "text", text: "你是小拜", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "看" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] }],
  });
  expect(c.text).toBe('{"bubbles":["在"]}');
  expect(c.usage).toEqual({ promptTokens: 1250, cacheHitTokens: 1000, cacheWriteTokens: 200, completionTokens: 20 });
  expect(m.cost(c.usage)).toBeCloseTo((50 * 1 + 1000 * 0.1 + 200 * 1.25 + 20 * 4) / 1e6);
});

test("createModel wraps the model in the spending cap", () => {
  const m = createModel(ok(resolveModel({ DEEPSEEK_API_KEY: "k" })));
  expect(m.constructor.name).toBe("BudgetedModel");
  expect(m.name).toBe("deepseek-flash");
});

test("a call that needs no reasoning turns it off where the provider can, and drops it if rejected", async () => {
  const calls = stubFetch(
    { body: { choices: [{ message: { content: "{}" } }], usage: {} } },
    { status: 400, body: { error: { message: "Unrecognized request argument supplied: thinking" } } },
    { body: { choices: [{ message: { content: "{}" } }], usage: {} } },
  );
  const deepseek = ok(resolveModel({ DEEPSEEK_API_KEY: "k" }));
  expect(deepseek.skipThinking).toEqual({ thinking: { type: "disabled" } });
  const m = new OpenAICompatibleModel({ label: "DeepSeek", name: "m", baseUrl: "https://x", apiKey: "k", vision: false, prices, skipThinking: deepseek.skipThinking });
  await m.complete([{ role: "user", content: "hi" }], { json: true, thinking: false });
  expect(calls[0].body.thinking).toEqual({ type: "disabled" });
  await m.complete([{ role: "user", content: "hi" }], { json: true, thinking: false });
  expect(calls[2].body).not.toHaveProperty("thinking"); // rejected once, then left out
  // Normal calls, and providers without such a field, never send it.
  expect(ok(resolveModel({ COMPANION_PROVIDER: "openai", COMPANION_MODEL: "gpt-4o", COMPANION_API_KEY: "k", COMPANION_PRICE_INPUT: "1", COMPANION_PRICE_OUTPUT: "1" })).skipThinking).toBeUndefined();
});
