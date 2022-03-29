import { BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";
export function buildFillRelayProps(
  depositInfo: { unfilledAmount: BigNumber; deposit: Deposit },
  repaymentChain: number
) {
  // Validate all keys are present.
  for (const key in depositInfo.deposit)
    if (depositInfo.deposit[key] == undefined) throw new Error(`Missing or undefined value in props! ${key}`);

  return [
    depositInfo.deposit.depositor,
    depositInfo.deposit.recipient,
    depositInfo.deposit.destinationToken,
    depositInfo.deposit.amount, // maxTokensToSend. TODO: update this to be a prop that the caller defines.
    depositInfo.unfilledAmount,
    repaymentChain,
    depositInfo.deposit.originChainId,
    depositInfo.deposit.realizedLpFeePct,
    depositInfo.deposit.relayerFeePct,
    depositInfo.deposit.depositId,
  ];
}