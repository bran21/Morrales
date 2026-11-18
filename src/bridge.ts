import {
  encodeFunctionData,
  formatEther,
  isAddress,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { giwaSepolia, sepolia } from "viem/chains";
import { getL2TransactionHashes } from "viem/op-stack";
import { publicClientL1, publicClientL2 } from "./config.js";

export const PORTAL_ADDRESS = giwaSepolia.contracts.portal[sepolia.id].address;
const MIN_L1_GAS_LIMIT = 120_000n;

const portalDepositAbi = parseAbi([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
]);

export function computeSafeL1GasLimit(estimatedL1Gas: bigint): bigint {
  const buffered = (estimatedL1Gas * 150n) / 100n;
  return buffered > MIN_L1_GAS_LIMIT ? buffered : MIN_L1_GAS_LIMIT;
}

export function validatePositiveEthAmount(amountEth: string): bigint {
  const trimmed = amountEth.trim();
  if (!trimmed) {
    throw new Error("Bridge amount is required.");
  }
  const parsed = parseEther(trimmed);
  if (parsed <= 0n) {
    throw new Error("Bridge amount must be greater than 0.");
  }
  return parsed;
}

export async function getBalances(address: Address) {
  if (!isAddress(address)) {
    throw new Error(`Invalid wallet address: ${address}`);
  }
  const [l1Wei, l2Wei] = await Promise.all([
    publicClientL1.getBalance({ address }),
    publicClientL2.getBalance({ address }),
  ]);
  return {
    address,
    l1Wei: l1Wei.toString(),
    l1Eth: formatEther(l1Wei),
    l2Wei: l2Wei.toString(),
    l2Eth: formatEther(l2Wei),
  };
}

export async function prepareDeposit(params: {
  from: Address;
  to?: Address;
  amountEth: string;
}) {
  if (!isAddress(params.from)) {
    throw new Error(`Invalid sender address: ${params.from}`);
  }
  const recipient = params.to ?? params.from;
  if (!isAddress(recipient)) {
    throw new Error(`Invalid recipient address: ${recipient}`);
  }

  const mintAmount = validatePositiveEthAmount(params.amountEth);
  const depositArgs = await publicClientL2.buildDepositTransaction({
    account: params.from,
    mint: mintAmount,
    to: recipient,
  });

  // Sepolia eth_estimateGas underestimates OptimismPortalProxy subcall gas (EIP-150),
  // so apply a 50% buffer with a 120k gas floor.
  const estimatedL1Gas = await publicClientL1.estimateDepositTransactionGas({
    account: depositArgs.account,
    request: depositArgs.request,
    targetChain: giwaSepolia,
  });
  const l1GasLimit = computeSafeL1GasLimit(estimatedL1Gas);
  const l2Gas = depositArgs.request.gas ?? 21_000n;

  const calldata = encodeFunctionData({
    abi: portalDepositAbi,
    functionName: "depositTransaction",
    args: [recipient, mintAmount, l2Gas, false, "0x"],
  });

  return {
    from: params.from,
    to: recipient,
    portalAddress: PORTAL_ADDRESS,
    mintAmount,
    estimatedL1Gas,
    l1GasLimit,
    l2Gas,
    calldata,
  };
}

export async function getBridgeStatus(l1Hash: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(l1Hash)) {
    throw new Error("Invalid L1 transaction hash.");
  }

  let l1Receipt;
  try {
    l1Receipt = await publicClientL1.getTransactionReceipt({ hash: l1Hash });
  } catch {
    return { status: "pending_l1" as const, l1Hash };
  }

  if (l1Receipt.status === "reverted") {
    return { status: "reverted_l1" as const, l1Hash };
  }

  const [l2Hash] = getL2TransactionHashes(l1Receipt);
  if (!l2Hash) {
    return { status: "l1_confirmed_no_l2_hash" as const, l1Hash };
  }

  try {
    const l2Receipt = await publicClientL2.getTransactionReceipt({ hash: l2Hash });
    if (l2Receipt.status === "reverted") {
      return { status: "reverted_l2" as const, l1Hash, l2Hash };
    }
    return {
      status: "confirmed" as const,
      l1Hash,
      l2Hash,
      l1Block: l1Receipt.blockNumber.toString(),
      l2Block: l2Receipt.blockNumber.toString(),
    };
  } catch {
    return {
      status: "pending_l2" as const,
      l1Hash,
      l2Hash,
      l1Block: l1Receipt.blockNumber.toString(),
    };
  }
}
