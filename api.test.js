'use strict';
// Testes de API: node --test test/   (usa uma pasta de dados temporária)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-'));
const { app, start } = require('../server.js');

let server; let base;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
let cookie = '';
async function call(url, opts = {}) {
  const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(',').map((c) => c.split(';')[0]).join('; ');
  let body = null; try { body = await res.json(); } catch { /* html */ }
  return { res, body };
}

test.before(async () => {
  await fs.promises.mkdir(process.env.DATA_DIR, { recursive: true });
  for (const f of ['pledges', 'events', 'simulations']) fs.writeFileSync(path.join(process.env.DATA_DIR, `${f}.json`), '[]');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('health e config', async () => {
  const { body } = await call('/api/health'); assert.equal(body.version, '3.0.0');
  assert.equal((await call('/api/config')).body.robloxEnabled, false);
});
test('rota /api desconhecida devolve JSON 404', async () => {
  const { res, body } = await call('/api/nada'); assert.equal(res.status, 404); assert.ok(body.error);
});
test('POST sem cabeçalho X-Requested-With é recusado', async () => {
  const { res } = await call('/api/pledges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'descarte-correto' }) });
  assert.equal(res.status, 403);
});
test('valida ação e estado', async () => {
  assert.equal((await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'x' }) })).res.status, 400);
  assert.equal((await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'descarte-correto', uf: 'ZZ' }) })).res.status, 400);
});
test('registra compromisso, bloqueia duplicata do dia e calcula conquistas', async () => {
  const a = await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'recusar-descartavel', uf: 'RN', alias: 'Maré_01' }) });
  assert.equal(a.res.status, 201); assert.ok(a.body.achievements.includes('primeira-mare'));
  const dup = await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'recusar-descartavel', uf: 'RN' }) });
  assert.equal(dup.res.status, 409);
  const b = await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'aprender-descarte', uf: 'PE' }) });
  assert.ok(b.body.achievements.includes('explorador-oceanico'));
});
test('alias com e-mail/link vira Anônimo', async () => {
  const r = await call('/api/pledges', { method: 'POST', headers: H, body: JSON.stringify({ action: 'informacao-confiavel', alias: 'joao@mail.com' }) });
  assert.equal(r.body.pledge.alias, 'Anônimo');
});
test('impact, leaderboard e summary refletem os registros', async () => {
  const i = (await call('/api/impact')).body; assert.equal(i.totalCommitments, 3); assert.equal(i.byUf.RN, 1); assert.equal(i.byRegion.Nordeste, 2); assert.equal(i.byDay.length, 14);
  const l = (await call('/api/leaderboard')).body; assert.equal(l.ranking[0].total, 3);
  const s = (await call('/api/me/summary')).body; assert.equal(s.total, 3);
});
test('simulação: valida, gera recibo e fica separada dos compromissos', async () => {
  assert.equal((await call('/api/simulations', { method: 'POST', headers: H, body: JSON.stringify({ amount: 0, purpose: 'educacao' }) })).res.status, 400);
  assert.equal((await call('/api/simulations', { method: 'POST', headers: H, body: JSON.stringify({ amount: 10, purpose: 'x' }) })).res.status, 400);
  const ok = await call('/api/simulations', { method: 'POST', headers: H, body: JSON.stringify({ amount: 20, purpose: 'reciclagem', preset: 'principal' }) });
  assert.equal(ok.res.status, 201); assert.match(ok.body.receipt.id, /^SIM-[0-9A-F]{8}$/); assert.equal(ok.body.receipt.status, 'SIMULAÇÃO CONCLUÍDA'); assert.match(ok.body.receipt.notice, /Nenhum pagamento/);
  const stats = (await call('/api/simulations/stats')).body; assert.equal(stats.simulations, 1); assert.equal(stats.totalSymbolic, 20);
  assert.equal((await call('/api/impact')).body.totalCommitments, 3);
});
test('eventos: só campos saneados', async () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'events.json'), JSON.stringify([{ title: '<b>Oi</b>', evil: 1 }, { nope: true }]));
  const e = (await call('/api/events')).body.events; assert.equal(e.length, 1); assert.equal(e[0].title, 'bOi/b'); assert.equal(e[0].kind, 'confirmado'); assert.equal(e[0].evil, undefined);
});
test('JSON malformado devolve 400 em JSON', async () => {
  const r = await call('/api/pledges', { method: 'POST', headers: H, body: '{ruim' }); assert.equal(r.res.status, 400);
});
test('cabeçalhos de segurança', async () => {
  const { res } = await call('/api/health'); assert.match(res.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
test('Roblox desligado redireciona sem erro', async () => {
  const { res } = await call('/auth/roblox/login'); assert.equal(res.status, 302); assert.match(res.headers.get('location'), /roblox=unavailable/);
});
