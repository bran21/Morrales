import type { IncomingMessage, ServerResponse } from "node:http";
import { isAddress, toHex, type Address, type Hex } from "viem";
import { giwaSepolia, sepolia } from "viem/chains";
import {
  PORTAL_ADDRESS,
  getBalances,
  getBridgeStatus,
  prepareDeposit,
} from "./bridge.js";
import {
  CONFIG_REGISTRY,
  GIWA_SEPOLIA_RPC_URL,
  LAUNCH_FACTORY,
  WETH_ADDRESS,
  publicClientL2,
} from "./config.js";
import {
  clearLaunchCache,
  getLaunchpadBalances,
  listEnabledConfigs,
  listLaunches,
  prepareCreateLaunch,
  prepareLaunchTrade,
  prepareMigrateCurve,
  prepareWrapTx,
  quoteLaunchTrade,
} from "./launchpad.js";

type RequestWithParsedBody = IncomingMessage & { body?: unknown };

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  // Vercel's Node runtime pre-parses JSON bodies onto `req.body`, draining the stream.
  const preParsed = (req as RequestWithParsedBody).body;
  if (preParsed !== undefined) {
    if (typeof preParsed === "string") {
      const trimmed = preParsed.trim();
      return (trimmed ? JSON.parse(trimmed) : {}) as T;
    }
    if (Buffer.isBuffer(preParsed)) {
      const trimmed = preParsed.toString("utf8").trim();
      return (trimmed ? JSON.parse(trimmed) : {}) as T;
    }
    if (typeof preParsed === "object" && preParsed !== null) {
      return preParsed as T;
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > 65_536) {
      throw new Error("Request body too large.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

export function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err) {
    const shortMsg = String((err as { shortMessage: unknown }).shortMessage);
    const details =
      "details" in err && (err as { details?: unknown }).details
        ? ` (${String((err as { details: unknown }).details)})`
        : "";
    return `${shortMsg}${details}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/info") {
    return sendJson(res, 200, {
      portalAddress: PORTAL_ADDRESS,
      defaultAmountEth: "0.001",
      l1: {
        id: sepolia.id,
        name: sepolia.name,
        explorerUrl: "https://sepolia.etherscan.io",
      },
      l2: {
        id: giwaSepolia.id,
        name: giwaSepolia.name,
        rpcUrl: GIWA_SEPOLIA_RPC_URL,
        explorerUrl: "https://sepolia-explorer.giwa.io",
      },
      launchpad: {
        factory: LAUNCH_FACTORY,
        configRegistry: CONFIG_REGISTRY,
        weth: WETH_ADDRESS,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/balances") {
    const address = url.searchParams.get("address")?.trim() ?? "";
    if (!isAddress(address)) {
      return sendJson(res, 400, { error: "Invalid address query parameter." });
    }
    return sendJson(res, 200, await getBalances(address));
  }

  if (method === "POST" && url.pathname === "/api/prepare") {
    const body = await readJsonBody<{
      from?: string;
      to?: string;
      amountEth?: string;
    }>(req);

    if (!body.from || !isAddress(body.from)) {
      return sendJson(res, 400, { error: "Valid 'from' address is required." });
    }
    const recipient = body.to?.trim() ? body.to.trim() : body.from;
    if (!isAddress(recipient)) {
      return sendJson(res, 400, { error: "Invalid 'to' recipient address." });
    }

    const prepared = await prepareDeposit({
      from: body.from as Address,
      to: recipient as Address,
      amountEth: String(body.amountEth ?? ""),
    });

    return sendJson(res, 200, {
      to: prepared.portalAddress,
      data: prepared.calldata,
      valueHex: toHex(prepared.mintAmount),
      gasHex: toHex(prepared.l1GasLimit),
      estimatedL1Gas: prepared.estimatedL1Gas.toString(),
      l1GasLimit: prepared.l1GasLimit.toString(),
      l2Gas: prepared.l2Gas.toString(),
    });
  }

  if (method === "GET" && url.pathname === "/api/status") {
    const l1Hash = url.searchParams.get("l1Hash")?.trim() ?? "";
    return sendJson(res, 200, await getBridgeStatus(l1Hash as Hex));
  }

  // --- Launchpad API routes ---
  if (method === "GET" && url.pathname === "/api/launchpad/launches") {
    const rawBlocks = url.searchParams.get("blocks")?.trim();
    const lookback = rawBlocks ? BigInt(rawBlocks) : 60_000n;
    return sendJson(res, 200, await listLaunches(lookback));
  }

  if (method === "GET" && url.pathname === "/api/launchpad/configs") {
    return sendJson(res, 200, await listEnabledConfigs());
  }

  if (method === "GET" && url.pathname === "/api/launchpad/balances") {
    const account = url.searchParams.get("account")?.trim() ?? "";
    const rawToken = url.searchParams.get("token")?.trim();
    const token = rawToken ? (rawToken as Address) : undefined;
    return sendJson(
      res,
      200,
      await getLaunchpadBalances(account as Address, token)
    );
  }

  if (method === "POST" && url.pathname === "/api/launchpad/quote") {
    const body = await readJsonBody<{
      curve?: string;
      side?: string;
      amount?: string;
    }>(req);
    const side = body.side === "sell" ? "sell" : "buy";
    return sendJson(
      res,
      200,
      await quoteLaunchTrade({
        curve: String(body.curve ?? "") as Address,
        side,
        amount: String(body.amount ?? ""),
      })
    );
  }

  if (method === "POST" && url.pathname === "/api/launchpad/trade-prepare") {
    const body = await readJsonBody<{
      curve?: string;
      side?: string;
      amount?: string;
      account?: string;
      recipient?: string;
      slippageBps?: number;
    }>(req);
    const side = body.side === "sell" ? "sell" : "buy";
    return sendJson(
      res,
      200,
      await prepareLaunchTrade({
        curve: String(body.curve ?? "") as Address,
        side,
        amount: String(body.amount ?? ""),
        account: String(body.account ?? "") as Address,
        recipient: body.recipient?.trim()
          ? (body.recipient.trim() as Address)
          : undefined,
        slippageBps:
          typeof body.slippageBps === "number" ? body.slippageBps : 200,
      })
    );
  }

  if (method === "POST" && url.pathname === "/api/launchpad/create-prepare") {
    const body = await readJsonBody<{
      account?: string;
      configId?: string;
      name?: string;
      symbol?: string;
      description?: string;
      image?: string;
    }>(req);
    return sendJson(
      res,
      200,
      await prepareCreateLaunch({
        account: String(body.account ?? "") as Address,
        configId: String(body.configId ?? "6"),
        name: String(body.name ?? ""),
        symbol: String(body.symbol ?? ""),
        description: body.description,
        image: body.image,
      })
    );
  }

  if (method === "POST" && url.pathname === "/api/launchpad/migrate-prepare") {
    const body = await readJsonBody<{ curve?: string }>(req);
    return sendJson(
      res,
      200,
      await prepareMigrateCurve(String(body.curve ?? "") as Address)
    );
  }

  if (method === "POST" && url.pathname === "/api/launchpad/wrap-prepare") {
    const body = await readJsonBody<{ action?: string; amountEth?: string }>(
      req
    );
    const action = body.action === "unwrap" ? "unwrap" : "wrap";
    return sendJson(
      res,
      200,
      prepareWrapTx(action, String(body.amountEth ?? ""))
    );
  }

  if (method === "GET" && url.pathname === "/api/launchpad/tx-receipt") {
    const hash = url.searchParams.get("hash")?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return sendJson(res, 400, { error: "Invalid transaction hash." });
    }
    try {
      const receipt = await publicClientL2.getTransactionReceipt({
        hash: hash as Hex,
      });
      if (receipt.status === "success") {
        clearLaunchCache();
      }
      return sendJson(res, 200, {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
      });
    } catch {
      return sendJson(res, 200, { status: "pending" });
    }
  }

  sendJson(res, 404, { error: "API route not found." });
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/api", "http://127.0.0.1");
  const rewrittenPath = url.searchParams.get("__path");
  if (rewrittenPath !== null) {
    const cleanPath = rewrittenPath.replace(/^\/+/, "");
    if (url.pathname === "/api" || url.pathname === "/api/index") {
      url.pathname = cleanPath ? `/api/${cleanPath}` : "/api";
    }
    url.searchParams.delete("__path");
  }
  try {
    await handleApi(req, res, url);
  } catch (err) {
    sendJson(res, 400, { error: getErrorMessage(err) });
  }
}
