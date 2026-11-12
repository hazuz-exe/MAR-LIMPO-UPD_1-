'use strict';

require('dotenv').config();

const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const shared = require('./public/js/data/shared.js');

const { ACTIONS, UFS, ufInfo, computeAchievements, SIM_PURPOSES, SIM_LIMITS, simSplit } = shared;

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PLEDGES_FILE = path.join(DATA_DIR, 'pledges.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SIMS_FILE = path.join(DATA_DIR, 'simulations.json');
const MAX_PLEDGES_PER_DAY = 12; // por participante (sessão anônima)
const TZ = 'America/Sao_Paulo';

const robloxConfig = {
  clientId: process.env.ROBLOX_CLIENT_ID,
  clientSecret: process.env.ROBLOX_CLIENT_SECRET,
  redirectUri: process.env.ROBLOX_REDIRECT_URI,
};
const robloxEnabled = Object.values(robloxConfig).every(Boolean);
const sessionSecret = process.env.SESSION_SECRET || (PROD ? null : crypto.randomBytes(32).toString('hex'));

if (PROD && !sessionSecret) {
  console.error('Defina SESSION_SECRET no ambiente de produção.');
  process.exit(1);
}

app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);

app.use((req, res, next) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // Sem scripts/estilos inline: tudo vem de arquivos próprios (fontes também são locais).
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: https://*.rbxcdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  if (PROD) headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  res.set(headers);
  next();
});

app.use(express.json({ limit: '10kb', strict: true }));
app.use(cookieSession({
  name: 'ml_sess',
  keys: [sessionSecret || 'local-development-only-session-key'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: PROD,
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: PROD ? '1h' : 0 }));

// Limitador simples por IP e rota (memória). Em produção com várias instâncias, use um store compartilhado.
const requestHits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const recent = (requestHits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
    recent.push(now);
    requestHits.set(key, recent);
    next();
  };
}
setInterval(() => requestHits.clear(), 10 * 60 * 1000).unref();

function requireFetchHeader(req, res, next) {
  if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Requisição inválida.' });
  next();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

// Leitura em cache: só relê o arquivo quando a data de modificação muda.
function cachedList(file) {
  let cache = { mtime: -1, size: -1, data: [] };
  return async () => {
    let stat;
    try { stat = await fs.stat(file); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (stat.mtimeMs !== cache.mtime || stat.size !== cache.size) {
      const data = await readJson(file, []);
      cache = { mtime: stat.mtimeMs, size: stat.size, data: Array.isArray(data) ? data : [] };
    }
    return cache.data;
  };
}
const loadPledges = cachedList(PLEDGES_FILE);
const loadSimulations = cachedList(SIMS_FILE);

// Serializa gravações para evitar que dois envios simultâneos sobrescrevam um ao outro.
function makeQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
const withPledgeWrite = makeQueue();
const withSimulationWrite = makeQueue();

const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

// Apelido é público: remove marcas, limita tamanho e recusa o que parece contato pessoal/link.
function cleanAlias(value) {
  if (typeof value !== 'string') return 'Anônimo';
  const cleaned = value.trim().replace(/[<>\u0000-\u001F]/g, '').replace(/\s+/g, ' ').slice(0, 22);
  if (!cleaned || /@|https?:|www\.|\.(com|net|org|br)\b|\d{7,}/i.test(cleaned)) return 'Anônimo';
  return cleaned;
}

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'mar-limpo', version: shared.VERSION });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ robloxEnabled });
});

app.get('/api/impact', rateLimit(90, 60_000), async (_req, res) => {
  try {
    const pledges = await loadPledges();
    const byAction = Object.fromEntries(Object.keys(ACTIONS).map((key) => [key, 0]));
    const byRegion = Object.fromEntries(shared.REGIONS.map((r) => [r, 0]));
    const byUf = {};
    const perDay = new Map();
    for (const pledge of pledges) {
      if (Object.hasOwn(byAction, pledge.action)) byAction[pledge.action] += 1;
      const info = pledge.uf ? ufInfo(pledge.uf) : null;
      if (info) {
        byUf[info.id] = (byUf[info.id] || 0) + 1;
        byRegion[info.region] += 1;
      }
      const key = dayKey(pledge.createdAt);
      perDay.set(key, (perDay.get(key) || 0) + 1);
    }
    const byDay = [];
    for (let i = 13; i >= 0; i -= 1) {
      const key = dayKey(Date.now() - i * 86_400_000);
      byDay.push({ date: key, total: perDay.get(key) || 0 });
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      totalCommitments: pledges.length,
      participants: new Set(pledges.map((item) => item.participantId)).size,
      byAction,
      byRegion,
      byUf,
      byDay,
      updatedAt: pledges.length ? pledges[pledges.length - 1].createdAt : null,
      metricMeaning: 'Registros de compromissos enviados pelo formulário. Não representam quilos de lixo recolhidos nem doações.',
    });
  } catch (error) {
    console.error('Falha ao ler indicadores:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar os indicadores.' });
  }
});

