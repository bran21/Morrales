import {
  AmmoraPortableLaunchPlanner,
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  buildAmmoraPortableUnwrapTransaction,
  buildAmmoraPortableWrapTransaction,
  classifyAmmoraV4ExactInputFill,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAtomicLaunchDeployment,
  verifyAmmoraPortableDeploymentAtBlock,
} from "@ammora-protocol/sdk";
import {
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  CONFIG_REGISTRY,
  FEE_POLICY,
  LAUNCH_FACTORY,
  WETH_ADDRESS,
  ammoraPublicClient as publicClientL2,
} from "./config.js";

export interface DecodedMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
}

export interface LaunchSummary {
  token: Address;
  curve: Address;
  creator: Address;
  configId: string;
  blockNumber: string;
  ageSeconds: number;
  name: string;
  symbol: string;
  description: string;
  image: string;
  decimals: number;
  status: number;
  phase: "Trading" | "ReadyToMigrate" | "Migrated";
  currentFeeBps: number;
  quoteReserveWei: string;
  quoteReserveEth: string;
  baseReserveFormatted: string;
  migrationTargetWei: string;
  migrationTargetEth: string;
  progressBps: number;
  progressPct: number;
  readyToMigrate: boolean;
  migrated: boolean;
  canonicalPool: Address;
}

interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
}

const tokenMetaCache = new Map<string, TokenMeta>();
const launchCache = new Map<string, { expiresAt: number; data: unknown }>();

export function clearLaunchCache(): void {
  launchCache.clear();
}
const LAUNCH_CREATED_EVENT = ammoraLaunchFactoryV4Abi.find(
  (item) => item.type === "event" && item.name === "LaunchCreated"
);

function sanitizeImageUri(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("data:image/")
  ) {
    return trimmed;
  }
  return "";
}

export function decodeMetadataUri(metadataURI: string): DecodedMetadata {
  if (!metadataURI) return {};
  try {
    let jsonText = "";
    if (metadataURI.startsWith("data:application/json;base64,")) {
      const b64 = metadataURI.slice("data:application/json;base64,".length);
      jsonText = Buffer.from(b64, "base64").toString("utf8");
    } else if (metadataURI.startsWith("data:application/json;utf8,")) {
      const raw = metadataURI.slice("data:application/json;utf8,".length);
      jsonText = raw.startsWith("%") ? decodeURIComponent(raw) : raw;
    } else if (metadataURI.startsWith("data:application/json,")) {
      const raw = metadataURI.slice("data:application/json,".length);
      jsonText = raw.startsWith("%") ? decodeURIComponent(raw) : raw;
    } else if (metadataURI.startsWith("{")) {
      jsonText = metadataURI;
    }

    if (!jsonText) return {};
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      name: typeof parsed.name === "string" ? parsed.name.trim() : undefined,
      symbol: typeof parsed.symbol === "string" ? parsed.symbol.trim() : undefined,
      description:
        typeof parsed.description === "string"
          ? parsed.description.trim()
          : undefined,
      image: sanitizeImageUri(parsed.image),
    };
  } catch {
    return {};
  }
}

export async function getTokenMeta(token: Address): Promise<TokenMeta> {
  const key = token.toLowerCase();
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;

  const [name, symbol, decimals] = await Promise.all([
    publicClientL2
      .readContract({ address: token, abi: erc20Abi, functionName: "name" })
      .catch(() => "Unknown Token"),
    publicClientL2
      .readContract({ address: token, abi: erc20Abi, functionName: "symbol" })
      .catch(() => "TOKEN"),
    publicClientL2
      .readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
      .catch(() => 18),
  ]);

  const meta = {
    name: String(name),
    symbol: String(symbol),
    decimals: Number(decimals),
  };
  tokenMetaCache.set(key, meta);
  return meta;
}

