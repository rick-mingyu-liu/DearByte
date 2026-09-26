import { expect, test } from "vitest";
import { HealthMcpClient, HealthMcpError } from "../src/health/mcp-client.ts";
import { sleepNights, summarizeSleep, summarizeVitals } from "../src/health/summary.ts";
import { healthTools } from "../src/health/tools.ts";
import { agentToolset, memoryTools } from "../src/agent/toolset.ts";
import { Store } from "../src/storage/store.ts";

const TZ = "America/Los_Angeles";
const SECRET_URL = "https://bridge.example.workers.dev/mcp/secret-token-123";

/** A fake bridge over HTTP: answers JSON-RPC like dearbyte-bridge and records what was sent. */
function fakeBridge(tools: Record<string, (args: Record<string, unknown>) => unknown>, o: { status?: number } = {}) {
  const sent: Array<{ method: string; params?: { name?: string; arguments?: Record<string, unknown> } }> = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const rpc = JSON.parse(init.body);
    sent.push(rpc);
    if (o.status) return new Response("{}", { status: o.status });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18" } });
    const tool = tools[rpc.params.name];
    const result = tool
      ? { content: [{ type: "text", text: JSON.stringify(tool(rpc.params.arguments)) }], isError: false }
      : { content: [{ type: "text", text: `Unknown tool: ${rpc.params.name}` }], isError: true };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  }) as unknown as typeof globalThis.fetch;
  return { client: new HealthMcpClient(SECRET_URL, { fetch }), sent };
}

