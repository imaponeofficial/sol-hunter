// backend/monitor.js
// Ciclo de monitoramento — Jupiter Price API em batches de 100

const fetch = require('node-fetch');

let connection, config, onTargetHit;
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
function init(conn, cfg, targetHitCallback) {
  connection = conn;
  config = cfg;
  onTargetHit = targetHitCallback;
}

function start() {
  if (intervalHandle) clearInterval(intervalHandle);
  runCycle(); // Run immediately on start
  intervalHandle = setInterval(runCycle, config.monitorInterval || 120000);
  nextCycleAt = Date.now() + (config.monitorInterval || 120000);
  console.log(`[Monitor] Iniciado — intervalo: ${(config.monitorInterval||120000)/1000}s`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

// =====================================================
// Main cycle
// =====================================================
async function runCycle() {
  const mints = Object.keys(tokens);
  if (!mints.length) return;

  stats.cycles++;
  stats.lastCycle = new Date().toISOString();
  nextCycleAt = Date.now() + (config.monitorInterval || 120000);

  console.log(`[Monitor] Ciclo #${stats.cycles} — ${mints.length} tokens`);

  // Batch into groups of BATCH_SIZE
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

    // ✅ A API v2 retorna data.data[mint].price — mesma estrutura, compatível
    for (const [mint, priceData] of Object.entries(data.data || {})) {
      if (!tokens[mint]) continue;
      const token = tokens[mint];

      token.prevMc = token.mc;
      // ✅ API v2: o preço está em priceData.price (igual à v1)
      token.price = priceData.price;
      // Market cap = price * supply (supply estimado de 1B se não disponível)
      token.mc = priceData.price * (token.supply || 1_000_000_000);

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

    // Já disparou este alvo para este token?
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
  targets = newTargets || [];
  targetCount = count || 1;
  afterLast = after || 'hold';
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
