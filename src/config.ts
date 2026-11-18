import { giwaSepoliaAtomicLaunchDeployment } from "@ammora-protocol/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { giwaSepolia, sepolia } from "viem/chains";
import { publicActionsL1, publicActionsL2 } from "viem/op-stack";

export const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const GIWA_SEPOLIA_RPC_URL = giwaSepolia.rpcUrls.default.http[0];

export const WETH_ADDRESS = giwaSepoliaAtomicLaunchDeployment.quoteAsset.token;
export const LAUNCH_FACTORY = giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory;
export const CONFIG_REGISTRY = giwaSepoliaAtomicLaunchDeployment.contracts.configRegistry;
export const FEE_POLICY = giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy;

export const publicClientL1 = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC_URL, { retryCount: 3 }),
}).extend(publicActionsL1());

export const publicClientL2 = createPublicClient({
  chain: giwaSepolia,
  transport: http(GIWA_SEPOLIA_RPC_URL, { batch: true, retryCount: 3 }),
  batch: { multicall: true },
}).extend(publicActionsL2());

// OP Stack chain formatters include L1-origin `deposit` tx types in getBlock()
// that differ slightly from viem's unparameterized PublicClient type in @ammora-protocol/sdk.
export const ammoraPublicClient = publicClientL2 as unknown as PublicClient;
