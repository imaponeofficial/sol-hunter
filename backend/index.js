// backend/index.js
// SOL Hunter — Backend Principal
// Supabase: fixo via variáveis de ambiente (Railway)
// RPC + Chave Privada: enviados pelo dashboard via /api/config

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Connection, Keypair } = require('@solana/web3.js');
const { createClient } = require('@supabase/supabase-js');
const bs58 = require('bs58');

const monitor = require('./monitor');
const buyer   = require('./buyer');
const seller  = require('./seller');
const wallet  = require('./wallet');
const db      = require('./db');

const app = express();
// CORS — libera qualquer origem para GET, POST e OPTIONS
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Preflight explícito para todas as rotas
app.options('*', cors(corsOptions));
app.use(express.json());

// Serve dashboard estático (quando rodando local)
app.use(express.static(path.join(__dirname, '..')));

// =====================================================
// CONFIG
// Supabase vem SEMPRE do .env (Railway)
// RPC e PrivKey chegam do dashboard via POST /api/config
// =====================================================
const config = {
  rpc:             process.env.RPC_URL      || '',
  privateKey:      process.env.PRIVATE_KEY  || '',
  supabaseUrl:     process.env.SUPABASE_URL,
  supabaseKey:     process.env.SUPABASE_KEY,
  monitorInterval: parseInt(process.env.MONITOR_INTERVAL) || 120000,
  slippage:        parseInt(process.env.SLIPPAGE) || 15,
  commitment:      'confirmed',
};

// Supabase sobe junto com o servidor — independente do dashboard
let supabase;
if (config.supabaseUrl && config.supabaseKey) {
  supabase = createClient(config.supabaseUrl, config.supabaseKey);
  db.init(supabase);
  console.log('[SOL Hunter] Supabase conectado via variáveis de ambiente');
} else {
  console.warn('[SOL Hunter] ⚠️  SUPABASE_URL / SUPABASE_KEY não definidas no .env');
}

let connection, keypair;
let monitorRunning = false;

function initConnections() {
  if (!config.rpc || !config.privateKey) return false;
  try {
    connection = new Connection(config.rpc, config.commitment);
    const secretKey = bs58.decode(config.privateKey);
    keypair = Keypair.fromSecretKey(secretKey);

    wallet.init(connection, keypair);
    buyer.init(connection, keypair, config);
    seller.init(connection, keypair, config);
    monitor.init(connection, config, handleTargetHit);

    console.log('[SOL Hunter] Carteira: ' + keypair.publicKey.toBase58());
    return true;
  } catch (e) {
    console.error('[SOL Hunter] Erro ao inicializar:', e.message);
    return false;
  }
}