export async function getLaunchpadBalances(
  account: Address,
  token?: Address
) {
  if (!isAddress(account)) {
    throw new Error(`Invalid wallet address: ${account}`);
  }

  const [ethWei, wethWei] = await Promise.all([
    publicClientL2.getBalance({ address: account }),
    publicClientL2.readContract({
      address: WETH_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }),
  ]);

  let tokenBalance: {
    address: Address;
    symbol: string;
    decimals: number;
    raw: string;
    formatted: string;
  } | null = null;

  if (token) {
    if (!isAddress(token)) {
      throw new Error(`Invalid token address: ${token}`);
    }
    const [meta, rawBal] = await Promise.all([
      getTokenMeta(token),
      publicClientL2.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }),
    ]);
    tokenBalance = {
      address: token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      raw: rawBal.toString(),
      formatted: formatUnits(rawBal, meta.decimals),
    };
  }

  return {
    account,
    ethWei: ethWei.toString(),
    eth: formatEther(ethWei),
    wethWei: wethWei.toString(),
    weth: formatEther(wethWei),
    token: tokenBalance,
  };
}

function phaseFromStatus(
  status: number
): "Trading" | "ReadyToMigrate" | "Migrated" {
  if (status === 2) return "ReadyToMigrate";
  if (status === 3) return "Migrated";
  return "Trading";
}

async function getConfirmedBlockNumber(): Promise<bigint> {
  const head = await publicClientL2.getBlockNumber();
  return head > 2n ? head - 2n : head;
}

export async function listLaunches(lookbackBlocks = 60_000n) {
  const safeLookback =
    lookbackBlocks < 5_000n
      ? 5_000n
      : lookbackBlocks > 200_000n
      ? 200_000n
      : lookbackBlocks;
  const cacheKey = safeLookback.toString();
  const cached = launchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (!LAUNCH_CREATED_EVENT) {
    throw new Error("LaunchCreated event ABI missing from SDK.");
  }

  const headBlock = await getConfirmedBlockNumber();
  const startBlock = headBlock > safeLookback ? headBlock - safeLookback : 0n;
  const chunkSize = 9_500n;
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let to = headBlock; to > startBlock; ) {
    const from = to > chunkSize + startBlock ? to - chunkSize : startBlock;
    ranges.push({ fromBlock: from, toBlock: to });
    if (from <= startBlock) break;
    to = from - 1n;
  }

  const allLogs: Array<{
    args: {
      token?: Address;
      curve?: Address;
      creator?: Address;
      configId?: bigint;
      metadataURI?: string;
    };
    blockNumber: bigint;
  }> = [];

  for (let i = 0; i < ranges.length; i += 4) {
    const batch = ranges.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((r) =>
        publicClientL2.getLogs({
          address: LAUNCH_FACTORY,
          event: LAUNCH_CREATED_EVENT,
          fromBlock: r.fromBlock,
          toBlock: r.toBlock,
        })
      )
    );
    for (const logs of results) {
      for (const log of logs) {
        allLogs.push(log as unknown as (typeof allLogs)[number]);
      }
    }
  }

  const seenCurves = new Set<string>();
  const uniqueLogs = allLogs
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
    .filter((log) => {
      const curve = log.args.curve?.toLowerCase();
      if (!curve || seenCurves.has(curve)) return false;
      seenCurves.add(curve);
      return true;
    })
    .slice(0, 30);

  const launches: LaunchSummary[] = [];
  for (let i = 0; i < uniqueLogs.slice(0, 20).length; i += 4) {
    const batch = uniqueLogs.slice(0, 20).slice(i, i + 4);
    const hydrated = await Promise.all(
      batch.map(async (log): Promise<LaunchSummary | null> => {
        const token = log.args.token;
        const curveAddr = log.args.curve;
        const creator = log.args.creator;
        if (!token || !curveAddr || !creator) return null;

        try {
          const curveClient = new AmmoraV4LaunchCurveClient(
            publicClientL2,
            curveAddr,
            {
              launchFactory: LAUNCH_FACTORY,
              feePolicy: FEE_POLICY,
            }
          );
          const [state, progress, meta] = await Promise.all([
            curveClient.getStateAtBlock(headBlock),
            curveClient.getMigrationProgressAtBlock(headBlock),
            getTokenMeta(token),
          ]);
          const parsedMeta = decodeMetadataUri(log.args.metadataURI ?? "");

          return {
            token,
            curve: curveAddr,
            creator,
            configId: (log.args.configId ?? state.configId).toString(),
            blockNumber: log.blockNumber.toString(),
            ageSeconds: Number(headBlock - log.blockNumber),
            name: parsedMeta.name || meta.name,
            symbol: parsedMeta.symbol || meta.symbol,
            description: parsedMeta.description || "",
            image: parsedMeta.image || "",
            decimals: meta.decimals,
            status: state.status,
            phase: phaseFromStatus(state.status),
            currentFeeBps: state.currentFeeBps,
            quoteReserveWei: state.quoteReserve.toString(),
            quoteReserveEth: formatEther(state.quoteReserve),
            baseReserveFormatted: formatUnits(state.baseReserve, meta.decimals),
            migrationTargetWei: progress.target.toString(),
            migrationTargetEth: formatEther(progress.target),
            progressBps: progress.progressBps,
            progressPct: Number((progress.progressBps / 100).toFixed(2)),
            readyToMigrate: progress.ready,
            migrated: progress.migrated,
            canonicalPool: progress.canonicalPool,
          };
        } catch {
          return null;
        }
      })
    );
    for (const item of hydrated) {
      if (item) launches.push(item);
    }
  }

  const nextConfigId = await getAmmoraV4NextConfigId(
    publicClientL2,
    CONFIG_REGISTRY,
    headBlock
  ).catch(() => 0n);

  const payload = {
    blockNumber: headBlock.toString(),
    lookbackBlocks: safeLookback.toString(),
    totalConfigs: nextConfigId > 0n ? (nextConfigId - 1n).toString() : "0",
    launches,
  };
  launchCache.set(cacheKey, { expiresAt: Date.now() + 12_000, data: payload });
  return payload;
}

