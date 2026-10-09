// Runs the function with a mocked upstream API. No network, no real key.
import assert from "node:assert/strict";
import handler, { __test } from "../netlify/functions/analyze.mjs";

process.env.LLM_API_KEY = "test-key-123";
process.env.LIMIT_PER_IP = "3";
process.env.DAILY_CAP = "1000";

const realFetch = globalThis.fetch;
let upstream = () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: GOOD }] }) });
const GOOD = JSON.stringify({
  summary: "Urgent account-suspension email asking for a password.",
  tone: "urgent",
  risk: "high",
  flags: [{ type: "phishing", detail: "Asks for password via link" }],
});
globalThis.fetch = async (url, opts) => {
  seen.push({ url, opts });
  return upstream(url, opts);
};
const seen = [];

let n = 0;
const call = async (body, { ip, method = "POST", raw } = {}) => {
  const req = new Request("http://localhost/api/analyze", {
    method,
    body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
  });
  const res = await handler(req, { ip: ip ?? `10.0.0.${++n}` });
  return { status: res.status, body: await res.json() };
};

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t("success returns parsed result and remaining count", async () => {
  __test.reset();
  const r = await call({ message: "Verify your account now" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.risk, "high");
  assert.equal(r.body.remaining, 2);
  const sent = JSON.parse(seen.at(-1).opts.body);
  assert.match(sent.messages[0].content, /<message>/);
  assert.ok(sent.max_tokens <= 400);
});

t("API key goes only in the upstream request header, never in the response", async () => {
  __test.reset();
  const r = await call({ message: "hello" });
  assert.equal(seen.at(-1).opts.headers["x-api-key"], "test-key-123");
  assert.ok(!JSON.stringify(r.body).includes("test-key-123"));
});

t("empty, whitespace, non-string, too long, bad JSON, wrong method", async () => {
  __test.reset();
  assert.equal((await call({ message: "" })).body.error, "empty");
  assert.equal((await call({ message: "   " })).body.error, "empty");
  assert.equal((await call({ message: 42 })).body.error, "empty");
  assert.equal((await call({ message: "a".repeat(1001) })).body.error, "too_long");
  assert.equal((await call(null, { raw: "{nope" })).status, 400);
  assert.equal((await call(null, { method: "GET" })).status, 405);
});

t("per-IP limit blocks the 4th request with a friendly message", async () => {
  __test.reset();
  const ip = "9.9.9.9";
  for (let i = 0; i < 3; i++) assert.equal((await call({ message: "hi" }, { ip })).status, 200);
  const r = await call({ message: "hi" }, { ip });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "limit");
  assert.match(r.body.message, /free tries/);
  // a different IP is unaffected
  assert.equal((await call({ message: "hi" }, { ip: "8.8.8.8" })).status, 200);
});

t("daily global cap", async () => {
  __test.reset();
  process.env.DAILY_CAP = "2";
  await call({ message: "a" });
  await call({ message: "a" });
  const r = await call({ message: "a" });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "daily");
  process.env.DAILY_CAP = "1000";
});

t("upstream 500 / 429 -> friendly 'busy', no upstream details leaked", async () => {
  __test.reset();
  for (const status of [500, 429, 529]) {
    upstream = () => ({ ok: false, status, json: async () => ({ error: { message: "Anthropic internal secret detail" } }) });
    const r = await call({ message: "hi" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "busy");
    assert.ok(!/anthropic|secret detail/i.test(JSON.stringify(r.body)));
  }
});

t("upstream 400/401 -> generic friendly error", async () => {
  __test.reset();
  upstream = () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await call({ message: "hi" });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "upstream");
});

t("timeout (AbortError) -> 504 friendly message", async () => {
  __test.reset();
  upstream = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const r = await call({ message: "hi" });
  assert.equal(r.status, 504);
  assert.equal(r.body.error, "timeout");
});

t("real timeout via TIMEOUT_MS aborts a hanging upstream", async () => {
  __test.reset();
  process.env.TIMEOUT_MS = "50";
  upstream = (_u, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => { const e = new Error("x"); e.name = "AbortError"; rej(e); }));
  const r = await call({ message: "hi" });
  assert.equal(r.body.error, "timeout");
  delete process.env.TIMEOUT_MS;
});

t("garbage model output -> friendly error, not a crash", async () => {
  __test.reset();
  upstream = () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: "Sorry, I can't do that." }] }) });
  const r = await call({ message: "hi" });
  assert.equal(r.status, 502);
});

t("model output is sanitised (bad enum values, extra flags, long strings)", async () => {
  __test.reset();
  upstream = () => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ text: "```json\n" + JSON.stringify({
      summary: "x".repeat(500), tone: "weird", risk: "catastrophic",
      flags: Array.from({ length: 9 }, () => ({ type: "nope", detail: "d".repeat(500) })),
    }) + "\n```" }] }),
  });
  const r = await call({ message: "hi" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.tone, "neutral");
  assert.equal(r.body.result.risk, "low");
  assert.equal(r.body.result.flags.length, 4);
  assert.equal(r.body.result.flags[0].type, "other");
  assert.ok(r.body.result.summary.length <= 200);
  upstream = () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: GOOD }] }) });
});

t("failed upstream calls still count toward the limit", async () => {
  __test.reset();
  upstream = () => ({ ok: false, status: 500, json: async () => ({}) });
  const ip = "7.7.7.7";
  for (let i = 0; i < 3; i++) await call({ message: "hi" }, { ip });
  assert.equal((await call({ message: "hi" }, { ip })).status, 429);
  upstream = () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: GOOD }] }) });
});

t("missing API key -> friendly config message", async () => {
  __test.reset();
  const key = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  const r = await call({ message: "hi" });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "config");
  process.env.LLM_API_KEY = key;
});

t("demo flags ignored unless ALLOW_DEMO_FLAGS=1", async () => {
  __test.reset();
  const off = await call({ message: "hi", demo: "error" });
  assert.equal(off.status, 200);
  process.env.ALLOW_DEMO_FLAGS = "1";
  const err = await call({ message: "hi", demo: "error" });
  assert.equal(err.status, 503);
  const lim = await call({ message: "hi", demo: "limit" });
  assert.equal(lim.status, 429);
  assert.equal(lim.body.error, "limit");
  delete process.env.ALLOW_DEMO_FLAGS;
});

t("no company names in any user-facing message", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../netlify/functions/analyze.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const MESSAGES"), src.indexOf("const SYSTEM"));
  assert.ok(!/openai|anthropic|claude|gpt/i.test(block));
  const html = (await import("node:fs")).readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!/openai|anthropic|claude|gpt/i.test(html));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok  ", name); }
  catch (e) { failed++; console.log("FAIL", name, "\n    ", e.message); }
}
globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
