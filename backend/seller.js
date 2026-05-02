// backend/seller.js
// Venda via Jupiter Swap API

const fetch = require('node-fetch');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');

let connection, keypair, config;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

function init(conn, kp, cfg) {
  connection = conn;
  keypair = kp;
  config = cfg;
}

async function sellToken({ mint, pct = 100, slippage = 15 }) {
  // 1. Get token balance
  const balance = await getTokenBalance(mint);
  if (!balance || balance === 0) {
    throw new Error(`Saldo zero para ${mint}`);
  }

  const amountToSell = Math.floor(balance * (pct / 100));
  if (amountToSell === 0) throw new Error('Quantidade a vender é zero');

  // 2. Get quote (token → SOL)
  const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amountToSell}&slippageBps=${slippage * 100}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Quote venda falhou: ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote venda erro: ${quote.error}`);

  const solReceived = parseInt(quote.outAmount) / 1e9;

  // 3. Get swap transaction
  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 5000,
      dynamicComputeUnitLimit: true
    })
  });
  if (!swapRes.ok) throw new Error(`Swap venda falhou: ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Swap venda erro: ${swapData.error}`);

  // 4. Sign and send
  const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  await connection.confirmTransaction(txid, config.commitment || 'confirmed');

  console.log(`[Seller] ✓ Vendido ${pct}% de ${mint.slice(0,8)}... — ${solReceived.toFixed(6)} SOL — TX: ${txid}`);
  return { txid, mint, pct, solReceived, status: 'confirmed' };
}

async function getTokenBalance(mint) {
  try {
    const mintPubkey = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey);
    const info = await connection.getTokenAccountBalance(ata);
    return parseInt(info.value.amount);
  } catch(e) {
    console.error(`[Seller] Erro ao buscar saldo de ${mint}: ${e.message}`);
    return 0;
  }
}

module.exports = { init, sellToken };