app.get('/api/leaderboard', rateLimit(90, 60_000), async (_req, res) => {
  try {
    const pledges = await loadPledges();
    const groups = new Map();
    for (const item of pledges) {
      const group = groups.get(item.participantId) || { name: 'Anônimo', list: [] };
      if (item.alias && item.alias !== 'Anônimo') group.name = item.alias;
      group.list.push(item);
      groups.set(item.participantId, group);
    }
    const ranking = [...groups.values()]
      .map((g) => ({ name: g.name, total: g.list.length, badges: computeAchievements(g.list) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR'))
      .slice(0, 5);
    res.set('Cache-Control', 'no-store');
    res.json({ ranking, meaning: 'Ranking de participação digital (compromissos registrados), não de lixo removido nem de dinheiro arrecadado.' });
  } catch (error) {
    console.error('Falha ao montar ranking:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar o ranking.' });
  }
});

// Agenda: só o que a equipe publicou em data/events.json (campos reconhecidos e saneados).
const str = (v, max) => (typeof v === 'string' ? v.replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, max) : '');
function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, 90);
  if (!title) return null;
  return {
    title,
    date: str(raw.date, 40) || 'A confirmar',
    location: str(raw.location, 80),
    region: str(raw.region, 30),
    category: str(raw.category, 30) || 'Atividade',
    status: str(raw.status, 40) || 'A confirmar',
    description: str(raw.description, 300),
    kind: raw.kind === 'demonstracao' ? 'demonstracao' : 'confirmado',
  };
}
app.get('/api/events', rateLimit(60, 60_000), async (_req, res) => {
  try {
    const events = await readJson(EVENTS_FILE, []);
    res.set('Cache-Control', 'no-store');
    res.json({ events: (Array.isArray(events) ? events : []).map(sanitizeEvent).filter(Boolean) });
  } catch (error) {
    console.error('Falha ao ler agenda:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar a agenda.' });
  }
});

app.get('/api/actions', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ actions: ACTIONS });
});

app.post('/api/pledges', rateLimit(8, 60_000), requireFetchHeader, async (req, res) => {
  const { action, alias, uf } = req.body || {};
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) {
    return res.status(400).json({ error: 'Escolha uma ação válida.' });
  }
  let ufCode = null;
  if (uf !== undefined && uf !== null && uf !== '') {
    if (typeof uf !== 'string' || !Object.hasOwn(UFS, uf.toUpperCase())) return res.status(400).json({ error: 'Estado inválido.' });
    ufCode = uf.toUpperCase();
  }

  try {
    const outcome = await withPledgeWrite(async () => {
      const pledges = await loadPledges();
      const participantId = req.session.participantId || crypto.randomUUID();
      req.session.participantId = participantId;
      const today = dayKey(Date.now());
      const mine = pledges.filter((p) => p.participantId === participantId);
      const todays = mine.filter((p) => dayKey(p.createdAt) === today);
      if (todays.length >= MAX_PLEDGES_PER_DAY) return { error: 'Você atingiu o limite de registros de hoje. Volte amanhã!', status: 429 };
      if (todays.some((p) => p.action === action && (p.uf || null) === ufCode)) {
        return { error: 'Você já registrou esse compromisso hoje para essa escolha. Experimente outra ação ou região.', status: 409 };
      }
      const entry = {
        id: crypto.randomUUID(),
        participantId,
        alias: cleanAlias(alias),
        action,
        ...(ufCode ? { uf: ufCode } : {}),
        createdAt: new Date().toISOString(),
      };
      const next = [...pledges, entry];
      await writeJsonAtomic(PLEDGES_FILE, next);
      return { entry, mine: [...mine, entry] };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    const { entry, mine } = outcome;
    res.status(201).json({
      ok: true,
      pledge: { alias: entry.alias, action: ACTIONS[action].title, actionKey: action, uf: entry.uf || null, createdAt: entry.createdAt },
      achievements: computeAchievements(mine),
      totalMine: mine.length,
    });
  } catch (error) {
    console.error('Falha ao registrar compromisso:', error.message);
    res.status(500).json({ error: 'Não foi possível registrar agora. Tente novamente.' });
  }
});

// Histórico e conquistas da sessão atual (anônima).
app.get('/api/me/summary', rateLimit(60, 60_000), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const id = req.session.participantId;
    const mine = id ? (await loadPledges()).filter((p) => p.participantId === id) : [];
    res.json({
      pledges: mine.slice(-20).reverse().map((p) => ({ action: p.action, title: ACTIONS[p.action]?.title || p.action, uf: p.uf || null, createdAt: p.createdAt })),
      total: mine.length,
      achievements: computeAchievements(mine),
    });
  } catch (error) {
    console.error('Falha ao ler resumo:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar seu histórico.' });
  }
});

