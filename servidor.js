#!/usr/bin/env node
/**
 * XR18 Studio — servidor local (sem dependências, só Node 18+).
 *  1) serve o app em http://localhost:8080
 *  2) ponte WebSocket (porta 8765) <-> UDP/OSC (porta 10024 da XR18)
 *  3) proxy seguro para o Google Gemini: as CHAVES DE API ficam só neste computador
 *     (arquivo ~/.xr18-studio/config.json) e nunca vão ao navegador, ao GitHub ou ao localStorage.
 *  4) cópia em arquivo do estado do app (~/.xr18-studio/estado.json)
 *   node servidor.js [--web 8080] [--ws 8765] [--port 10024] [--origem https://usuario.github.io]
 * O áudio (gravação/retorno USB) NÃO passa por aqui: o navegador usa o USB direto.
 */
const http = require('http'), dgram = require('dgram'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const WEB = +arg('web', 8080), WSP = +arg('ws', 8765), OSC_PORT = +arg('port', 10024);
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.scn': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const SERVE_OK = /^[\w.\-]+$/; // só arquivos na raiz, sem subpastas; .json/.md/.bat/.sh não são servidos

/* ---------- configuração e chaves (privadas) ---------- */
const DIR = process.env.XR18_HOME || path.join(os.homedir(), '.xr18-studio'), CFG = path.join(DIR, 'config.json'), STATE = path.join(DIR, 'estado.json');
const DEF = { model: 'gemini-2.5-flash-lite', fallbackModels: ['gemini-3.1-flash-lite', 'gemini-2.5-flash'], keys: [], origins: [], usage: {} };
let cfg = { ...DEF };
const loadCfg = () => { try { cfg = { ...DEF, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch (e) { cfg = { ...DEF }; } if (process.env.GEMINI_API_KEY && !cfg.keys.some(k => k.env)) cfg.keys.unshift({ id: 'env', label: 'Variável GEMINI_API_KEY', env: true, enabled: true }); };
const saveCfg = () => { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const c = { ...cfg, keys: cfg.keys.filter(k => !k.env) }; fs.writeFileSync(CFG, JSON.stringify(c, null, 1), { mode: 0o600 }); } catch (e) { console.error('Falha ao salvar config:', e.message); } };
loadCfg();
const extraOrigin = arg('origem', ''); if (extraOrigin && !cfg.origins.includes(extraOrigin)) { cfg.origins.push(extraOrigin); saveCfg(); }
const secret = k => (k.env ? process.env.GEMINI_API_KEY : k.secret);
const mask = k => { const s = secret(k) || ''; return s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-4) : '••••'; };

/* ---------- segurança de origem ---------- */
const isLoop = a => /^(::1|127\.|::ffff:127\.)/.test(a || '');
const privHost = h => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h);
const originOk = o => { if (!o || o === 'null') return true; try { const u = new URL(o); return privHost(u.hostname) || cfg.origins.includes(u.origin); } catch (e) { return false; } };