export async function listEnabledConfigs() {
  const cacheKey = "configs";
  const cached = launchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const headBlock = await getConfirmedBlockNumber();
  const nextConfigId = await getAmmoraV4NextConfigId(
    publicClientL2,
    CONFIG_REGISTRY,
    headBlock
  );

  const idSet = new Set<bigint>();
  for (const coreId of [1n, 4n, 6n]) {
    if (coreId < nextConfigId) idSet.add(coreId);
  }
  const startId = nextConfigId > 15n ? nextConfigId - 15n : 1n;
  for (let id = startId; id < nextConfigId; id++) {
    idSet.add(id);
  }
  const ids = Array.from(idSet);

  const configs: Array<{
    configId: string;
    configHash: Hex;
    tokenDecimals: number;
    totalSupplyFormatted: string;
    migrationQuoteThresholdEth: string;
    poolCreationFeeEth: string;
    cliffFeeBps: number;
    postMigrationFeeBps: number;
    creatorShareBps: number;
    owner: Address;
  }> = [];

  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const items = await Promise.all(
      batch.map((id) =>
        getAmmoraV4ConfigAtBlock(
          publicClientL2,
          CONFIG_REGISTRY,
          id,
          headBlock
        ).catch(() => null)
      )
    );
    for (const entry of items) {
      if (!entry || !entry.enabled) continue;
      if (entry.config.quoteToken.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
        continue;
      }
      configs.push({
        configId: entry.configId.toString(),
        configHash: entry.configHash,
        tokenDecimals: entry.config.tokenDecimals,
        totalSupplyFormatted: formatUnits(
          entry.config.totalSupply,
          entry.config.tokenDecimals
        ),
        migrationQuoteThresholdEth: formatEther(
          entry.config.migrationQuoteThreshold
        ),
        poolCreationFeeEth: formatEther(entry.config.poolCreationFee),
        cliffFeeBps: entry.config.cliffFeeBps,
        postMigrationFeeBps: entry.config.postMigrationFeeBps,
        creatorShareBps: entry.config.creatorShareOfNonProtocolBps,
        owner: entry.identity.owner,
      });
    }
  }

  configs.sort((a, b) => Number(BigInt(b.configId) - BigInt(a.configId)));
  const payload = { blockNumber: headBlock.toString(), configs };
  launchCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: payload });
  return payload;
}

