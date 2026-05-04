// backend/monitor.js
// Ciclo de monitoramento — Jupiter Price API em batches de 100
// ✅ Lê carteira on-chain a cada ciclo:
//    - Adiciona tokens novos (comprados no dashboard ou Phantom)
//    - Remove tokens que saíram da carteira (vendidos manualmente)

const fetch = require('node-fetch');

let connection, config, onTargetHit;
let getWalletTokensFn = null; // injetado pelo index.js — wallet.getMyTokens
let saveTokenFn      = null; // injetado pelo index.js — db.saveToken
let markSoldFn       = null; // injetado pelo index.js — db.markTokenSold

let tokens = {}; // { mint: { mint, mc, price, supply, targetHit: {} } }
let targets = [];
let targetCount = 1;
let afterLast = 'hold';
let stopLossMc = 0;
let intervalHandle = null;
let nextCycleAt = null;
let stats = { cycles: 0, sells: 0, errors: 0, lastCycle: null };

// ✅ URL atualizada — a antiga (price.jup.ag/v6/price) foi descontinuada
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const BATCH_SIZE = 100;

// =====================================================
// Init
// =====================================================
function init(conn, cfg, targetHitCallback, getMyTokens, saveToken, markTokenSold) {
  connection    = conn;
  config        = cfg;
  onTargetHit   = targetHitCallback;
  getWalletTokensFn = getMyTokens;
  saveTokenFn       = saveToken;
  markSoldFn        = markTokenSold;
}

function start() {
  if (intervalHandle) clearInterval(intervalHandle);
  runCycle(); // Roda imediatamente ao iniciar
  intervalHandle = setInterval(runCycle, config.monitorInterval || 120000);
  nextCycleAt = Date.now() + (config.monitorInterval || 120000);
  console.log(`[Monitor] Iniciado — intervalo: ${(config.monitorInterval||120000)/1000}s`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

// =====================================================
// Sincroniza carteira on-chain
// ✅ Adiciona tokens novos
// ✅ Remove tokens que saíram da carteira (venda manual)
// =====================================================
async function syncWalletTokens() {
  if (!getWalletTokensFn) return;
  try {
    const walletTokens = await getWalletTokensFn();

    // Monta set com os mints que estão na carteira agora
    const walletMints = new Set(walletTokens.map(t => t.mint));

    // --- Adiciona tokens novos ---
    let novos = 0;
    for (const t of walletTokens) {
      if (!tokens[t.mint]) {
        tokens[t.mint] = {
          mint: t.mint,
          mc: 0,
          price: 0,
          supply: 1_000_000_000,
          targetHit: {},
          addedAt: new Date().toISOString(),
          source: 'wallet'
        };
        novos++;
        // Persiste no Supabase para sobreviver a restarts
        if (saveTokenFn) {
          await saveTokenFn({
            mint: t.mint,
            bought_at: new Date().toISOString(),
            entry_sol: 0, // compra manual — valor desconhecido
            status: 'active'
          });
        }
      }
    }

    // --- Remove tokens que saíram da carteira ---
    let removidos = 0;
    for (const mint of Object.keys(tokens)) {
      if (!walletMints.has(mint)) {
        console.log(`[Monitor] 🔴 Token saiu da carteira (venda manual detectada): ${mint.slice(0,8)}...`);
        delete tokens[mint];
        removidos++;
        // Atualiza status no Supabase
        if (markSoldFn) {
          await markSoldFn(mint);
        }
      }
    }

    if (novos > 0) {
      console.log(`[Monitor] ✅ ${novos} token(s) novo(s) detectado(s) na carteira. Total monitorado: ${Object.keys(tokens).length}`);
    }
    if (removidos > 0) {
      console.log(`[Monitor] 🗑️  ${removidos} token(s) removido(s) do monitor. Total monitorado: ${Object.keys(tokens).length}`);
    }

  } catch(e) {
    console.error(`[Monitor] Erro ao sincronizar carteira: ${e.message}`);
  }
}

// =====================================================
// Main cycle
// =====================================================
async function runCycle() {
  // Primeiro sincroniza a carteira — adiciona novos e remove vendidos
  await syncWalletTokens();

  const mints = Object.keys(tokens);
  if (!mints.length) return;

  stats.cycles++;
  stats.lastCycle = new Date().toISOString();
  nextCycleAt = Date.now() + (config.monitorInterval || 120000);

  console.log(`[Monitor] Ciclo #${stats.cycles} — ${mints.length} tokens`);

  // Processa em batches de 100
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE);
    await processBatch(batch);
  }
}