// ===== Simulação de contribuição: 100% demonstrativa, armazenada separadamente =====
// Nenhum dado pessoal, nenhum meio de pagamento, nenhuma cobrança.
app.post('/api/simulations', rateLimit(6, 60_000), requireFetchHeader, async (req, res) => {
  const { amount, purpose, preset } = req.body || {};
  const value = Number(amount);
  if (!Number.isInteger(value) || value < SIM_LIMITS.min || value > SIM_LIMITS.max) {
    return res.status(400).json({ error: `Informe um valor simbólico inteiro entre R$ ${SIM_LIMITS.min} e R$ ${SIM_LIMITS.max}.` });
  }
  if (typeof purpose !== 'string' || !Object.hasOwn(SIM_PURPOSES, purpose)) return res.status(400).json({ error: 'Escolha um destino demonstrativo.' });
  const chosenPreset = ['foco', 'principal', 'equilibrado'].includes(preset) ? preset : 'principal';
  try {
    const receipt = await withSimulationWrite(async () => {
      const list = await loadSimulations();
      const entry = {
        id: `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        amount: value,
        purpose,
        preset: chosenPreset,
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomic(SIMS_FILE, [...list, entry].slice(-5000));
      return entry;
    });
    res.status(201).json({
      ok: true,
      receipt: {
        ...receipt,
        purposeLabel: SIM_PURPOSES[purpose],
        split: simSplit(purpose, chosenPreset),
        status: 'SIMULAÇÃO CONCLUÍDA',
        notice: 'Esta é uma simulação educativa. Nenhum pagamento ou transferência foi realizado.',
      },
    });
  } catch (error) {
    console.error('Falha ao registrar simulação:', error.message);
    res.status(500).json({ error: 'Não foi possível concluir a simulação agora.' });
  }
});

app.get('/api/simulations/stats', rateLimit(60, 60_000), async (_req, res) => {
  try {
    const list = await loadSimulations();
    const byPurpose = Object.fromEntries(Object.keys(SIM_PURPOSES).map((k) => [k, 0]));
    let totalSymbolic = 0;
    for (const item of list) {
      if (Object.hasOwn(byPurpose, item.purpose)) byPurpose[item.purpose] += 1;
      totalSymbolic += Number(item.amount) || 0;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ simulations: list.length, totalSymbolic, byPurpose, label: 'DEMONSTRAÇÃO — valores simbólicos, nada foi arrecadado.' });
  } catch (error) {
    console.error('Falha ao ler simulações:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar as estatísticas da simulação.' });
  }
});

// ===== Login opcional do Roblox: OAuth 2.0 + PKCE =====
const RBX = {
  authorize: 'https://apis.roblox.com/oauth/v1/authorize',
  token: 'https://apis.roblox.com/oauth/v1/token',
  revoke: 'https://apis.roblox.com/oauth/v1/token/revoke',
  userinfo: 'https://apis.roblox.com/oauth/v1/userinfo',
};
const pendingOAuth = new Map();
const b64u = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
setInterval(() => {
  const now = Date.now();
  for (const [state, transaction] of pendingOAuth) {
    if (now - transaction.createdAt > 10 * 60 * 1000) pendingOAuth.delete(state);
  }
}, 60_000).unref();

app.get('/auth/roblox/login', rateLimit(10, 60_000), (req, res) => {
  if (!robloxEnabled) return res.redirect('/?roblox=unavailable');
  const state = b64u(crypto.randomBytes(24));
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  pendingOAuth.set(state, { verifier, createdAt: Date.now() });
  // v3: o state também fica preso ao navegador que iniciou o login (evita "login CSRF").
  req.session.oauthState = state;
  const url = new URL(RBX.authorize);
  url.search = new URLSearchParams({
    client_id: robloxConfig.clientId,
    redirect_uri: robloxConfig.redirectUri,
    scope: 'openid profile',
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account consent',
  }).toString();
  res.redirect(url.toString());
});

app.get('/auth/roblox/callback', rateLimit(20, 60_000), async (req, res) => {
  const redirect = (status) => res.redirect(`/?roblox=${status}#comunidade`);
  const { code, state, error } = req.query;
  const transaction = typeof state === 'string' ? pendingOAuth.get(state) : null;
  if (transaction) pendingOAuth.delete(state);
  const sessionState = req.session.oauthState;
  req.session.oauthState = null;
  if (error) return redirect(error === 'access_denied' ? 'cancelled' : 'error');
  if (!transaction || typeof code !== 'string' || typeof state !== 'string' || !sessionState
    || sessionState.length !== state.length
    || !crypto.timingSafeEqual(Buffer.from(sessionState), Buffer.from(state))) {
    return redirect('error');
  }

  try {
    const tokenResponse = await fetch(RBX.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: transaction.verifier,
        client_id: robloxConfig.clientId,
        client_secret: robloxConfig.clientSecret,
        redirect_uri: robloxConfig.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) throw new Error(`token ${tokenResponse.status}`);
    const tokens = await tokenResponse.json();
    const profileResponse = await fetch(RBX.userinfo, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) throw new Error(`userinfo ${profileResponse.status}`);
    const info = await profileResponse.json();

    // Revoga os tokens após consultar a identidade; a sessão guarda somente o ID público.
    fetch(RBX.revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokens.refresh_token || tokens.access_token,
        client_id: robloxConfig.clientId,
        client_secret: robloxConfig.clientSecret,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});

    if (!/^\d+$/.test(String(info.sub))) throw new Error('sub inválido');
    req.session.robloxId = String(info.sub);
    return redirect('ok');
  } catch (err) {
    console.error('Falha no login Roblox:', err.message);
    return redirect('error');
  }
});

async function getRobloxJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Roblox API ${response.status}`);
  return response.json();
}
const profileCache = new Map();
async function getRobloxProfile(id) {
  const cached = profileCache.get(id);
  if (cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) return cached.data;
  const [user, avatar] = await Promise.allSettled([
    getRobloxJson(`https://users.roblox.com/v1/users/${id}`),
    getRobloxJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`),
  ]);
  if (user.status !== 'fulfilled') throw new Error('Perfil indisponível');
  const u = user.value;
  // v3: devolve só o necessário para a interface (menos dados públicos de terceiros em trânsito).
  const data = {
    userId: String(u.id),
    username: u.name,
    displayName: u.displayName,
    avatar: avatar.status === 'fulfilled' ? avatar.value?.data?.[0]?.imageUrl || null : null,
    profileUrl: `https://www.roblox.com/users/${u.id}/profile`,
  };
  profileCache.set(id, { cachedAt: Date.now(), data });
  return data;
}

app.get('/api/me', rateLimit(60, 60_000), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!robloxEnabled || !req.session.robloxId) return res.json({ user: null });
  try {
    res.json({ user: await getRobloxProfile(req.session.robloxId) });
  } catch (error) {
    console.error('Falha ao consultar perfil Roblox:', error.message);
    res.status(502).json({ error: 'Não foi possível consultar o Roblox agora.' });
  }
});

app.post('/api/logout', requireFetchHeader, (req, res) => {
  req.session.robloxId = null;
  res.json({ ok: true });
});

// Rotas /api e /auth desconhecidas respondem JSON (e não a página inicial).
app.use(['/api', '/auth'], (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Erros de JSON malformado, corpo grande demais etc.
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: 'Corpo da requisição inválido.' });
  }
  console.error('Erro não tratado:', err?.message);
  res.status(500).json({ error: 'Erro interno.' });
});

async function start() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await Promise.all([PLEDGES_FILE, EVENTS_FILE, SIMS_FILE].map((file) => fs.access(file).catch(() => writeJsonAtomic(file, []))));
  app.listen(PORT, () => {
    console.log(`Mar Limpo v${shared.VERSION} rodando em http://localhost:${PORT}`);
    console.log(`Login Roblox: ${robloxEnabled ? 'habilitado' : 'desabilitado (opcional)'}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Não foi possível iniciar o Mar Limpo:', error);
    process.exit(1);
  });
}

module.exports = { app, start };
