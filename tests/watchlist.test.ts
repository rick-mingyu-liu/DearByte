import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAgentModel } from "../src/agent/fake.ts";
import type { AgentModel } from "../src/agent/model.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { WeeklyCapReached } from "../src/agent/usage.ts";
import { Store } from "../src/storage/store.ts";
import { checkWatchlist, MAX_NEWS_PER_DAY, type WatchlistDeps } from "../src/watchlist/check.ts";
import { loadWatchlist } from "../src/watchlist/config.ts";
import { fetchFilings, parseFeed, parseFilings } from "../src/watchlist/sources.ts";
import { watchlistTools } from "../src/watchlist/tools.ts";

const NOW = new Date("2026-09-26T10:00:00-04:00");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const rss = (items: Array<{ title: string; link: string; at: Date; description?: string }>) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Meta Newsroom</title>
${items
  .map(
    (i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><guid isPermaLink="false">${i.link}?p=1</guid>
<pubDate>${i.at.toUTCString()}</pubDate><description>${i.description ?? ""}</description></item>`,
  )
  .join("\n")}
</channel></rss>`;

// ---- Parsing ----

test("feeds: RSS with CDATA, entities and HTML in the description", () => {
  const [item] = parseFeed(
    rss([{ title: "Meta &amp; Ray-Ban: new glasses", link: "https://about.fb.com/news/2026/09/glasses/", at: hoursAgo(2), description: "&lt;p&gt;Today we&#8217;re launching &lt;b&gt;new&lt;/b&gt; glasses.&lt;/p&gt;" }]),
    "Meta",
  );
  expect(item).toEqual({
    company: "Meta",
    source: "newsroom",
    externalId: "https://about.fb.com/news/2026/09/glasses/?p=1",
    title: "Meta & Ray-Ban: new glasses",
    url: "https://about.fb.com/news/2026/09/glasses/",
    publishedAt: hoursAgo(2).toISOString(),
    summary: "Today we’re launching new glasses.",
  });
});

test("feeds: Atom takes the alternate link and the published date; broken entries are skipped", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Apple Newsroom</title>
<entry><id><![CDATA[tag:apple.com,2026:mac]]></id><title><![CDATA[The new Mac mini
]]></title><link rel="self" href="https://www.apple.com/self"/><link href="https://www.apple.com/newsroom/2026/09/mac-mini/"/>
<published>2026-09-22T12:59:21Z</published><updated>2026-09-23T00:00:00Z</updated><summary>Faster.</summary></entry>
<entry><title>No link</title><updated>2026-09-22T12:59:21Z</updated></entry>
<entry><title>Bad date</title><link href="https://www.apple.com/x"/><updated>soon</updated></entry></feed>`;
  expect(parseFeed(xml, "Apple")).toEqual([
    {
      company: "Apple",
      source: "newsroom",
      externalId: "tag:apple.com,2026:mac",
      title: "The new Mac mini",
      url: "https://www.apple.com/newsroom/2026/09/mac-mini/",
      publishedAt: "2026-09-22T12:59:21.000Z",
      summary: "Faster.",
    },
  ]);
});

const submissions = (rows: Array<[form: string, accepted: Date, accession: string, doc: string, items?: string]>) => ({
  filings: {
    recent: {
      form: rows.map((r) => r[0]),
      acceptanceDateTime: rows.map((r) => r[1].toISOString()),
      accessionNumber: rows.map((r) => r[2]),
      primaryDocument: rows.map((r) => r[3]),
      items: rows.map((r) => r[4] ?? ""),
    },
  },
});

test("filings: keeps the forms worth a look and names 8-K items", () => {
  const items = parseFilings(
    submissions([
      ["4", hoursAgo(1), "0000950103-26-014403", "xslF345X06/ownership.xml"],
      ["8-K", hoursAgo(3), "0001628280-26-050596", "meta-20260729.htm", "2.02,9.01"],
      ["10-Q", hoursAgo(4), "0001628280-26-050705", "meta-20260630.htm"],
    ]),
    "Meta",
    1326801,
  );
  expect(items.map((i) => i.title)).toEqual(["Meta filed a 8-K (current report): results of operations", "Meta filed a 10-Q (quarterly report)"]);
  expect(items[0]).toMatchObject({
    source: "sec",
    externalId: "0001628280-26-050596",
    url: "https://www.sec.gov/Archives/edgar/data/1326801/000162828026050596/meta-20260729.htm",
    summary: "8-K items 2.02, 9.01",
  });
  expect(() => parseFilings({ nope: 1 }, "Meta", 1)).toThrow("unexpected shape");
});

test("filings: SEC gets a User-Agent with the contact email, and errors name the host", async () => {
  let asked: { url: string; ua: string | null } | null = null;
  const ok = (async (url: string, init: RequestInit) => {
    asked = { url, ua: new Headers(init.headers).get("user-agent") };
    return new Response(JSON.stringify(submissions([])));
  }) as unknown as typeof fetch;
  await fetchFilings(1326801, "Meta", "me@example.com", ok);
  expect(asked).toEqual({ url: "https://data.sec.gov/submissions/CIK0001326801.json", ua: "DearByte/0.1 me@example.com" });
  const denied = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  await expect(fetchFilings(1, "Meta", "me@example.com", denied)).rejects.toThrow("data.sec.gov answered HTTP 403");
});

// ---- A full check ----

const WATCHLIST = { interests: "Meta internship; launches, AI, earnings.", companies: [{ name: "Meta", cik: 1326801, feeds: ["https://about.fb.com/feed/"] }] };

function world(o: { feed: string; filings?: unknown; feedDown?: boolean }) {
  const fetched: string[] = [];
  const fetch = (async (url: string) => {
    fetched.push(url);
    if (url.includes("about.fb.com")) return o.feedDown ? new Response("", { status: 503 }) : new Response(o.feed);
    return new Response(JSON.stringify(o.filings ?? submissions([])));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, fetched };
}

function deps(o: { feed: string; filings?: unknown; worker?: AgentModel; brain?: AgentModel; now?: Date; store?: Store; secContact?: string | null; feedDown?: boolean }) {
  const store = o.store ?? Store.open(":memory:");
  const sent: Array<{ title: string; body: string; alertId?: number }> = [];
  const w = world(o);
  const d: WatchlistDeps = {
    store,
    model: o.brain ?? new FakeAgentModel([FakeAgentModel.text("Meta launched new glasses, a big product bet.")]),
    worker: o.worker ?? new FakeAgentModel([]),
    tools: new ToolRegistry([]),
    system: "s",
    timeZone: "America/Toronto",
    notify: async (title, body, n) => (sent.push({ title, body, alertId: n?.alertId }), true),
    watchlist: WATCHLIST,
    secContact: o.secContact === undefined ? "me@example.com" : o.secContact,
    fetch: w.fetch,
    now: () => o.now ?? NOW,
  };
  return { d, store, sent, fetched: w.fetched };
}

const screenAs = (...verdicts: Array<[n: number, relevant: boolean]>) =>
  new FakeAgentModel([FakeAgentModel.toolUse(["record_verdicts", { verdicts: verdicts.map(([n, relevant]) => ({ n, relevant, reason: relevant ? "a launch" : "marketing" })) }]), FakeAgentModel.text("done")]);

const FEED = rss([
  { title: "New glasses", link: "https://about.fb.com/news/glasses/", at: hoursAgo(3) },
  { title: "Holiday recipes with Meta AI", link: "https://about.fb.com/news/recipes/", at: hoursAgo(2) },
  { title: "Last month's update", link: "https://about.fb.com/news/old/", at: hoursAgo(24 * 20) },
]);

test("check: screens only fresh items, sends one message with code-made links, and dedupes next time", async () => {
  const worker = screenAs([1, true], [2, false], [3, true]);
  const filings = submissions([["8-K", hoursAgo(1), "0001628280-26-000001", "meta-8k.htm", "5.02"]]);
  const { d, store, sent, fetched } = deps({ feed: FEED, filings, worker });
  const out = await checkWatchlist(d);

  expect(fetched).toEqual(["https://about.fb.com/feed/", "https://data.sec.gov/submissions/CIK0001326801.json"]);
  expect(out).toMatchObject({ added: 4, screened: 3, relevant: 2, errors: [], message: { sent: true, kind: "news" } });
  // The old post was recorded but never shown to the model.
  const screened = String(worker.requests[0].messages[0].content);
  expect(screened).toContain("Meta internship");
  expect(screened).not.toContain("Last month's update");
  expect(screened).toContain("Meta filed a 8-K (current report): executive or director change");

  expect(sent).toHaveLength(1);
  expect(sent[0].body).toBe(
    "Meta launched new glasses, a big product bet.\n\nSources:\n- New glasses: https://about.fb.com/news/glasses/\n- Meta filed a 8-K (current report): executive or director change: https://www.sec.gov/Archives/edgar/data/1326801/000162828026000001/meta-8k.htm",
  );
  expect(sent[0].alertId).toBeGreaterThan(0);
  expect(store.alertsOn("2026-09-26")[0].triggers).toEqual(["news:1", "news:4"]);

  // Same feed an hour later: nothing new, no model calls, no message.
  const again = deps({ feed: FEED, filings, store, worker: new FakeAgentModel([]), now: new Date(NOW.getTime() + 3_600_000) });
  expect(await checkWatchlist(again.d)).toMatchObject({ added: 0, screened: 0, message: null });
  expect(again.sent).toHaveLength(0);
});

test("check: holds news in quiet hours and past the daily limit, and sends it later", async () => {
  const night = new Date("2026-09-26T23:30:00-04:00");
  const late = rss([{ title: "Late launch", link: "https://about.fb.com/news/late/", at: new Date(night.getTime() - 3_600_000) }]);
  const { d, store, sent } = deps({ feed: late, worker: screenAs([1, true]), now: night });
  expect((await checkWatchlist(d)).message).toMatchObject({ sent: false, reason: "quiet hours" });
  expect(sent).toHaveLength(0);

  const morning = deps({ feed: late, store, now: new Date("2026-09-27T08:00:00-04:00") });
  expect((await checkWatchlist(morning.d)).message).toMatchObject({ sent: true });
  expect(store.watchItemsWithStatus("sent")).toHaveLength(1);

  for (let i = 0; i < MAX_NEWS_PER_DAY; i++) store.recordAlert({ at: NOW.toISOString(), date: "2026-09-26", kind: "news", triggers: [], text: "x", delivered: true });
  const busy = deps({ feed: rss([{ title: "One more", link: "https://about.fb.com/news/more/", at: hoursAgo(1) }]), worker: screenAs([1, true]), store });
  expect((await checkWatchlist(busy.d)).message).toMatchObject({ sent: false, reason: "daily news limit reached" });
});

test("check: a failing source is reported and the rest still run; no contact email, no SEC call", async () => {
  const { d, fetched } = deps({ feed: FEED, feedDown: true, secContact: null });
  expect(await checkWatchlist(d)).toMatchObject({ added: 0, errors: ["Meta newsroom: about.fb.com answered HTTP 503"] });
  expect(fetched).toEqual(["https://about.fb.com/feed/"]);
});

test("check: the weekly cap during screening sends the notice; unscreened items wait", async () => {
  const capped: AgentModel = { name: "capped", step: async () => Promise.reject(new WeeklyCapReached("over")), cost: () => 0 };
  const { d, store, sent } = deps({ feed: FEED, worker: capped });
  expect((await checkWatchlist(d)).message).toMatchObject({ sent: true, kind: "notice" });
  expect(sent[0].body).toContain("spending reached the cap");
  expect(store.watchItemsWithStatus("new")).toHaveLength(2);
});

test("check: news too old to matter is dropped instead of sent late", async () => {
  const { d, store } = deps({ feed: FEED, worker: new FakeAgentModel([FakeAgentModel.text("no verdicts")]) });
  await checkWatchlist(d); // the worker never recorded verdicts: the items stay new
  expect(store.watchItemsWithStatus("new")).toHaveLength(2);
  const later = deps({ feed: FEED, store, now: new Date(NOW.getTime() + 72 * 3_600_000) });
  await checkWatchlist(later.d);
  expect(store.watchItemsWithStatus("new")).toHaveLength(0);
  expect(later.sent).toHaveLength(0);
});

// ---- The agent's tool and the config file ----

test("tool: recent news with verdicts, and a clear answer for companies not followed", async () => {
  const { d, store } = deps({ feed: FEED, worker: screenAs([1, true], [2, false]) });
  await checkWatchlist(d);
  const [tool] = watchlistTools(store, WATCHLIST, () => NOW);
  const all = JSON.parse(await tool.run({}));
  expect(all.items.map((i: { title: string; verdict: string }) => `${i.title}: ${i.verdict}`)).toEqual([
    "Holiday recipes with Meta AI: not worth a message",
    "New glasses: told the user",
  ]);
  expect(JSON.parse(await tool.run({ company: "tesla" })).status).toBe("not_followed");
  expect(JSON.parse(await tool.run({ company: "meta" })).items).toHaveLength(2);
});

test("config: missing file, bad JSON and bad fields are told apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-wl-"));
  expect(loadWatchlist(join(dir, "none.json"))).toBeNull();
  writeFileSync(join(dir, "bad.json"), "{");
  expect(loadWatchlist(join(dir, "bad.json"))).toHaveProperty("problem");
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ interests: "x", companies: [{ name: "Meta", feeds: ["ftp://x"] }] }));
  expect(loadWatchlist(join(dir, "wrong.json"))).toHaveProperty("problem");
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ interests: "x", companies: [{ name: "Meta" }] }));
  expect(loadWatchlist(join(dir, "ok.json"))).toEqual({ interests: "x", companies: [{ name: "Meta", feeds: [] }] });
});

// ---- From review: hostile input, delivery failures, collisions ----

test("feeds: hostile input parses in linear time", () => {
  const started = performance.now();
  parseFeed(`<rss>${"<item>".repeat(200_000)}`, "X");
  parseFeed(`<rss><item><title>${"&lt;".repeat(200_000)}</title><link>https://x.com/a</link><pubDate>${NOW.toUTCString()}</pubDate></item></rss>`, "X");
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("feeds: a guid-only item uses the guid as its link; long titles are cut", () => {
  const xml = `<rss><item><title>${"T".repeat(500)}</title><guid>https://x.com/post/1</guid><pubDate>${NOW.toUTCString()}</pubDate></item></rss>`;
  const [item] = parseFeed(xml, "X");
  expect(item.url).toBe("https://x.com/post/1");
  expect(item.title.length).toBe(201);
});

test("check: news that failed to reach the user is tried again next check", async () => {
  const { d, store } = deps({ feed: FEED, worker: screenAs([1, true], [2, false]) });
  d.notify = async () => false;
  expect((await checkWatchlist(d)).message).toMatchObject({ sent: true, delivered: false });
  expect(store.watchItemsWithStatus("relevant")).toHaveLength(1);
  const retry = deps({ feed: FEED, store, now: new Date(NOW.getTime() + 3_600_000) });
  expect((await checkWatchlist(retry.d)).message).toMatchObject({ delivered: true });
  expect(store.watchItemsWithStatus("sent")).toHaveLength(1);
});

test("store: the same id from two companies is two items, and a claim wins once", () => {
  const store = Store.open(":memory:");
  const item = { source: "newsroom", externalId: "1234", title: "t", url: "https://x.com", publishedAt: NOW.toISOString(), summary: "", status: "new" as const };
  expect(store.addWatchItems([{ ...item, company: "A" }, { ...item, company: "B" }], NOW.toISOString())).toHaveLength(2);
  expect(store.claimWatchItems([1, 2], "new", "sending")).toEqual([1, 2]);
  expect(store.claimWatchItems([1, 2], "new", "sending")).toEqual([]);
});

test("check: a date in the future counts as now; SEC is asked one company at a time", async () => {
  const future = rss([{ title: "From the future", link: "https://about.fb.com/news/future/", at: new Date(NOW.getTime() + 30 * 86_400_000) }]);
  const two = { ...WATCHLIST, companies: [...WATCHLIST.companies, { name: "Apple", cik: 320193, feeds: [] }] };
  const { d, store } = deps({ feed: future, worker: screenAs([1, false]) });
  let inFlight = 0;
  let most = 0;
  const base = d.fetch!;
  d.watchlist = two;
  d.fetch = (async (url: string, init?: RequestInit) => {
    const sec = url.includes("sec.gov");
    if (sec) most = Math.max(most, ++inFlight);
    const res = await base(url, init);
    if (sec) inFlight--;
    return res;
  }) as typeof fetch;
  await checkWatchlist(d);
  expect(most).toBe(1);
  expect(store.recentWatchItems("2000-01-01")[0].publishedAt).toBe(NOW.toISOString());
});
