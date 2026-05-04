// backend/db.js
// Supabase — persistência de tokens e vendas

let supabase;

function init(client) {
  supabase = client;
  ensureTables();
}

async function ensureTables() {
  console.log('[DB] Supabase conectado');
}

// Salva token comprado
async function saveToken(token) {
  if (!supabase) return;
  const { error } = await supabase.from('sol_hunter_tokens').upsert({
    mint: token.mint,
    bought_at: token.bought_at,
    entry_sol: token.entry_sol,
    status: token.status || 'active'
  }, { onConflict: 'mint' });
  if (error) console.error('[DB] Erro ao salvar token:', error.message);
}

// ✅ Marca token como vendido manualmente (saiu da carteira)
async function markTokenSold(mint) {
  if (!supabase) return;
  const { error } = await supabase
    .from('sol_hunter_tokens')
    .update({ status: 'sold_manual' })
    .eq('mint', mint)
    .eq('status', 'active'); // só atualiza se ainda estava ativo
  if (error) console.error('[DB] Erro ao marcar token como vendido:', error.message);
}

// Registra venda
async function recordSale(sale) {
  if (!supabase) return;
  const { error } = await supabase.from('sol_hunter_sales').insert({
    mint: sale.mint,
    pct_sold: sale.pct,
    sol_received: sale.sol_received,
    txid: sale.txid,
    sold_at: sale.sold_at,
    trigger: sale.trigger || 'manual'
  });
  if (error) console.error('[DB] Erro ao registrar venda:', error.message);
}

// Busca todos os tokens ativos
async function getActiveTokens() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('sol_hunter_tokens')
    .select('*')
    .eq('status', 'active');
  if (error) { console.error('[DB] Erro:', error.message); return []; }
  return data || [];
}

// Busca histórico de vendas
async function getSales(limit = 100) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('sol_hunter_sales')
    .select('*')
    .order('sold_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[DB] Erro:', error.message); return []; }
  return data || [];
}

module.exports = { init, saveToken, markTokenSold, recordSale, getActiveTokens, getSales };
