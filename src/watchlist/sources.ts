// Where company news comes from: only official sources. Each company's own
// newsroom feed (RSS or Atom) and its SEC filings (EDGAR). No news sites, no
// social media: what the company said, not what others say about it.
//
// SEC asks every automated client to name itself with a contact email in the
// User-Agent and to stay under 10 requests a second; DearByte makes one
// request per company per check.

import { z } from "zod";

export type WatchSource = "newsroom" | "sec";

/** One piece of news, before it's stored. `externalId` is stable across fetches. */
export type NewsItem = {
  company: string;
  source: WatchSource;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string;
  summary: string;
};

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;
const MAX_SUMMARY = 600;
const MAX_TITLE = 200;
/** A feed entry longer than this is skipped: real ones are a few KB, and it bounds the regex work. */
const MAX_BLOCK = 100_000;
const FEED_AGENT = "DearByte/0.1 (+https://github.com/dearbyte-labs/DearByte)";

export class SourceError extends Error {}

async function get(url: string, headers: Record<string, string>, f: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  } catch (err) {
    throw new SourceError(`${new URL(url).host} ${(err as Error).name === "TimeoutError" ? "timed out" : "could not connect"}`);
  }
  if (!res.ok) throw new SourceError(`${new URL(url).host} answered HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new SourceError(`${new URL(url).host} sent more than ${MAX_BYTES} bytes`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new SourceError(`${new URL(url).host} sent more than ${MAX_BYTES} bytes`);
  return text;
}

// ---- Newsroom feeds ----

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Drops HTML tags in one pass (a regex here goes quadratic on text full of unmatched "<"). */
function stripTags(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("<", i);
    if (open === -1) return out + s.slice(i);
    const close = s.indexOf(">", open);
    if (close === -1) return out + s.slice(i); // no tag after all: keep the rest as text
    out += `${s.slice(i, open)} `;
    i = close + 1;
  }
  return out;
}

/** The <item>/<entry> blocks, found by scanning forward once. */
function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const closeTag = `</${tag}>`;
  let i = 0;
  for (;;) {
    const open = xml.indexOf(`<${tag}`, i);
    if (open === -1) return out;
    const next = xml[open + tag.length + 1];
    if (next !== ">" && next !== " " && next !== "\n" && next !== "\t" && next !== "\r") {
      i = open + 1; // <itemfoo>, not <item>
      continue;
    }
    const close = xml.indexOf(closeTag, open);
    if (close === -1) return out; // unclosed: nothing after it can be trusted
    if (close - open <= MAX_BLOCK) out.push(xml.slice(open, close + closeTag.length));
    i = close + closeTag.length;
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Text content of the first <tag>, with CDATA unwrapped, HTML tags dropped and whitespace squeezed. */
function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Feeds escape the HTML in descriptions, so decode first, then drop the tags.
  return decode(stripTags(decode(raw))).replace(/\s+/g, " ").trim();
}

function atomLink(entry: string): string {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const href = (attrs: string) => attrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
  const alternate = links.find((a) => !/\brel\s*=/.test(a) || /\brel\s*=\s*["']alternate["']/i.test(a));
  return decode(href(alternate ?? links[0] ?? "") ?? "");
}

/** Parses an RSS 2.0 or Atom feed. Entries without a title, a link or a date are skipped. */
export function parseFeed(xml: string, company: string): NewsItem[] {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const items: NewsItem[] = [];
  for (const b of blocks(xml, atom ? "entry" : "item")) {
    const title = clip(tagText(b, "title"), MAX_TITLE);
    const guid = tagText(b, "guid");
    const url = atom ? atomLink(b) : tagText(b, "link") || (/^https?:\/\//.test(guid) ? guid : "");
    const date = atom ? tagText(b, "published") || tagText(b, "updated") : tagText(b, "pubDate") || tagText(b, "dc:date");
    const published = Date.parse(date);
    if (!title || !/^https?:\/\//.test(url) || !Number.isFinite(published)) continue;
    const summary = atom ? tagText(b, "summary") || tagText(b, "content") : tagText(b, "description");
    items.push({
      company,
      source: "newsroom",
      externalId: (atom ? tagText(b, "id") : guid) || url,
      title,
      url,
      publishedAt: new Date(published).toISOString(),
      summary: clip(summary, MAX_SUMMARY),
    });
  }
  return items;
}

export async function fetchFeed(url: string, company: string, f: typeof fetch = fetch): Promise<NewsItem[]> {
  return parseFeed(await get(url, { "user-agent": FEED_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, f), company);
}

// ---- SEC filings ----

/** Forms worth a look. Insider trades (Form 4) and planned sales (144) are frequent and rarely news. */
export const FORMS: Record<string, string> = {
  "8-K": "current report",
  "8-K/A": "amended current report",
  "10-Q": "quarterly report",
  "10-K": "annual report",
  "6-K": "foreign issuer report",
  "20-F": "annual report (foreign issuer)",
  "S-1": "registration statement",
  "DEF 14A": "proxy statement",
  "SC 13D": "5%+ ownership stake",
};

/** What the common 8-K items mean, so a filing's title says what happened. */
export const ITEMS_8K: Record<string, string> = {
  "1.01": "material agreement",
  "1.02": "agreement terminated",
  "2.01": "acquisition or disposal completed",
  "2.02": "results of operations",
  "2.05": "restructuring or layoffs",
  "2.06": "material impairment",
  "3.01": "delisting notice",
  "4.02": "past financials no longer reliable",
  "5.01": "change in control",
  "5.02": "executive or director change",
  "5.03": "bylaws or fiscal year change",
  "5.07": "shareholder vote results",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
};

const Submissions = z.object({
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      form: z.array(z.string()),
      acceptanceDateTime: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      items: z.array(z.string()).optional(),
    }),
  }),
});

/** Parses EDGAR's submissions JSON into the filings worth a look. */
export function parseFilings(json: unknown, company: string, cik: number): NewsItem[] {
  const parsed = Submissions.safeParse(json);
  if (!parsed.success) throw new SourceError("SEC sent filings in an unexpected shape");
  const r = parsed.data.filings.recent;
  const items: NewsItem[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    const kind = FORMS[form];
    const accepted = Date.parse(r.acceptanceDateTime[i] ?? "");
    if (!kind || !Number.isFinite(accepted)) continue;
    const codes = (r.items?.[i] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    const named = codes.filter((c) => c !== "9.01").map((c) => ITEMS_8K[c] ?? `item ${c}`);
    const accession = r.accessionNumber[i];
    items.push({
      company,
      source: "sec",
      externalId: accession,
      title: `${company} filed a ${form} (${kind})${named.length ? `: ${named.join(", ")}` : ""}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${r.primaryDocument[i]}`,
      publishedAt: new Date(accepted).toISOString(),
      summary: codes.length ? `8-K items ${codes.join(", ")}` : "",
    });
  }
  return items;
}

export async function fetchFilings(cik: number, company: string, contactEmail: string, f: typeof fetch = fetch): Promise<NewsItem[]> {
  const url = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
  const text = await get(url, { "user-agent": `DearByte/0.1 ${contactEmail}`, accept: "application/json", "accept-encoding": "gzip, deflate" }, f);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError("SEC sent something that isn't JSON");
  }
  return parseFilings(json, company, cik);
}