// =====================================================
// ROUTES — Config (dashboard envia só RPC + PrivKey)
// =====================================================
app.post('/api/config', (req, res) => {
  const { rpc, privateKey } = req.body;
  if (rpc)        config.rpc        = rpc;
  if (privateKey) config.privateKey = privateKey;

  const ok = initConnections();

  if (ok && !monitorRunning) {
    monitor.start();
    monitorRunning = true;
    console.log('[SOL Hunter] Monitor iniciado');
  }

  res.json({
    ok,
    message: ok ? 'Conectado com sucesso' : 'Erro ao conectar — verifique RPC e chave privada',
    publicKey: keypair ? keypair.publicKey.toBase58() : null,
    supabaseConnected: !!supabase,
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const bal = (keypair && connection)
      ? await connection.getBalance(keypair.publicKey)
      : 0;
    res.json({
      connected:         !!keypair,
      publicKey:         keypair ? keypair.publicKey.toBase58() : null,
      balance:           bal / 1e9,
      tokenCount:        monitor.getTokenCount(),
      nextCycle:         monitor.getNextCycle(),
      supabaseConnected: !!supabase,
    });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// =====================================================
// ROUTES — Carteira / Tokens
// =====================================================
app.get('/api/wallet-tokens', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  const { address, mcMin = 2000, mcMax = 3000, limit = 50 } = req.query;
  try {
    const tokens = await wallet.getWalletTokens(address, {
      mcMin: parseFloat(mcMin), mcMax: parseFloat(mcMax), limit: parseInt(limit),
    });
    res.json({ tokens, count: tokens.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-tokens', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  try { res.json({ tokens: await wallet.getMyTokens() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/balance', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  try {
    const bal = await connection.getBalance(keypair.publicKey);
    res.json({ sol: bal / 1e9 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// ROUTES — Compra
// =====================================================
app.post('/api/buy', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  const { mint, amountSol, slippage, priority } = req.body;
  try {
    const owns = await wallet.ownsToken(mint);
    if (owns) return res.json({ skipped: true, reason: 'Já possui este token' });

    const result = await buyer.buyToken({
      mint, amountSol: parseFloat(amountSol),
      slippage: parseInt(slippage) || config.slippage, priority: priority || 'medium',
    });
    await db.saveToken({ mint, bought_at: new Date().toISOString(), entry_sol: amountSol, status: 'active' });
    monitor.addToken(mint);
    res.json(result);
  } catch (e) {
    console.error('[BUY ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/buy-batch', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  const { mints, amountSol, slippage, priority, dryRun } = req.body;
  const results = [];
  for (const mint of mints) {
    try {
      if (await wallet.ownsToken(mint)) { results.push({ mint, skipped: true }); continue; }
      if (dryRun) {
        results.push({ mint, simulated: true });
      } else {
        const r = await buyer.buyToken({ mint, amountSol, slippage, priority });
        await db.saveToken({ mint, bought_at: new Date().toISOString(), entry_sol: amountSol, status: 'active' });
        monitor.addToken(mint);
        results.push({ mint, ...r });
      }
    } catch (e) { results.push({ mint, error: e.message }); }
  }
  res.json({ results });
});

// =====================================================
// ROUTES — Venda
// =====================================================
app.post('/api/sell', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  const { mint, pct, slippage } = req.body;
  try {
    const result = await seller.sellToken({
      mint, pct: parseInt(pct), slippage: parseInt(slippage) || config.slippage,
    });
    await db.recordSale({
      mint, pct, sol_received: result.solReceived,
      txid: result.txid, sold_at: new Date().toISOString(), trigger: 'auto_target',
    });
    res.json(result);
  } catch (e) {
    console.error('[SELL ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sell-batch', async (req, res) => {
  if (!keypair) return res.status(503).json({ error: 'Carteira não configurada' });
  const { count, criteria, mcMin, slippage } = req.body;
  try {
    let eligible = (await wallet.getMyTokens()).filter(t => t.mc >= (mcMin || 0));
    if (criteria === 'highest-mc') eligible.sort((a, b) => b.mc - a.mc);
    else if (criteria === 'lowest-mc') eligible.sort((a, b) => a.mc - b.mc);
    else eligible.sort(() => Math.random() - 0.5);

    const results = [];
    for (const t of eligible.slice(0, count)) {
      try {
        const r = await seller.sellToken({ mint: t.mint, pct: 100, slippage });
        results.push({ mint: t.mint, ...r });
      } catch (e) { results.push({ mint: t.mint, error: e.message }); }
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// ROUTES — Alvos / Monitor
// =====================================================
app.post('/api/targets', (req, res) => {
  const { targets, targetCount, afterLast, stopLoss } = req.body;
  monitor.setTargets(targets, targetCount, afterLast, stopLoss);
  res.json({ ok: true });
});

app.get('/api/monitor/tokens', (req, res) => {
  res.json({ tokens: monitor.getAllTokens() });
});

app.get('/api/monitor/stats', (req, res) => {
  res.json(monitor.getStats());
});

// Sincroniza tokens do localStorage para o Supabase + monitor
app.post('/api/tokens/sync', async (req, res) => {
  const { tokens } = req.body;
  if (!tokens || !tokens.length) return res.json({ ok: true, synced: 0 });
  let synced = 0;
  for (const t of tokens) {
    await db.saveToken({ mint: t.mint, bought_at: t.addedAt || new Date().toISOString(), entry_sol: 0, status: 'active' });
    monitor.addToken(t.mint);
    synced++;
  }
  res.json({ ok: true, synced });
});

// Carrega tokens ativos do Supabase para o dashboard
app.get('/api/tokens/load', async (req, res) => {
  try {
    const tokens = await db.getActiveTokens();
    for (const t of tokens) monitor.addToken(t.mint);
    res.json({ tokens });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Histórico de vendas do Supabase
app.get('/api/sales', async (req, res) => {
  try {
    const sales = await db.getSales(100);
    res.json({ sales });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================
// CALLBACK — Alvo atingido pelo monitor
// =====================================================
async function handleTargetHit(token, targetIndex, target) {
  console.log('[TARGET HIT] ' + token.mint + ' — Alvo ' + (targetIndex + 1) + ' — MC: $' + token.mc);
  try {
    const result = await seller.sellToken({
      mint: token.mint, pct: target.pct, slippage: target.slip || config.slippage,
    });
    await db.recordSale({
      mint: token.mint, pct: target.pct, sol_received: result.solReceived,
      txid: result.txid, sold_at: new Date().toISOString(),
      trigger: 'target_' + (targetIndex + 1),
    });
  } catch (e) {
    console.error('[TARGET SELL ERROR]', e.message);
  }
}

// =====================================================
// START
// =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🟢 SOL Hunter na porta ' + PORT);
  if (config.rpc && config.privateKey) {
    if (initConnections()) {
      monitor.start();
      monitorRunning = true;
      console.log('✅ Conexão e monitor iniciados via .env\n');
    }
  } else {
    console.log('⚠️  Configure RPC e chave privada via dashboard (aba Configurações)\n');
  }
});

module.exports = app;
