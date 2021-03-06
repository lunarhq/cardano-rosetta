/* eslint-disable no-magic-numbers */
/* eslint-disable camelcase */
/* eslint-disable new-cap */
/* eslint-disable no-console */
import delay from 'delay';
import * as NaCl from 'tweetnacl';
import axios from 'axios';

const logger = console;

const httpClient = axios.create({
  baseURL: "http://localhost:8080",
});

const PRIVATE_KEY =
  "41d9523b87b9bd89a4d07c9b957ae68a7472d8145d7956a692df1a8ad91957a2c117d9dd874447f47306f50a650f1e08bf4bec2cfcb2af91660f23f2db912977";
const SEND_FUNDS_ADDRESS =
  "addr1qqr585tvlc7ylnqvz8pyqwauzrdu0mxag3m7q56grgmgu7sxu2hyfhlkwuxupa9d5085eunq2qywy7hvmvej456flknsug829n";

// FIXME: look for this using the service
const network_identifier = {
  blockchain: "cardano",
  network: "testnet",
};

const generateKeys = (secretKey?: string) =>
  secretKey
    ? NaCl.sign.keyPair.fromSecretKey(Buffer.from(secretKey, "hex"))
    : NaCl.sign.keyPair();

const constructionDerive = async (publicKey: string): Promise<string> => {
  logger.info(
    `[constructionDerive] Fetching an address for pub key ${publicKey}`
  );
  const response = await httpClient.post("/construction/derive", {
    network_identifier,
    public_key: {
      hex_bytes: publicKey,
      curve_type: "edwards25519",
    },
    metadata: {},
  });
  const address = response.data.address;
  logger.debug(`[constructionDerive] Retrieved address ${address}`);
  return address;
};

const waitForBalanceToBe = async (
  address: string,
  cond: (param: any) => boolean
) => {
  let fetchAccountBalance;
  do {
    const response = await httpClient.post("/account/balance", {
      network_identifier,
      account_identifier: {
        address,
      },
    });
    if (cond(response.data)) {
      const [balance] = response.data.balances;
      logger.info(
        `[waitForBalanceToBe] Funds found! ${balance.value} ${balance.currency.symbol}`
      );
      fetchAccountBalance = response.data;
    } else {
      logger.debug(
        "[waitForBalanceToBe] Condition not met, waiting for a few seconds."
      );
      await delay(30 * 1000);
    }
  } while (!fetchAccountBalance);
  return fetchAccountBalance;
};

const constructionPreprocess = async (
  operations: any,
  relative_ttl: number
) => {
  const response = await httpClient.post("/construction/preprocess", {
    network_identifier,
    operations,
    metadata: { relative_ttl },
  });
  return response.data.options;
};

const constructionMetadata = async (options: any) => {
  const response = await httpClient.post("/construction/metadata", {
    network_identifier,
    options,
  });
  return response.data.metadata;
};

const buildOperation = (
  unspents: any,
  address: string,
  destination: string
) => {
  const inputs = unspents.coins.map((coin: any, index: number) => {
    const operation = {
      operation_identifier: {
        index,
        network_index: 0,
      },
      related_operations: [],
      type: "input",
      status: "success",
      account: {
        address,
        metadata: {},
      },
      amount: coin.amount,
      coin_change: {
        coin_identifier: coin.coin_identifier,
        coin_action: "coin_created",
      },
    };
    operation.amount.value = `-${operation.amount.value}`;
    return operation;
  });
  // TODO: No proper fees estimation is being done (it should be transaction size based)
  const totalBalance = BigInt(unspents.balances[0].value);
  const outputAmount = (totalBalance * BigInt(95)) / BigInt(100);
  const outputs = [
    {
      operation_identifier: {
        index: inputs.length,
        network_index: 0,
      },
      related_operations: [],
      type: "output",
      status: "success",
      account: {
        address: destination,
        metadata: {},
      },
      amount: {
        value: outputAmount.toString(),
        currency: {
          symbol: "ADA",
          decimals: 6,
        },
        metadata: {},
      },
    },
  ];
  return {
    network_identifier,
    operations: inputs.concat(outputs),
  };
};

const constructionPayloads = async (payload: any) => {
  const response = await httpClient.post("/construction/payloads", payload);
  return response.data;
};

const signPayloads = (payloads: any, keys: NaCl.SignKeyPair) =>
  payloads.map((signing_payload: any) => ({
    signing_payload,
    public_key: {
      hex_bytes: Buffer.from(keys.publicKey).toString("hex"),
      curve_type: "edwards25519",
    },
    signature_type: "ed25519",
    hex_bytes: Buffer.from(
      NaCl.sign.detached(
        Buffer.from(signing_payload.hex_bytes, "hex"),
        keys.secretKey
      )
    ).toString("hex"),
  }));

const constructionCombine = async (
  unsigned_transaction: any,
  signatures: any
) => {
  const response = await httpClient.post("/construction/combine", {
    network_identifier,
    unsigned_transaction,
    signatures,
  });
  return response.data;
};

const constructionSubmit = async (signed_transaction: any) => {
  const response = await httpClient.post("/construction/submit", {
    network_identifier,
    signed_transaction,
  });
  return response.data;
};

const doRun = async (): Promise<void> => {
  const keys = generateKeys(PRIVATE_KEY);
  logger.info(
    `[doRun] secretKey ${Buffer.from(keys.secretKey).toString("hex")}`
  );
  const address = await constructionDerive(
    Buffer.from(keys.publicKey).toString("hex")
  );
  const unspents = await waitForBalanceToBe(
    address,
    (response) => response.coins.length !== 0
  );
  const builtOperations = buildOperation(unspents, address, SEND_FUNDS_ADDRESS);
  const preprocess = await constructionPreprocess(builtOperations.operations, 1000);
  const metadata = await constructionMetadata(preprocess);
  const payloads = await constructionPayloads({
    network_identifier,
    operations: builtOperations.operations,
    metadata,
  });
  const signatures = signPayloads(payloads.payloads, keys);
  const combined = await constructionCombine(
    payloads.unsigned_transaction,
    signatures
  );
  logger.info(`[doRun] signed transaction is ${combined.signed_transaction}`);
  const hashResponse = await constructionSubmit(combined.signed_transaction);
  logger.info(
    `[doRun] transaction with hash ${hashResponse.transaction_identifier.hash} sent`
  );
  await waitForBalanceToBe(address, (response) => response.coins.length === 0);
};

doRun()
  .then(() => logger.info("Send Transaction finished"))
  .catch(console.error);