/* ---------- Gemini: rodízio de chaves, cotas e registro ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const logs = []; const log = (lvl, msg, extra) => { logs.push({ t: Date.now(), lvl, msg, ...extra }); if (logs.length > 300) logs.shift(); };
const U = id => { const d = today(); const u = (cfg.usage[id] = cfg.usage[id] || {}); if (u.day !== d) Object.assign(u, { day: d, req: 0, fail: 0, tin: 0, tout: 0 }); return u; };
const runtime = {}; // id -> { until, why }  (cooldown em memória)
const keyState = k => { const r = runtime[k.id] || {}, u = U(k.id);
  if (k.enabled === false) return 'desativada'; if (r.invalid) return 'inválida';
  if (k.dailyLimit && u.req >= k.dailyLimit) return 'limite diário (app)';
  if (r.until && r.until > Date.now()) return r.why === 'limit' ? 'limite do provedor' : 'indisponível'; return 'pronta'; };
const publicKeys = () => cfg.keys.map((k, i) => ({ id: k.id, label: k.label, mask: mask(k), order: i, enabled: k.enabled !== false, dailyLimit: k.dailyLimit || 0, state: keyState(k), cooldownS: Math.max(0, Math.round(((runtime[k.id] || {}).until - Date.now()) / 1000)) || 0, usage: U(k.id), lastError: (runtime[k.id] || {}).err || '' }));
const parseRetry = body => { const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body); return m ? Math.ceil(+m[1]) : 0; };
async function callGemini(k, model, { system, prompt, json }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 900, ...(json ? { responseMimeType: 'application/json' } : {}) } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 25000);
  try { const r = await fetch(`${process.env.XR18_GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': secret(k) }, body: JSON.stringify(body), signal: ctl.signal }); const txt = await r.text(); return { status: r.status, txt }; }
  finally { clearTimeout(to); }
}
async function ask(req) {
  const order = cfg.keys.filter(k => keyState(k) === 'pronta' && secret(k)); const models = [cfg.model, ...cfg.fallbackModels.filter(m => m !== cfg.model)];
  if (!cfg.keys.length) return { ok: false, code: 'no_keys', error: 'Nenhuma chave Gemini cadastrada.' };
  if (!order.length) return { ok: false, code: 'all_unavailable', error: 'Todas as chaves estão indisponíveis agora (limite, erro ou desativadas).', keys: publicKeys() };
  for (const k of order) {
    const u = U(k.id), r = (runtime[k.id] = runtime[k.id] || {});
    for (const model of models) {
      u.req++; let res; try { res = await callGemini(k, model, req); } catch (e) { u.fail++; r.until = Date.now() + 30000; r.why = 'down'; r.err = 'rede: ' + e.message; log('warn', `chave "${k.label}" sem rede/timeout`); break; }
      if (res.status === 200) { let j; try { j = JSON.parse(res.txt); } catch (e) { j = {}; } const text = (((j.candidates || [])[0] || {}).content || {}).parts ? j.candidates[0].content.parts.map(p => p.text || '').join('') : '';
        const um = j.usageMetadata || {}; u.tin += um.promptTokenCount || 0; u.tout += um.candidatesTokenCount || 0; r.err = ''; r.until = 0; log('info', `ok via "${k.label}" (${model})`, { tin: um.promptTokenCount, tout: um.candidatesTokenCount });
        saveCfg(); return { ok: true, text, model, keyLabel: k.label, usage: { tin: um.promptTokenCount || 0, tout: um.candidatesTokenCount || 0 } }; }
      u.fail++;
      if (res.status === 404) { log('warn', `modelo ${model} indisponível, tentando o próximo`); continue; }
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(res.txt))) { r.invalid = true; r.err = 'autenticação recusada (HTTP ' + res.status + ')'; log('error', `chave "${k.label}" recusada`); break; }
      if (res.status === 429) { const perDay = /PerDay/i.test(res.txt); r.until = Date.now() + (perDay ? 3 * 3600e3 : (parseRetry(res.txt) || 60) * 1000); r.why = 'limit'; r.err = 'limite de uso (429)' + (perDay ? ' diário' : ''); log('warn', `chave "${k.label}" atingiu o limite; usando a próxima`); break; }
      if (res.status >= 500) { r.until = Date.now() + 30000; r.why = 'down'; r.err = 'serviço indisponível (HTTP ' + res.status + ')'; log('warn', r.err); break; }
      r.err = 'HTTP ' + res.status; log('error', `erro ${res.status} em "${k.label}"`); return { ok: false, code: 'bad_request', error: 'Pedido recusado pelo provedor (HTTP ' + res.status + ').' };
    }
  }
  saveCfg(); return { ok: false, code: 'all_failed', error: 'Nenhuma chave conseguiu responder.', keys: publicKeys() };
}

/* ---------- API HTTP ---------- */
const readBody = (req, max = 2e6) => new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { rej(new Error('grande')); req.destroy(); } }); req.on('end', () => res(b)); });
const send = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(obj)); };
async function api(req, res, p) {
  const loop = isLoop(req.socket.remoteAddress), m = req.method;
  const J = async () => { try { return JSON.parse(await readBody(req) || '{}'); } catch (e) { return null; } };
  if (p === '/api/status' && m === 'GET') return send(res, 200, { ok: true, model: cfg.model, keys: publicKeys(), local: loop, version: 2 });
  if (p === '/api/log' && m === 'GET') return send(res, 200, { ok: true, log: logs.slice(-100) });
  if (p === '/api/ia' && m === 'POST') { const j = await J(); if (!j || typeof j.prompt !== 'string' || j.prompt.length > 60000) return send(res, 400, { ok: false, error: 'pedido inválido' }); return send(res, 200, await ask({ system: String(j.system || '').slice(0, 8000), prompt: j.prompt, json: !!j.json })); }
  if (p === '/api/estado') { if (m === 'GET') { try { return send(res, 200, JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (e) { return send(res, 404, { ok: false }); } }
    if (m === 'PUT') { if (!loop) return send(res, 403, { ok: false, error: 'somente neste computador' }); const j = await J(); if (!j) return send(res, 400, { ok: false }); fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(STATE, JSON.stringify(j)); return send(res, 200, { ok: true }); } }
  // administração das chaves: SOMENTE a partir deste computador
  if (/^\/api\/(keys|config)/.test(p)) {
    if (!loop) return send(res, 403, { ok: false, error: 'As chaves só podem ser gerenciadas no computador que executa o servidor.' });
    if (p === '/api/keys' && m === 'POST') { const j = await J(); const s = j && String(j.key || '').trim(); if (!s || !/^[\w\-]{20,120}$/.test(s)) return send(res, 400, { ok: false, error: 'Chave com formato inválido.' }); const id = crypto.randomBytes(4).toString('hex'); cfg.keys.push({ id, label: String(j.label || 'Chave ' + (cfg.keys.length + 1)).slice(0, 40), secret: s, enabled: true, dailyLimit: Math.max(0, +j.dailyLimit || 0) }); saveCfg(); log('info', 'chave adicionada'); return send(res, 200, { ok: true, keys: publicKeys() }); }
    let mm = /^\/api\/keys\/(\w+)$/.exec(p);
    if (mm && m === 'DELETE') { cfg.keys = cfg.keys.filter(k => k.id !== mm[1] || k.env); delete runtime[mm[1]]; saveCfg(); return send(res, 200, { ok: true, keys: publicKeys() }); }
    if (mm && m === 'PATCH') { const j = await J(), k = cfg.keys.find(k => k.id === mm[1]); if (!k || !j) return send(res, 404, { ok: false }); if ('enabled' in j) { k.enabled = !!j.enabled; if (j.enabled) delete runtime[k.id]; } if ('dailyLimit' in j) k.dailyLimit = Math.max(0, +j.dailyLimit || 0); if ('label' in j) k.label = String(j.label).slice(0, 40); if (j.key) { const s = String(j.key).trim(); if (!/^[\w\-]{20,120}$/.test(s)) return send(res, 400, { ok: false, error: 'Chave com formato inválido.' }); k.secret = s; delete runtime[k.id]; } saveCfg(); return send(res, 200, { ok: true, keys: publicKeys() }); }
    if (p === '/api/keys/order' && m === 'POST') { const j = await J(); if (!j || !Array.isArray(j.ids)) return send(res, 400, { ok: false }); const by = Object.fromEntries(cfg.keys.map(k => [k.id, k])); const nk = j.ids.map(i => by[i]).filter(Boolean); cfg.keys.filter(k => !j.ids.includes(k.id)).forEach(k => nk.push(k)); cfg.keys = nk; saveCfg(); return send(res, 200, { ok: true, keys: publicKeys() }); }
    if (p === '/api/config' && m === 'POST') { const j = await J(); if (j && /^[\w.\-]{3,60}$/.test(j.model || '')) cfg.model = j.model; saveCfg(); return send(res, 200, { ok: true, model: cfg.model }); }
  }
  send(res, 404, { ok: false, error: 'rota desconhecida' });
}

/* ---------- servidor estático + API ---------- */
http.createServer(async (req, res) => {
  const origin = req.headers.origin, okO = originOk(origin);
  if (origin && okO) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Private-Network', 'true'); }
  if (req.method === 'OPTIONS') { res.writeHead(okO ? 204 : 403); return res.end(); }
  let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.startsWith('/api/')) { if (!okO) return send(res, 403, { ok: false, error: 'origem não autorizada' }); try { return await api(req, res, p); } catch (e) { return send(res, 500, { ok: false, error: 'erro interno' }); } }
  if (p === '/') p = '/index.html'; const name = p.slice(1);
  if (!SERVE_OK.test(name) || !MIME[path.extname(name)]) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(ROOT, name), (e, d) => { if (e) { res.writeHead(404); return res.end('404'); } res.writeHead(200, { 'content-type': MIME[path.extname(name)], 'cache-control': 'no-cache' }); res.end(d); });
}).listen(WEB, () => console.log(`App:    http://localhost:${WEB}   (abra no Chrome/Edge)\nIA:     chaves em ${CFG} (${cfg.keys.length} cadastrada(s))`));