export async function quoteLaunchTrade(params: {
  curve: Address;
  side: "buy" | "sell";
  amount: string;
}) {
  if (!isAddress(params.curve)) {
    throw new Error(`Invalid curve address: ${params.curve}`);
  }
  const trimmed = params.amount.trim();
  if (!trimmed) {
    throw new Error("Trade amount is required.");
  }

  const headBlock = await getConfirmedBlockNumber();
  const curveClient = new AmmoraV4LaunchCurveClient(
    publicClientL2,
    params.curve,
    { launchFactory: LAUNCH_FACTORY, feePolicy: FEE_POLICY }
  );
  const state = await curveClient.getStateAtBlock(headBlock);
  const meta = await getTokenMeta(state.baseToken);

  const baseForQuote = params.side === "sell";
  const inDecimals = baseForQuote ? meta.decimals : 18;
  const outDecimals = baseForQuote ? 18 : meta.decimals;
  const amountInRaw = parseUnits(trimmed, inDecimals);
  if (amountInRaw <= 0n) {
    throw new Error("Trade amount must be greater than 0.");
  }

  const quote = await curveClient.quoteExactInputAtBlock(
    amountInRaw,
    baseForQuote,
    headBlock
  );
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);

  return {
    curve: params.curve,
    side: params.side,
    status: state.status,
    phase: phaseFromStatus(state.status),
    baseToken: state.baseToken,
    baseSymbol: meta.symbol,
    baseDecimals: meta.decimals,
    amountInFormatted: formatUnits(quote.amountIn, inDecimals),
    amountOutFormatted: formatUnits(quote.amountOut, outDecimals),
    feeFormatted: formatUnits(quote.fee, 18),
    amountLeftFormatted: formatUnits(quote.amountLeft, inDecimals),
    fillKind: fill.kind,
    allowPartialFill: fill.allowPartialFill,
  };
}

function serializeTx(tx: { to: Address; data: Hex; value?: bigint }, gasLimit?: bigint) {
  return {
    to: tx.to,
    data: tx.data,
    valueHex: toHex(tx.value ?? 0n),
    ...(gasLimit ? { gasHex: toHex(gasLimit) } : {}),
  };
}

async function getGasOptions() {
  const fees = await publicClientL2.estimateFeesPerGas();
  return {
    maxFeePerGasNativeRaw: fees.maxFeePerGas ?? 1_000_000_000n,
    safetyMarginBps: 2000n,
  };
}

export async function prepareLaunchTrade(params: {
  curve: Address;
  side: "buy" | "sell";
  amount: string;
  account: Address;
  recipient?: Address;
  slippageBps?: number;
}) {
  if (!isAddress(params.curve)) {
    throw new Error(`Invalid curve address: ${params.curve}`);
  }
  if (!isAddress(params.account)) {
    throw new Error(`Invalid account address: ${params.account}`);
  }
  const recipient = params.recipient ?? params.account;
  if (!isAddress(recipient)) {
    throw new Error(`Invalid recipient address: ${recipient}`);
  }

  const headBlock = await getConfirmedBlockNumber();
  const curveClient = new AmmoraV4LaunchCurveClient(
    publicClientL2,
    params.curve,
    { launchFactory: LAUNCH_FACTORY, feePolicy: FEE_POLICY }
  );
  const state = await curveClient.getStateAtBlock(headBlock);
  const meta = await getTokenMeta(state.baseToken);

  const baseForQuote = params.side === "sell";
  const inDecimals = baseForQuote ? meta.decimals : 18;
  const outDecimals = baseForQuote ? 18 : meta.decimals;
  const includedAmountInRaw = parseUnits(params.amount.trim(), inDecimals);
  if (includedAmountInRaw <= 0n) {
    throw new Error("Trade amount must be greater than 0.");
  }

  const quotePreview = await curveClient.quoteExactInputAtBlock(
    includedAmountInRaw,
    baseForQuote,
    headBlock
  );
  const fill = classifyAmmoraV4ExactInputFill(quotePreview, baseForQuote);
  if (fill.kind === "terminal-dust") {
    throw new Error(
      "Curve is at terminal dust before migration and cannot accept this trade."
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const slippageBps = Number(params.slippageBps ?? 200);

  const plan = await curveClient.planSwapExactInput({
    includedAmountIn: includedAmountInRaw,
    baseForQuote,
    allowPartialFill: !baseForQuote && fill.allowPartialFill,
    slippageBps,
    recipient,
    deadline,
  });

  const { token: inputToken, spender, amount: requiredAmount } =
    plan.approvalRequirement;

  const [balance, allowance] = await Promise.all([
    publicClientL2.readContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [params.account],
    }),
    publicClientL2.readContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [params.account, spender],
    }),
  ]);

  if (balance < requiredAmount) {
    const missingSym = baseForQuote ? meta.symbol : "WETH";
    throw new Error(
      `Insufficient ${missingSym} balance (${formatUnits(balance, inDecimals)} ${missingSym}).${
        baseForQuote ? "" : " Wrap GIWA ETH into WETH first."
      }`
    );
  }

  const quoteSummary = {
    expectedOut: formatUnits(plan.quote.amountOut, outDecimals),
    minimumOut: formatUnits(plan.quote.minimumAmountOut, outDecimals),
    outSymbol: baseForQuote ? "WETH" : meta.symbol,
  };

  if (allowance < requiredAmount) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, requiredAmount],
    });
    return {
      status: "APPROVAL_REQUIRED" as const,
      transactionKind: "ERC20_APPROVAL" as const,
      transaction: serializeTx({ to: inputToken, data: approveData, value: 0n }),
      quote: quoteSummary,
    };
  }

  return {
    status: "READY" as const,
    transactionKind: "SWAP" as const,
    transaction: serializeTx(plan.transaction),
    quote: quoteSummary,
  };
}