async function processBatch(mints) {
  try {
    const url = `${JUPITER_PRICE_URL}?ids=${mints.join(',')}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    for (const [mint, priceData] of Object.entries(data.data || {})) {
      if (!tokens[mint]) continue;
      const token = tokens[mint];

      token.prevMc = token.mc;
      token.price  = priceData.price;
      token.mc     = priceData.price * (token.supply || 1_000_000_000);

      checkTargets(token);
      checkStopLoss(token);
    }
  } catch(e) {
    stats.errors++;
    console.error(`[Monitor] Erro no batch: ${e.message}`);
  }
}

// =====================================================
// Target checking
// =====================================================
function checkTargets(token) {
  for (let i = 0; i < targetCount; i++) {
    const t = targets[i];
    if (!t) continue;
    const key = `t${i+1}`;

    if (token.targetHit?.[key]) continue;

    if (token.mc >= t.mc) {
      console.log(`[Monitor] 🎯 ALVO ${i+1} — ${token.mint.slice(0,8)}... — MC: $${formatNum(token.mc)}`);

      if (!token.targetHit) token.targetHit = {};
      token.targetHit[key] = { mc: token.mc, time: new Date().toISOString() };
      stats.sells++;

      if (onTargetHit) onTargetHit(token, i, t);
    }
  }
}

function checkStopLoss(token) {
  if (!stopLossMc || stopLossMc <= 0) return;
  if (token.stopLossHit) return;
  if (token.mc <= stopLossMc && token.mc > 0) {
    console.log(`[Monitor] ⛔ STOP LOSS — ${token.mint.slice(0,8)}... — MC: $${formatNum(token.mc)}`);
    token.stopLossHit = true;
    if (onTargetHit) onTargetHit(token, -1, { pct: 100, slip: config.slippage });
  }
}

// =====================================================
// Token management
// =====================================================
function addToken(mint, supply = 1_000_000_000) {
  if (!tokens[mint]) {
    tokens[mint] = { mint, mc: 0, price: 0, supply, targetHit: {}, addedAt: new Date().toISOString() };
    console.log(`[Monitor] Token adicionado: ${mint.slice(0,8)}...`);
  }
}

function addTokensBatch(mintList) {
  for (const mint of mintList) addToken(mint);
  console.log(`[Monitor] ${mintList.length} tokens adicionados. Total: ${Object.keys(tokens).length}`);
}

function removeToken(mint) {
  delete tokens[mint];
}

function setTargets(newTargets, count, after, stopLoss) {
  targets    = newTargets || [];
  targetCount = count || 1;
  afterLast  = after || 'hold';
  stopLossMc = stopLoss || 0;
  console.log(`[Monitor] Alvos atualizados — ${targetCount} alvos configurados`);
}

function getAllTokens() {
  return Object.values(tokens);
}

function getTokenCount() {
  return Object.keys(tokens).length;
}

function getNextCycle() {
  if (!nextCycleAt) return null;
  return Math.max(0, Math.floor((nextCycleAt - Date.now()) / 1000));
}

function getStats() {
  return {
    ...stats,
    tokenCount: Object.keys(tokens).length,
    nextCycleIn: getNextCycle()
  };
}

function formatNum(n) {
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

module.exports = { init, start, stop, addToken, addTokensBatch, removeToken, setTargets, getAllTokens, getTokenCount, getNextCycle, getStats };