/* ---------- WebSocket mínimo (RFC 6455) ---------- */
const frame = (payload, binary) => { const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload); const n = b.length; let h;
  if (n < 126) h = Buffer.from([binary ? 0x82 : 0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = binary ? 0x82 : 0x81; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = binary ? 0x82 : 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, b]); };
function parseFrames(st, chunk, onMsg) {
  st.buf = Buffer.concat([st.buf, chunk]);
  for (;;) {
    const b = st.buf; if (b.length < 2) return; const op = b[0] & 15; let len = b[1] & 127, off = 2, masked = b[1] & 128;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + (masked ? 4 : 0) + len) return;
    let data = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len); if (masked) { const m = b.subarray(off, off + 4); data = Buffer.from(data.map((x, i) => x ^ m[i % 4])); }
    st.buf = b.subarray(off + (masked ? 4 : 0) + len); onMsg(op, data);
  }
}
const wss = http.createServer(); 
wss.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key || !originOk(req.headers.origin)) return sock.destroy(); // bloqueia sites externos de mandar comandos à mesa
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const st = { buf: Buffer.alloc(0) }, udp = dgram.createSocket('udp4'); let mixerIp = null;
  const sendWs = (d, bin) => { try { sock.write(frame(d, bin)); } catch (e) {} };
  udp.on('message', (m, r) => sendWs(m, true));
  udp.on('error', e => sendWs(JSON.stringify({ evt: 'error', msg: 'UDP: ' + e.message })));
  udp.bind(0, () => { udp.setBroadcast(true); sendWs(JSON.stringify({ evt: 'ready' })); });
  const osc = (addr, tags = '', args = []) => { const pad = s => { const b = Buffer.from(s + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); }; return Buffer.concat([pad(addr), pad(',' + tags), ...args]); };
  parseFrames(st, Buffer.alloc(0), () => {});
  sock.on('data', c => parseFrames(st, c, (op, d) => {
    if (op === 8) { sock.end(); return; } if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, d.length]), d])); return; }
    if (op === 1) { let j; try { j = JSON.parse(d.toString()); } catch (e) { return; }
      if (j.cmd === 'connect') { mixerIp = j.ip; sendWs(JSON.stringify({ evt: 'status', ip: mixerIp })); }
      if (j.cmd === 'discover') { // /xinfo em broadcast; a XR18 responde com /xinfo ,ssss (ip, nome, modelo, versão)
        const d2 = dgram.createSocket('udp4'); d2.bind(0, () => { d2.setBroadcast(true); const msg = osc('/xinfo'); [...bcastAddrs(), '255.255.255.255'].forEach(a => d2.send(msg, OSC_PORT, a)); });
        d2.on('message', (m, r) => { sendWs(JSON.stringify({ evt: 'found', ip: r.address, name: (m.toString('latin1').match(/XR18|X18|XR16|XR12|MR18/) || [''])[0] })); d2.close(); }); setTimeout(() => { try { d2.close(); } catch (e) {} }, 3500); }
    } else if (op === 2 && mixerIp) udp.send(d, OSC_PORT, mixerIp);
  }));
  sock.on('close', () => { try { udp.close(); } catch (e) {} }); sock.on('error', () => {});
});
const bcastAddrs = () => { const out = []; for (const l of Object.values(os.networkInterfaces())) for (const i of l) if (i.family === 'IPv4' && !i.internal) { const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number); out.push(ip.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.')); } return out; };
wss.listen(WSP, () => console.log(`Ponte:  ws://localhost:${WSP}  →  UDP ${OSC_PORT} da mesa`));