export async function prepareCreateLaunch(params: {
  account: Address;
  configId: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
}) {
  if (!isAddress(params.account)) {
    throw new Error(`Invalid creator address: ${params.account}`);
  }
  const name = params.name.trim();
  const symbol = params.symbol.trim();
  if (!name || !symbol) {
    throw new Error("Token name and symbol are required.");
  }

  const configId = BigInt(params.configId);
  const headBlock = await getConfirmedBlockNumber();
  const [cfg, context, gasOpts] = await Promise.all([
    getAmmoraV4ConfigAtBlock(publicClientL2, CONFIG_REGISTRY, configId, headBlock),
    verifyAmmoraPortableDeploymentAtBlock(
      publicClientL2,
      giwaSepoliaAtomicLaunchDeployment,
      headBlock
    ),
    getGasOptions(),
  ]);

  if (!cfg.enabled) {
    throw new Error(`Launch config #${configId} is disabled.`);
  }

  const metadataJson = JSON.stringify({
    name,
    symbol,
    description: params.description?.trim() || `${name} launched via Morrales on GIWA Sepolia.`,
    image: sanitizeImageUri(params.image),
    created: new Date().toISOString(),
  });
  const metadataURI = `data:application/json;utf8,${encodeURIComponent(metadataJson)}`;

  const planner = new AmmoraPortableLaunchPlanner(context);
  const plan = await planner.planCreate({
    account: params.account,
    configId,
    launch: {
      name,
      symbol,
      metadataURI,
      creatorMetadataURI: "",
      tokenDecimals: cfg.config.tokenDecimals,
    },
    expectedPoolCreationFeeNativeRaw: cfg.config.poolCreationFee,
    gas: gasOpts,
  });

  launchCache.clear();
  const gasWithMargin = (plan.estimatedGasUnits * 125n) / 100n;

  return {
    status: plan.status,
    configId: plan.configId.toString(),
    predictedToken: plan.predictedToken,
    predictedCurve: plan.predictedCurve,
    poolCreationFeeEth: formatEther(plan.poolCreationFeeNativeRaw),
    transaction: serializeTx(plan.transaction, gasWithMargin),
  };
}

export async function prepareMigrateCurve(curveAddr: Address) {
  if (!isAddress(curveAddr)) {
    throw new Error(`Invalid curve address: ${curveAddr}`);
  }
  const headBlock = await getConfirmedBlockNumber();
  const curveClient = new AmmoraV4LaunchCurveClient(
    publicClientL2,
    curveAddr,
    { launchFactory: LAUNCH_FACTORY, feePolicy: FEE_POLICY }
  );
  const plan = await curveClient.planMigrateAtBlock(headBlock);
  launchCache.clear();
  return {
    asOfBlock: plan.asOfBlock.toString(),
    transaction: serializeTx(plan.transaction),
  };
}

export function prepareWrapTx(action: "wrap" | "unwrap", amountEth: string) {
  const amountRaw = parseEther(amountEth.trim());
  if (amountRaw <= 0n) {
    throw new Error("Wrap/unwrap amount must be greater than 0.");
  }
  const tx =
    action === "unwrap"
      ? buildAmmoraPortableUnwrapTransaction(
          giwaSepoliaAtomicLaunchDeployment.nativeAsset,
          amountRaw
        )
      : buildAmmoraPortableWrapTransaction(
          giwaSepoliaAtomicLaunchDeployment.nativeAsset,
          amountRaw
        );
  return {
    action,
    amountEth: amountEth.trim(),
    transaction: serializeTx(tx),
  };
}
