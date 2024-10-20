import { Connection, Keypair, clusterApiUrl, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

// import bs58 from "bs58";
import {
  ParclV3Sdk,
  getMarginAccountPda,
  getMarketPda,
  translateAddress,
  parseCollateralAmount,
  parsePrice,
  parseSize,
  getExchangePda,
} from "../src";

import Decimal from "decimal.js";
import * as dotenv from "dotenv";
dotenv.config();

const fs = require('fs');

(async function main() {
  // Load the keypair from the file
  // Replace your wallet path here
  const secretKey = JSON.parse(fs.readFileSync('/home/anuj/my-solana-wallet-mainnet.json', 'utf8'));
  const signer = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const rpcUrl = clusterApiUrl("mainnet-beta");
  const sdk = new ParclV3Sdk({ rpcUrl });

  // only live exchange is exchangeId=0
  const [exchangeAddress] = getExchangePda(0);
  const exchange = await sdk.accountFetcher.getExchange(exchangeAddress);
  if (exchange === undefined) {
    throw new Error("Failed to fetch exchange");
  }
  const marginAccountId = 2;

  const [marginAccount] = getMarginAccountPda(exchangeAddress, signer.publicKey, marginAccountId);
  
  const signerTokenAccount = getAssociatedTokenAddressSync(
    translateAddress(exchange.collateralMint),
    signer.publicKey
  );

  const connection = new Connection(rpcUrl);

  // Check if the associated token account exists
  const tokenAccountInfo = await connection.getAccountInfo(signerTokenAccount);
  console.log("tokenAccountInfo ======> ", tokenAccountInfo?.data.valueOf.toString());
  console.log("exchange.collateralMint =====> ", exchange.collateralMint);

  if (!tokenAccountInfo) {
    console.log("Associated Token Account not initialized. Creating...");

    

    // Create the associated token account if it doesn't exist
    const createTokenAccountIx = createAssociatedTokenAccountInstruction(
      signer.publicKey, // Payer
      signerTokenAccount, // Associated token account to be created
      signer.publicKey, // Owner of the associated token account
      translateAddress(exchange.collateralMint) // Mint of the token
    );

    // const { blockhash } = await conn.getLatestBlockhash();

    const createTokenAccountTx = new Transaction()
                                  .add(createTokenAccountIx);
                                  // .feePayer(signer.publicKey);
                                  
    
  //   // Sign and send the transaction to create the associated token account
    const signature = await sendAndConfirmTransaction(connection, createTokenAccountTx, [signer]);
    console.log("Token account created with transaction: ", signature);
  }




  // deposit $5.1 of margin collateral
  // NOTE: flip collateral expo sign
  const margin = parseCollateralAmount(5.1, -exchange.collateralExpo);

  // trading market with id 4
  const marketIdToTrade = 4;
  const marketIds: number[] = [];
  // if you already have margin account:
  // const marketIds = (await sdk.accountFetcher.getMarginAccount(marginAccount))?.positions.map(position => position.marketId).filter(marketId => marketId > 0) as number[];
  // dont forget to add a new market id to the array if you're trading a new market
  if (!marketIds.includes(marketIdToTrade)) {
    marketIds.push(marketIdToTrade);
  }
  
  const marketAddresses = marketIds.map((marketId) => getMarketPda(exchangeAddress, marketId)[0]);
  console.log("marketAddresses : ", marketAddresses);
  const marketAccounts = (await sdk.accountFetcher.getMarkets(marketAddresses)).filter(
    (market) => market != undefined
  );

  if (marketAccounts.length !== marketAddresses.length) {
    throw new Error("Failed to fetch all provided markets");
  }
  const priceFeedAddresses = marketAccounts.map((market) => market!.account.priceFeed);

  
  const priceFeedAccounts = (await sdk.accountFetcher.getPythPriceFeeds(priceFeedAddresses)).filter(
    (market) => market != undefined
  );

  if (priceFeedAccounts.length !== priceFeedAddresses.length) {
    throw new Error("Failed to fetch all provided price feeds");
  }
  // trade 0.1 sqft long -- -0.1 sqft would be short or decreasing previous long position
  const sizeDelta = parseSize(0.1);
  // trading market with id 4, so using price feed at index 0 corresponding to mkt with id 4.
  // make sure you select the correct price feed for acceptable price calc
  const priceFeed = priceFeedAccounts[0]!;
  const isPythV2 = "priceMessage" in priceFeed;
  const indexPrice = isPythV2
    ? new Decimal(priceFeed.priceMessage.price.toString())
        .div(10 ** -priceFeed.priceMessage.exponent)
        .toNumber()
    : priceFeed.aggregate.price; // formatted already
  // Naively accepting up to 10% price impact for this long trade
  const acceptablePrice = parsePrice(1.1 * indexPrice);
  const markets = marketAddresses;
  const priceFeeds = priceFeedAddresses;
  // const connection = new Connection(rpcUrl);
  const { blockhash: latestBlockhash } = await connection.getLatestBlockhash();
  // build tx
  const tx = sdk
    .transactionBuilder()
    // create new margin account since we dont have one yet
    // remove this ix if you already have an account
    .createMarginAccount(
      { exchange: exchangeAddress, marginAccount, owner: signer.publicKey },
      { marginAccountId }
    )
    // deposit margin collateral into new margin account
    // remove this ix if you already have a funded account
    .depositMargin(
      {
        exchange: exchangeAddress,
        marginAccount,
        collateralVault: exchange.collateralVault,
        signer: signer.publicKey,
        signerTokenAccount,
      },
      { margin }
    )
    // trade (long)
    .modifyPosition(
      { exchange: exchangeAddress, marginAccount, signer: signer.publicKey },
      { sizeDelta, marketId: marketIdToTrade, acceptablePrice },
      markets,
      priceFeeds
    )
    .feePayer(signer.publicKey)
    .buildSigned([signer], latestBlockhash);
    
  const tokenBalance = await connection.getTokenAccountBalance(signerTokenAccount);
  console.log('signerTokenAccount :', signerTokenAccount.toString());

  console.log("tokenBalance : ", tokenBalance);

  const requiredAmount = margin.valueOf();
  console.log("requiredAmount  =====> ", requiredAmount);
  
  if (Number(tokenBalance.value.amount) < requiredAmount) {
    console.error('Insufficient funds in the token account.');
    return; // Exit if insufficient funds
  }
  
  console.log("================= start ================= ")  ;
  const simulationResult = await connection.simulateTransaction(tx);
  if (simulationResult.value.err) {
    console.error("Transaction simulation failed:", simulationResult.value.err);
    console.log("Logs:", simulationResult.value.logs);
    return; // Exit if simulation fails
  }
  console.log("================= end ================= ")  ;
  // send tx
  await sendAndConfirmTransaction(connection, tx, [signer]);
})();