test("the client initializes once, then calls tools and parses their JSON", async () => {
  const { client, sent } = fakeBridge({ watch_get_latest_health: () => ({ connected: true }) });
  expect(await client.callTool("watch_get_latest_health")).toEqual({ connected: true });
  await client.callTool("watch_get_latest_health");
  expect(sent.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
});

test("bridge errors are explained, and never contain the secret address", async () => {
  const unknown = fakeBridge({});
  await expect(unknown.client.callTool("nope")).rejects.toThrow("nope failed: Unknown tool: nope");

  const wrongToken = fakeBridge({}, { status: 404 });
  const err = (await wrongToken.client.callTool("watch_get_latest_health").catch((e: Error) => e)) as Error;
  expect(err).toBeInstanceOf(HealthMcpError);
  expect(err.message).toContain("check the token");
  expect(err.message).not.toContain("secret-token-123");

  const offline = new HealthMcpClient(SECRET_URL, { fetch: (async () => Promise.reject(new TypeError(`fetch failed ${SECRET_URL}`))) as unknown as typeof fetch });
  const down = (await offline.callTool("x").catch((e: Error) => e)) as Error;
  expect(down.message).toBe("The health bridge could not connect");
});

// Night of Sep 26 → 27 (PDT = UTC-7): asleep 23:30–06:40 on the Watch, with the iPhone's rougher "in bed" and asleep record too.
const seg = (stage: string, start: string, end: string, minutes: number, source = "Rick's Apple Watch") => ({
  value: minutes,
  unit: "min",
  stage,
  started_at: start,
  sampled_at: end,
  source_device: source,
});
const lastNight = [
  seg("in_bed", "2026-09-27T06:15:00Z", "2026-09-27T13:50:00Z", 455),
  seg("asleep_core", "2026-09-27T06:30:00Z", "2026-09-27T09:00:00Z", 150),
  seg("asleep_deep", "2026-09-27T09:00:00Z", "2026-09-27T10:10:00Z", 70),
  seg("awake", "2026-09-27T10:10:00Z", "2026-09-27T10:20:00Z", 10),
  seg("asleep_rem", "2026-09-27T10:20:00Z", "2026-09-27T12:10:00Z", 110),
  seg("asleep_core", "2026-09-27T12:10:00Z", "2026-09-27T13:40:00Z", 90),
  seg("asleep_unspecified", "2026-09-27T06:20:00Z", "2026-09-27T13:30:00Z", 430, "Rick's iPhone"),
];
const olderNights = [
  seg("asleep_core", "2026-09-26T06:00:00Z", "2026-09-26T13:00:00Z", 420),
  seg("asleep_core", "2026-09-25T06:00:00Z", "2026-09-25T13:30:00Z", 450),
  seg("asleep_core", "2026-09-24T06:30:00Z", "2026-09-24T13:30:00Z", 420),
];
const morning = new Date("2026-09-27T15:00:00Z"); // 08:00 local

test("sleep: a night is dated by the wake-up day, one device per night, stages added up", () => {
  const [night] = sleepNights(lastNight, TZ);
  expect(night).toMatchObject({
    date: "2026-09-27",
    source: "Rick's iPhone", // 430 asleep beats the Watch's 420; never both
    asleepMinutes: 430,
  });
  const watchOnly = sleepNights(lastNight.filter((s) => s.source_device !== "Rick's iPhone"), TZ)[0];
  expect(watchOnly).toMatchObject({ asleepMinutes: 420, deepMinutes: 70, remMinutes: 110, coreMinutes: 240, awakeMinutes: 10, inBedMinutes: 455, asleepFrom: "23:30", asleepUntil: "06:40" });
});

test("sleep summary: last night against the average of the other nights", () => {
  const summary = summarizeSleep([...lastNight, ...olderNights], TZ, morning);
  expect(summary).toMatchObject({ status: "ok", latest: { date: "2026-09-27", isLastNight: true }, averageOtherNightsMinutes: 430 });
  if (summary.status === "ok") expect(summary.otherNights.map((n) => n.date)).toEqual(["2026-09-26", "2026-09-25", "2026-09-24"]);
});

test("sleep summary: says when the newest night isn't last night, and when there is none", () => {
  const nextDay = new Date("2026-09-28T15:00:00Z");
  expect(summarizeSleep(lastNight, TZ, nextDay)).toMatchObject({ latest: { isLastNight: false }, averageOtherNightsMinutes: null });
  expect(summarizeSleep([], TZ, morning)).toEqual({ status: "no_data", message: "No sleep has been recorded in the last 7 days." });
  expect(summarizeSleep([{ junk: true }, "nope"], TZ, morning)).toMatchObject({ status: "no_data" });
});

test("vitals: latest values with their age, recent readings, and missing ones marked, never zero", () => {
  const latest = {
    uploaded_at: "2026-09-27T14:00:00Z",
    metrics: {
      resting_heart_rate: { value: 64, sampled_at: "2026-09-27T13:00:00Z" },
      hrv_sdnn: { value: 31.46, sampled_at: "2026-09-27T12:00:00Z" },
    },
  };
  const summary = summarizeVitals(latest, { resting_heart_rate: [{ value: 64, sampled_at: "x" }, { value: 57, sampled_at: "y" }, { value: 56, sampled_at: "z" }] }, morning);
  expect(summary.lastUploadHoursAgo).toBe(1);
  expect(summary.stale).toBe(false);
  expect(summary.vitals.resting_heart_rate).toEqual({ value: 64, unit: "bpm", sampledAt: "2026-09-27T13:00:00Z", ageHours: 2 });
  expect(summary.vitals.hrv_sdnn).toMatchObject({ value: 31.5, unit: "ms" });
  expect(summary.vitals.oxygen_saturation).toEqual({ value: null, note: "not recorded" });
  expect(summary.recent.resting_heart_rate).toEqual([64, 57, 56]);
});

test("vitals: no upload at all, or an old one, is stale", () => {
  expect(summarizeVitals({ connected: false }, {}, morning)).toMatchObject({ lastUploadHoursAgo: null, stale: true });
  expect(summarizeVitals({ uploaded_at: "2026-09-26T15:00:00Z", metrics: {} }, {}, morning)).toMatchObject({ lastUploadHoursAgo: 24, stale: true });
});

test("health tools call the bridge and return summaries the model can read", async () => {
  const { client, sent } = fakeBridge({
    watch_get_health_history: (args) => ({ history: { [String(args.metric)]: args.metric === "sleep" ? [...lastNight, ...olderNights] : [] } }),
    watch_get_latest_health: () => ({ uploaded_at: "2026-09-27T14:00:00Z", metrics: {} }),
  });
  const [sleep, vitals] = healthTools(client, { timeZone: TZ, now: () => morning });
  const sleepResult = JSON.parse(await sleep.run({}));
  expect(sleepResult.readable).toEqual({
    latest: "7h10m asleep on the night ending 2026-09-27 (last night)",
    average: "7h10m average over the other recorded nights",
  });
  const vitalsResult = JSON.parse(await vitals.run({}));
  expect(vitalsResult.stale).toBe(false);
  expect(sent.filter((r) => r.method === "tools/call").map((r) => r.params?.arguments?.metric ?? r.params?.name)).toEqual([
    "sleep",
    "watch_get_latest_health",
    "resting_heart_rate",
    "hrv_sdnn",
  ]);
});

test("read_memory reports what is remembered, or that memory is off", async () => {
  const store = Store.open(":memory:");
  const [readMemory] = memoryTools(store, TZ);
  expect(JSON.parse(await readMemory.run({}))).toMatchObject({ status: "off" });
  store.setMemoryEnabled(true);
  expect(JSON.parse(await readMemory.run({}))).toMatchObject({ status: "empty" });
  const source = store.addMessage("user", "I have a half marathon on Oct 12");
  store.upsertFact({ category: "event", key: "half_marathon", value: "Running a half marathon", eventDate: "2026-10-12", evidence: "half marathon on Oct 12" }, source);
  expect(JSON.parse(await readMemory.run({}))).toMatchObject({ status: "ok", facts: [{ category: "event", fact: "Running a half marathon", date: "2026-10-12" }] });
});

test("health tools are offered only when HEALTH_MCP_URL is set", () => {
  const store = Store.open(":memory:");
  const without = agentToolset({ store, timeZone: TZ, healthMcpUrl: null });
  expect(without.tools.definitions().map((t) => t.name)).toEqual(["read_memory"]);
  const withHealth = agentToolset({ store, timeZone: TZ, healthMcpUrl: SECRET_URL });
  expect(withHealth.tools.definitions().map((t) => t.name)).toEqual(["get_sleep", "get_vitals", "read_memory"]);
});

test("in the small hours, last night is the one that ended yesterday morning", () => {
  const twoAm = new Date("2026-09-28T09:00:00Z"); // 02:00 on the 28th, local
  expect(summarizeSleep(lastNight, TZ, twoAm)).toMatchObject({ latest: { date: "2026-09-27", isLastNight: true } });
});
