// A small MCP client for dearbyte-bridge, the Worker that holds the user's
// Apple Health data. MCP over HTTP is JSON-RPC 2.0 in POST requests: the
// client initializes once, then calls tools; each tool answers with a text
// block, which the bridge fills with JSON.
//
// The MCP address contains the secret that grants read access to health
// data, so it never appears in an error message or a log line.

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 20_000;

export class HealthMcpError extends Error {}

type RpcResponse = { result?: unknown; error?: { code?: number; message?: string } };
type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

export class HealthMcpClient {
  private nextId = 1;
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly o: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  /** Calls a bridge tool and returns its JSON answer. Throws HealthMcpError when it can't. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.initialized ??= this.initialize().catch((err) => {
      this.initialized = null; // try again next time
      throw err;
    });
    await this.initialized;
    const result = (await this.request("tools/call", { name, arguments: args })) as ToolResult;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (result?.isError) throw new HealthMcpError(`${name} failed: ${text.slice(0, 300) || "no details"}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new HealthMcpError(`${name} returned something that isn't JSON`);
    }
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "dearbyte", version: "0.1.0" } });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const body = (await res.json().catch(() => null)) as RpcResponse | null;
    if (!body) throw new HealthMcpError(`${method}: the bridge answered with something that isn't JSON`);
    if (body.error) throw new HealthMcpError(`${method}: ${body.error.message ?? "error"} (${body.error.code ?? "?"})`);
    return body.result;
  }

  private async send(body: Record<string, unknown>): Promise<Response> {
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Network errors can quote the URL; only the reason is kept.
      const reason = (err as Error).name === "TimeoutError" ? "timed out" : "could not connect";
      throw new HealthMcpError(`The health bridge ${reason}`);
    }
    if (res.status === 404) throw new HealthMcpError("The health bridge answered 404: check the token in HEALTH_MCP_URL");
    if (!res.ok && res.status !== 202) throw new HealthMcpError(`The health bridge answered HTTP ${res.status}`);
    return res;
  }
}
