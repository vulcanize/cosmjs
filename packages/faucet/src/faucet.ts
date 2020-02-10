import { TokenConfiguration } from "@cosmwasm/bcp";
import {
  BlockchainConnection,
  isBlockInfoFailed,
  isBlockInfoPending,
  SendTransaction,
  TxCodec,
} from "@iov/bcp";
import { UserProfile } from "@iov/keycontrol";
import { sleep } from "@iov/utils";

import { debugAccount, logAccountsState, logSendJob } from "./debugging";
import {
  availableTokensFromHolder,
  identitiesOfFirstWallet,
  loadAccounts,
  loadTokenTickers,
} from "./multichainhelpers";
import { TokenManager } from "./tokenmanager";
import { SendJob } from "./types";

export class Faucet {
  /** will be private soon */
  public readonly tokenManager: TokenManager;

  private readonly connection: BlockchainConnection;
  private readonly codec: TxCodec;

  public constructor(config: TokenConfiguration, connection: BlockchainConnection, codec: TxCodec) {
    this.tokenManager = new TokenManager(config);
    this.connection = connection;
    this.codec = codec;
  }

  /**
   * Creates and posts a send transaction. Then waits until the transaction is in a block.
   */
  public async send(profile: UserProfile, job: SendJob): Promise<void> {
    const sendWithFee = await this.connection.withDefaultFee<SendTransaction>({
      kind: "bcp/send",
      chainId: this.connection.chainId(),
      sender: this.codec.identityToAddress(job.sender),
      senderPubkey: job.sender.pubkey,
      recipient: job.recipient,
      memo: "Make love, not war",
      amount: job.amount,
    });

    const nonce = await this.connection.getNonce({ pubkey: job.sender.pubkey });
    const signed = await profile.signTransaction(job.sender, sendWithFee, this.codec, nonce);

    const post = await this.connection.postTx(this.codec.bytesToPost(signed));
    const blockInfo = await post.blockInfo.waitFor(info => !isBlockInfoPending(info));
    if (isBlockInfoFailed(blockInfo)) {
      throw new Error(`Sending tokens failed. Code: ${blockInfo.code}, message: ${blockInfo.message}`);
    }
  }

  public async refill(profile: UserProfile): Promise<void> {
    console.info(`Connected to network: ${this.connection.chainId()}`);
    console.info(`Tokens on network: ${(await loadTokenTickers(this.connection)).join(", ")}`);

    const holderIdentity = identitiesOfFirstWallet(profile)[0];

    const accounts = await loadAccounts(profile, this.connection);
    logAccountsState(accounts);
    const holderAccount = accounts[0];
    const distributorAccounts = accounts.slice(1);

    const availableTokens = availableTokensFromHolder(holderAccount);
    console.info("Available tokens:", availableTokens);

    const jobs: SendJob[] = [];

    for (const token of availableTokens) {
      const refillDistibutors = distributorAccounts.filter(account =>
        this.tokenManager.needsRefill(account, token),
      );
      console.info(`Refilling ${token} of:`);
      console.info(
        refillDistibutors.length ? refillDistibutors.map(r => `  ${debugAccount(r)}`).join("\n") : "  none",
      );
      for (const refillDistibutor of refillDistibutors) {
        jobs.push({
          sender: holderIdentity,
          recipient: refillDistibutor.address,
          tokenTicker: token,
          amount: this.tokenManager.refillAmount(token),
        });
      }
    }
    if (jobs.length > 0) {
      for (const job of jobs) {
        logSendJob(job);
        await this.send(profile, job);
        await sleep(50);
      }

      console.info("Done refilling accounts.");
      logAccountsState(await loadAccounts(profile, this.connection));
    } else {
      console.info("Nothing to be done. Anyways, thanks for checking.");
    }
  }
}
