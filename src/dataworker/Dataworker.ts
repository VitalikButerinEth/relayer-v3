import { winston, assign, buildSlowRelayTree, MerkleTree } from "../utils";
import { SpokePoolClient, HubPoolClient, MultiCallBundler } from "../clients";
import { UnfilledDeposits, FillsToRefund, RelayData, UnfilledDeposit } from "../interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "../interfaces/HubPool";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly multiCallBundler: MultiCallBundler | any
  ) {}

  // Common data re-formatting logic shared across all data worker public functions.
  _loadData(): { unfilledDeposits: UnfilledDeposits; fillsToRefund: FillsToRefund } {
    // For each origin chain spoke pool client:
    //     For all destination spoke pool client's:
    //         Store deposits that are sent from origin chain to destination chain as an UnfilledDeposit
    //             Associate this UnfilledDeposit with the destination chain and set fillAmountRemaining
    //         Grab all fills on destination client
    //             Attempt to map fill to an UnfilledDeposit sent from the origin chain
    //             If a match is found, save fill and key by repaymentChainId => refundAddress

    const unfilledDeposits: UnfilledDeposits = {};
    const fillsToRefund: FillsToRefund = {};

    const allChainIds = Object.keys(this.spokePoolClients);
    this.logger.debug({ at: "Dataworker", message: `Loading deposit and fill data`, chainIds: allChainIds });
    for (const originChainId of allChainIds) {
      const originClient = this.spokePoolClients[originChainId];
      if (!originClient.isUpdated()) throw new Error(`origin spokepoolclient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      this.logger.debug({ at: "Dataworker", message: `Looking up data for origin spoke pool`, originChainId });
      for (const destinationChainId of Object.keys(this.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated())
          throw new Error(`destination spokepoolclient with chain ID ${destinationChainId} not updated`);

        // Store deposits whose destination chain is the selected chain as unfilled deposits and set the initial fill
        // amount remaining equal to the full deposit amount minus any valid fill amounts.
        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChainId);
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${depositsForDestinationChain.length} deposits for destination chain ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

        const unfilledDepositsForDestinationChain = depositsForDestinationChain
          .map((deposit) => {
            return { deposit, unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit) };
          })
          .filter((deposit) => deposit.unfilledAmount.gt(0));

        if (unfilledDepositsForDestinationChain.length > 0)
          assign(unfilledDeposits, [destinationChainId], unfilledDepositsForDestinationChain);
        else
          this.logger.debug({
            at: "Dataworker",
            message: `All deposits are filled`,
            originChainId,
            destinationChainId,
          });

        // Grab all valid fills submitted to the destination spoke pool.
        const fillsOnDestinationChain = destinationClient.getFills();
        const validFillsOnDestinationChain = fillsOnDestinationChain.filter((fill) => {
          // For each fill, see if we can find a deposit sent from the origin client that matches it.
          for (const deposit of depositsForDestinationChain) {
            // Note1: It doesn't matter which client we call validateFillForDeposit() on as the logic is
            // chain agnostic.
            // Note2: All of the deposits returned by `getDepositsForDestinationChain` will include the expected realized
            // lp fee % for the deposit quote time. If this fill does not have the same realized lp fee %, then it will
            // be ignored.
            // Note3: FillRelay events emitted by slow relay executions will usually be invalid because the relayer
            // fee % will be reset to 0 by the SpokePool contract, however we still need to explicitly filter slow
            // relays out of the relayer refund array because its possible that a deposit is submitted with a relayer
            // fee % set to 0.
            if (fill.isSlowRelay) continue;
            else if (destinationClient.validateFillForDeposit(fill, deposit)) return true;
            else continue;
          }

          return false; // No deposit matched, this fill is invalid.
        });

        this.logger.debug({
          at: "Dataworker",
          message: `Found ${validFillsOnDestinationChain.length} fills on destination ${destinationChainId} matching origin ${originChainId}`,
          originChainId,
          destinationChainId,
        });
        validFillsOnDestinationChain.forEach((fill) =>
          assign(fillsToRefund, [fill.repaymentChainId, fill.relayer], [fill])
        );
      }
    }

    return {
      fillsToRefund,
      unfilledDeposits,
    };
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): Promise<MerkleTree<RelayData>> | null {
    const { unfilledDeposits } = this._loadData();
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

    if (Object.keys(unfilledDeposits).length === 0) return null;
    const leaves: RelayData[] = Object.values(unfilledDeposits)
      .map((deposits: UnfilledDeposit[]) =>
        deposits.map(
          (deposit: UnfilledDeposit): RelayData => ({
            depositor: deposit.deposit.depositor,
            recipient: deposit.deposit.recipient,
            destinationToken: deposit.deposit.depositor,
            amount: deposit.deposit.amount,
            originChainId: deposit.deposit.originChainId,
            destinationChainId: deposit.deposit.destinationChainId,
            realizedLpFeePct: deposit.deposit.realizedLpFeePct,
            relayerFeePct: deposit.deposit.relayerFeePct,
            depositId: deposit.deposit.depositId,
          })
        )
      )
      .flat();

    // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
    // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
    const sortedLeaves = leaves.sort((relayA, relayB) => {
      // Note: Smaller ID numbers will come first
      if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
      else return relayA.originChainId - relayB.originChainId;
    });

    return sortedLeaves.length > 0 ? await buildSlowRelayTree(sortedLeaves) : null;

    // TODO: Figure out how to store merkle trees. IPFS?
  }

  async buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // For each repayment chain ID key in fillsToRefund
    //     Group by refundAddress, and for each refund address
    //         Order fills by fillAmount
    //     Make Leaf for repayment chain ID
    // Construct root
  }

  async buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // For each destination chain ID key in unfilledDeposits
    //     Group by L1 token and for each L1 token:
    //         Add unfilledAmount to netSendAmount for L1 token
    //         Add realized LP fee to bundleLpFee for L1 token
    //         Figure out how RunningBalances works
    // For each repayment chain ID key in fillsToRefund
    //     Group by L1 token and for each L1 token:
    //         Add fillAmount to netSendAmount for L1 token
    //         Add realized LP fee to bundleLpFee for L1 token
    //         Figure out how RunningBalances works
    // Join repayment chain ID and destination chain ID data together
    // Make Leaf for destination chain ID. Optionally decide to split Leaf
    // data into smaller pieces and form sub groups with unique groupIndex's
    // Construct root
  }

  async proposeRootBundle(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    // Create roots
    // Store root + auxillary information useful for executing leaves on some storage layer
    // Propose roots to HubPool contract.
  }

  async validateRootBundle(
    bundleBlockNumbers: BundleEvaluationBlockNumbers,
    poolRebalanceRoot: string,
    relayerRefundRoot: string,
    slowRelayRoot: string
  ) {
    this._loadData();

    // Construct roots locally using class functions and compare with input roots.
    // If any roots mismatch, efficiently pinpoint the errors to give details to the caller.
  }

  async executeSlowRelayLeaves() {
    // TODO:
  }

  async executePoolRebalanceLeaves() {
    // TODO:
  }

  async executeRelayerRefundLeaves() {
    // TODO:
  }
}