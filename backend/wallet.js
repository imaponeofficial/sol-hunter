// backend/wallet.js
// Gerenciamento de carteira — busca tokens, verifica propriedade

const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fetch = require('node-fetch');

let connection, keypair;
let myTokensCache = {}; // mint -> true (para checagem rápida de propriedade)
let lastCacheUpdate = 0;
const CACHE_TTL = 30000; // 30s

function init(conn, kp) {
  connection = conn;
  keypair = kp;
}

// Busca todos os tokens de uma carteira específica (carteira fonte)
async function getWalletTokens(address, { mcMin = 2000, mcMax = 3000, limit = 50 } = {}) {
  try {
    const pubkey = new PublicKey(address);

    // Busca todas as token accounts desta carteira
    const accounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: TOKEN_PROGRAM_ID
    });

    const mints = accounts.value
      .filter(a => parseInt(a.account.data.parsed.info.tokenAmount.amount) > 0)
      .map(a => a.account.data.parsed.info.mint);

    if (!mints.length) return [];

    console.log(`[Wallet] ${address.slice(0,8)}... possui ${mints.length} tokens`);

    // Buscar market caps via Jupiter em batches de 100
    const withMC = [];
    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      try {
        // ✅ URL atualizada — a antiga (price.jup.ag/v6/price) foi descontinuada
        const url = `https://api.jup.ag/price/v2?ids=${batch.join(',')}`;
        const res = await fetch(url, { timeout: 8000 });
        const data = await res.json();

        for (const mint of batch) {
          const priceData = data.data?.[mint];
          if (!priceData) continue;
          const mc = priceData.price * 1_000_000_000; // supply estimado 1B

          if (mc >= mcMin && mc <= mcMax) {
            withMC.push({
              mint,
              price: priceData.price,
              mc,
              liquidity: priceData.liquidity || 0,
              alreadyOwned: await ownsToken(mint)
            });
          }
        }
      } catch(e) {
        console.error(`[Wallet] Erro ao buscar preços: ${e.message}`);
      }
    }

    console.log(`[Wallet] ${withMC.length} tokens dentro do range $${mcMin}–$${mcMax}`);
    return withMC.slice(0, limit);

  } catch(e) {
    throw new Error(`Erro ao buscar tokens da carteira: ${e.message}`);
  }
}

// Tokens da MINHA carteira
async function getMyTokens() {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, {
      programId: TOKEN_PROGRAM_ID
    });

    const tokens = accounts.value
      .filter(a => parseInt(a.account.data.parsed.info.tokenAmount.amount) > 0)
      .map(a => ({
        mint: a.account.data.parsed.info.mint,
        amount: a.account.data.parsed.info.tokenAmount.amount,
        decimals: a.account.data.parsed.info.tokenAmount.decimals,
        mc: 0
      }));

    // Atualiza cache
    myTokensCache = {};
    for (const t of tokens) myTokensCache[t.mint] = true;
    lastCacheUpdate = Date.now();

    return tokens;
  } catch(e) {
    throw new Error(`Erro ao buscar meus tokens: ${e.message}`);
  }
}

// Verificação rápida de propriedade (usa cache de 30s)
async function ownsToken(mint) {
  if (Date.now() - lastCacheUpdate > CACHE_TTL) {
    await refreshMyTokensCache();
  }
  return !!myTokensCache[mint];
}

async function refreshMyTokensCache() {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, {
      programId: TOKEN_PROGRAM_ID
    });
    myTokensCache = {};
    for (const a of accounts.value) {
      const amount = parseInt(a.account.data.parsed.info.tokenAmount.amount);
      if (amount > 0) {
        myTokensCache[a.account.data.parsed.info.mint] = true;
      }
    }
    lastCacheUpdate = Date.now();
  } catch(e) {
    console.error('[Wallet] Erro ao atualizar cache:', e.message);
  }
}

module.exports = { init, getWalletTokens, getMyTokens, ownsToken };
