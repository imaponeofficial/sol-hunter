// backend/buyer.js
// Compra via Jupiter Swap API

const fetch = require('node-fetch');
const { VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

let connection, keypair, config;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

function init(conn, kp, cfg) {
  connection = conn;
  keypair = kp;
  config = cfg;
}

async function buyToken({ mint, amountSol, slippage = 15, priority = 'medium' }) {
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // 1. Get quote
  const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${slippage * 100}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Quote falhou: ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote erro: ${quote.error}`);

  // 2. Get swap transaction
  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: getPriorityFee(priority),
      dynamicComputeUnitLimit: true
    })
  });
  if (!swapRes.ok) throw new Error(`Swap request falhou: ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Swap erro: ${swapData.error}`);

  // 3. Sign and send
  const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  // 4. Confirm
  await connection.confirmTransaction(txid, config.commitment || 'confirmed');

  console.log(`[Buyer] ✓ Comprado ${mint.slice(0,8)}... — ${amountSol} SOL — TX: ${txid}`);
  return { txid, mint, amountSol, status: 'confirmed' };
}

function getPriorityFee(priority) {
  const fees = { low: 1000, medium: 5000, high: 50000 };
  return fees[priority] || 5000;
}

module.exports = { init, buyToken };
