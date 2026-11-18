/* XR18 Studio — núcleo: unidades, codec OSC, parser .scn, store, transporte */
(function () {
  const XR = (window.XR = window.XR || {});

  /* ---------- conversões (padrão X-AIR / X32) ---------- */
  const faderToDb = f => f >= 0.5 ? f * 40 - 30 : f >= 0.25 ? f * 80 - 50 : f >= 0.0625 ? f * 160 - 70 : f > 0 ? f * 480 - 90 : -Infinity;
  const dbToFader = d => !isFinite(d) || d <= -90 ? 0 : d < -60 ? (d + 90) / 480 : d < -30 ? (d + 70) / 160 : d < -10 ? (d + 50) / 80 : Math.min(1, (d + 30) / 40);
  XR.perf = { uiAt: 0, oscRttMs: null };
  XR.faderToDb = faderToDb; XR.dbToFader = dbToFader;
  XR.fmtDb = d => !isFinite(d) ? '-oo' : (d > 0 ? '+' : '') + d.toFixed(1);
  XR.fmtHz = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + 'k' : (f >= 100 ? f.toFixed(0) : f.toFixed(1));

  XR.EQ_TYPES = ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut'];
  XR.GATE_MODES = ['EXP2', 'EXP3', 'EXP4', 'GATE', 'DUCK'];
  XR.FILTERS = ['LC6', 'LC12', 'HC6', 'HC12', '1.0', '2.0', '3.0', '5.0', '10.0'];
  XR.RATIOS = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];
  XR.TAPS = ['IN', 'PREEQ', 'POSTEQ', 'PRE', 'POST', 'GRP'];

  const lin = (lo, hi) => ({ t: 'f', enc: v => (v - lo) / (hi - lo), dec: f => lo + f * (hi - lo) });
  const lg = (lo, hi) => ({ t: 'f', enc: v => Math.log(v / lo) / Math.log(hi / lo), dec: f => lo * Math.pow(hi / lo, f) });
  const en = list => ({ t: 'i', enc: v => Math.max(0, list.findIndex(x => String(x) === String(v))), dec: i => list[i] !== undefined ? list[i] : list[0] });
  const bool = { t: 'i', enc: v => (v ? 1 : 0), dec: i => !!i };
  const FADER = { t: 'f', enc: dbToFader, dec: faderToDb };
  const STR = { t: 's', enc: v => String(v), dec: v => v };
  const INT = { t: 'i', enc: v => v | 0, dec: v => v };
  const RATIO = { t: 'i', enc: v => { let b = 0, bd = 1e9; XR.RATIOS.forEach((r, i) => { const d = Math.abs(r - v); if (d < bd) { bd = d; b = i; } }); return b; }, dec: i => XR.RATIOS[i] || 1.1 };
  const QQ = { t: 'f', enc: q => Math.log(q / 10) / Math.log(0.03), dec: f => 10 * Math.pow(0.03, f) };

  const RULES = [
    [/\/config\/name$/, STR], [/\/config\/color$/, INT],
    [/\/mix\/fader$|^dca\/\d\/fader$/, FADER], [/\/mix\/pan$/, lin(-100, 100)], [/\/mix\/lr$/, bool],
    [/\/mix\/\d\d\/level$/, FADER], [/\/mix\/\d\d\/pan$/, lin(-100, 100)], [/\/mix\/\d\d\/tap$/, en(XR.TAPS)], [/\/mix\/\d\d\/on$/, bool],
    [/\/eq\/\d\/type$/, en(XR.EQ_TYPES)], [/\/eq\/\d\/f$/, lg(20, 20000)], [/\/eq\/\d\/g$/, lin(-15, 15)], [/\/eq\/\d\/q$/, QQ],
    [/\/geq\/\d\d$/, lin(-15, 15)],
    [/\/gate\/mode$/, en(XR.GATE_MODES)], [/\/gate\/thr$/, lin(-80, 0)], [/\/gate\/range$/, lin(3, 60)], [/\/gate\/attack$/, lin(0, 120)],
    [/\/gate\/hold$/, lg(0.02, 2000)], [/\/gate\/release$/, lg(5, 4000)],
    [/\/filter\/type$/, en(XR.FILTERS)], [/\/filter\/f$/, lg(20, 20000)],
    [/\/dyn\/mode$/, en(['COMP', 'EXP'])], [/\/dyn\/det$/, en(['PEAK', 'RMS'])], [/\/dyn\/env$/, en(['LIN', 'LOG'])],
    [/\/dyn\/thr$/, lin(-60, 0)], [/\/dyn\/ratio$/, RATIO], [/\/dyn\/knee$/, lin(0, 5)], [/\/dyn\/mgain$/, lin(0, 24)],
    [/\/dyn\/attack$/, lin(0, 120)], [/\/dyn\/hold$/, lg(0.02, 2000)], [/\/dyn\/release$/, lg(5, 4000)], [/\/dyn\/mix$/, lin(0, 100)],
    [/\/dyn\/auto$/, bool],
    [/\/preamp\/rtntrim$/, lin(-18, 18)], [/\/preamp\/hpf$/, lg(20, 400)],
    [/^headamp\/\d\d\/gain$/, lin(-12, 60)],
    [/\/(on|invert|rtnsw|hpon|phantom)$/, bool], [/^config\/mute\/\d$/, bool], [/\/grp\/(dca|mute)$/, INT], [/^-stat\/solosw\/\d\d$/, bool], [/^routing\//, STR]
  ];
  const cache = {};
  XR.codecFor = k => {
    if (k in cache) return cache[k];
    let c = null;
    for (const [re, cc] of RULES) if (re.test(k)) { c = cc; break; }
    return (cache[k] = c);
  };

  /* ---------- OSC ---------- */
  const te = new TextEncoder(), td = new TextDecoder();
  const pad4 = n => (n + 4) & ~3;
  XR.oscEncode = (addr, args = []) => {
    const tags = ',' + args.map(a => a.t).join('');
    const parts = [];
    const str = s => { const b = te.encode(s); const o = new Uint8Array(pad4(b.length)); o.set(b); return o; };
    parts.push(str(addr), str(tags));
    for (const a of args) {
      if (a.t === 's') parts.push(str(a.v));
      else { const o = new DataView(new ArrayBuffer(4)); a.t === 'f' ? o.setFloat32(0, a.v) : o.setInt32(0, a.v | 0); parts.push(new Uint8Array(o.buffer)); }
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let p = 0;
    for (const x of parts) { out.set(x, p); p += x.length; }
    return out;
  };
  XR.oscDecode = buf => {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let p = 0;
    const rs = () => { let e = p; while (u[e] !== 0) e++; const s = td.decode(u.subarray(p, e)); p = pad4(e - p) + p; return s; };
    const addr = rs(); if (p >= u.length) return { addr, args: [] };
    const tags = rs().slice(1), args = [];
    for (const t of tags) {
      if (t === 'f') { args.push(dv.getFloat32(p)); p += 4; }
      else if (t === 'i') { args.push(dv.getInt32(p)); p += 4; }
      else if (t === 's') args.push(rs());
      else if (t === 'b') { const n = dv.getInt32(p); p += 4; args.push(u.slice(p, p + n)); p += (n + 3) & ~3; }
    }
    return { addr, args };
  };

  /* ---------- parser de cena (.scn) ---------- */
  const parseFreq = s => { const m = /^([+-]?\d+)k(\d+)$/.exec(s); return m ? +m[1] * 1000 + parseInt(m[2].padEnd(2, '0').slice(0, 2), 10) * 10 : NaN; };
  const P = t => {
    if (t === undefined) return undefined;
    if (t === 'ON') return true; if (t === 'OFF') return false;
    if (t === '-oo') return -Infinity;
    if (t[0] === '"') return t.slice(1, -1);
    const f = parseFreq(t); if (!isNaN(f)) return f;
    if (/^[+-]?\d*\.?\d+$/.test(t)) return parseFloat(t);
    return t;
  };
  const mask = t => parseInt(String(t).replace('%', ''), 2) || 0;

  XR.parseScn = text => {
    const o = {};
    for (const line of text.split(/\r?\n/)) {
      const tk = line.match(/"[^"]*"|\S+/g); if (!tk || tk[0][0] !== '/') continue;
      const path = tk[0].slice(1), a = tk.slice(1); let m;
      if ((m = /^config\/(chlink|buslink|linkcfg|solo|amixenable|amixlock)$/.exec(path))) o['config/' + m[1]] = a.join(' ');
      else if (path === 'config/mute') a.forEach((v, i) => (o['config/mute/' + (i + 1)] = P(v)));
      else if ((m = /^(ch\/\d\d|rtn\/\w+|bus\/\d|fxsend\/\d|lr)\/config$/.exec(path))) {
        o[m[1] + '/config/name'] = P(a[0]); o[m[1] + '/config/color'] = P(a[1]);
        if (m[1][0] === 'c') { o[m[1] + '/config/insrc'] = a[2]; o[m[1] + '/config/rtnsrc'] = a[3]; }
        else if (m[1][0] === 'r') o[m[1] + '/config/src'] = a[2];
      }
      else if ((m = /^(ch\/\d\d)\/preamp$/.exec(path))) { ['rtntrim', 'rtnsw', 'invert', 'hpon', 'hpf'].forEach((k, i) => (o[m[1] + '/preamp/' + k] = P(a[i]))); }
      else if ((m = /^(rtn\/\w+)\/preamp$/.exec(path))) { o[m[1] + '/preamp/rtntrim'] = P(a[0]); o[m[1] + '/preamp/invert'] = P(a[1]); }
      else if ((m = /^headamp\/(\d\d)$/.exec(path))) { o[path + '/gain'] = P(a[0]); if (a[1]) o[path + '/phantom'] = P(a[1]); }
      else if ((m = /^(ch\/\d\d)\/gate$/.exec(path))) ['on', 'mode', 'thr', 'range', 'attack', 'hold', 'release', 'keysrc'].forEach((k, i) => (o[m[1] + '/gate/' + k] = P(a[i])));
      else if ((m = /^(.+)\/(gate|dyn)\/filter$/.exec(path))) { o[m[1] + '/' + m[2] + '/filter/on'] = P(a[0]); o[m[1] + '/' + m[2] + '/filter/type'] = String(a[1]); o[m[1] + '/' + m[2] + '/filter/f'] = P(a[2]); }
      else if ((m = /^(.+)\/dyn$/.exec(path))) {
        const ks = ['on', 'mode', 'det', 'env', 'thr', 'ratio', 'knee', 'mgain', 'attack', 'hold', 'release', 'mix'];
        ks.forEach((k, i) => (o[m[1] + '/dyn/' + k] = P(a[i])));
        if (a.length >= 14) { o[m[1] + '/dyn/keysrc'] = a[12]; o[m[1] + '/dyn/auto'] = P(a[13]); } else o[m[1] + '/dyn/auto'] = P(a[12]);
      }
      else if ((m = /^(.+)\/eq$/.exec(path))) { o[m[1] + '/eq/on'] = P(a[0]); if (a[1]) o[m[1] + '/eq/mode'] = a[1]; }
      else if ((m = /^(.+)\/eq\/(\d)$/.exec(path))) { const b = m[1] + '/eq/' + m[2] + '/'; o[b + 'type'] = a[0]; o[b + 'f'] = P(a[1]); o[b + 'g'] = P(a[2]); o[b + 'q'] = P(a[3]); }
      else if ((m = /^(.+)\/geq$/.exec(path))) a.forEach((v, i) => (o[m[1] + '/geq/' + String(i + 1).padStart(2, '0')] = P(v)));
      else if ((m = /^(ch\/\d\d|rtn\/\w+)\/mix\/(\d\d)$/.exec(path))) { const b = m[1] + '/mix/' + m[2] + '/'; o[b + 'level'] = P(a[0]); o[b + 'on'] = P(a[1]); o[b + 'tap'] = a[2]; if (a[3] !== undefined) o[b + 'pan'] = P(a[3]); }
      else if ((m = /^(ch\/\d\d|rtn\/\w+|bus\/\d)\/mix$/.exec(path))) { o[m[1] + '/mix/on'] = P(a[0]); o[m[1] + '/mix/fader'] = P(a[1]); o[m[1] + '/mix/lr'] = P(a[2]); o[m[1] + '/mix/pan'] = P(a[3]); }
      else if (path === 'lr/mix') { o['lr/mix/on'] = P(a[0]); o['lr/mix/fader'] = P(a[1]); o['lr/mix/pan'] = P(a[2]); }
      else if ((m = /^fxsend\/\d\/mix$/.exec(path))) { o[path.replace(/mix$/, 'mix/on')] = P(a[0]); o[path.replace(/mix$/, 'mix/fader')] = P(a[1]); }
      else if ((m = /^(.+)\/grp$/.exec(path))) { o[m[1] + '/grp/dca'] = mask(a[0]); o[m[1] + '/grp/mute'] = mask(a[1]); }
      else if ((m = /^(.+)\/automix$/.exec(path))) { o[m[1] + '/automix/on'] = P(a[0]); o[m[1] + '/automix/weight'] = P(a[1]); }
      else if ((m = /^dca\/(\d)$/.exec(path))) { o[path + '/on'] = P(a[0]); o[path + '/fader'] = P(a[1]); }
      else if ((m = /^dca\/(\d)\/config$/.exec(path))) { o[path + '/name'] = P(a[0]); o[path + '/color'] = P(a[1]); }
      else if ((m = /^fx\/(\d)$/.exec(path))) { o[path + '/type'] = a[0]; o[path + '/on'] = P(a[1]); }
      else if ((m = /^fx\/(\d)\/par$/.exec(path))) o[path] = a.map(P);
      else if (/^routing\//.test(path)) o[path] = a.join(' ');
    }
    return o;
  };
  XR.serializeScn = () => JSON.stringify(XR.store.snapshot(), (k, v) => (v === -Infinity ? '-oo' : v), 1);

  /* ---------- store ---------- */
  const store = (XR.store = {
    d: {}, subs: [], remote: [], transport: null, undoStack: [],
    get(k, def) { const v = this.d[k]; return v === undefined ? def : v; },
    set(k, v, o = {}) {
      if (this.d[k] === v) return;
      if (o.undo) o.undo[k] = this.d[k];
      this.d[k] = v;
      this.subs.forEach(f => f(k, v));
      if (o.send !== false && this.transport) {
        const c = XR.codecFor(k);
        if (c && v !== undefined) this.transport.send('/' + k, [{ t: c.t, v: c.enc(v) }]);
      }
    },
    load(obj, send) { for (const k in obj) this.set(k, obj[k], { send: !!send }); this.subs.forEach(f => f('*')); },
    on(f) { this.subs.push(f); },
    snapshot() { return Object.assign({}, this.d); },
    fromOsc(addr, args) {
      const k = addr.slice(1), c = XR.codecFor(k);
      if (c && args.length) { this.set(k, c.dec(args[0]), { send: false }); this.remote.forEach(f => f(k, this.d[k])); }
    },
    /** aplica um lote de {chave: valor} e devolve o desfazer */
    apply(changes) { const prev = {}; for (const k in changes) { prev[k] = this.d[k]; this.set(k, changes[k]); } this.undoStack.push(prev); return prev; },
    undo() { const p = this.undoStack.pop(); if (!p) return false; for (const k in p) this.set(k, p[k]); return true; }
  });

  /* ---------- estrutura da mesa ---------- */
  XR.STRIPS = [];
  for (let i = 1; i <= 16; i++) XR.STRIPS.push({ id: 'ch/' + String(i).padStart(2, '0'), kind: 'ch', n: i, label: String(i).padStart(2, '0'), def: 'Ch ' + String(i).padStart(2, '0') });
  XR.STRIPS.push({ id: 'rtn/aux', kind: 'aux', label: 'Aux', def: 'Aux' });
  for (let i = 1; i <= 4; i++) XR.STRIPS.push({ id: 'rtn/' + i, kind: 'rtn', n: i, label: 'FX ' + i, def: 'FX ' + i });
  XR.BUSES = [1, 2, 3, 4, 5, 6].map(i => ({ id: 'bus/' + i, kind: 'bus', n: i, def: 'Bus ' + i }));
  XR.FXSENDS = [1, 2, 3, 4].map(i => ({ id: 'fxsend/' + i, kind: 'fxsend', n: i, def: 'FX Send ' + i }));
  XR.LR = { id: 'lr', kind: 'lr', def: 'LR' };
  XR.ALL = [...XR.STRIPS, ...XR.BUSES, ...XR.FXSENDS, XR.LR];
  XR.byId = id => XR.ALL.find(s => s.id === id);
  XR.sendBuses = [...XR.BUSES, ...XR.FXSENDS]; // índice 1..10 nos /mix/NN
  XR.COLORS = ['#5a5a5a', '#e32323', '#25c943', '#f3e600', '#2268ff', '#e623b8', '#22c9e8', '#f2f2f2'];
  XR.colorOf = idx => { idx = idx | 0; const inv = idx >= 8, c = XR.COLORS[idx % 8]; return inv ? { bg: idx === 8 ? '#8a8a8a' : '#000', fg: idx === 8 ? '#000' : c, bd: c, inv } : { bg: c, fg: idx === 3 || idx === 7 || idx === 2 || idx === 6 ? '#000' : '#fff', bd: c }; };
  XR.name = id => { const s = XR.byId(id); const n = store.get(id + '/config/name', ''); return n || (s ? s.def : id); };
  XR.hasProc = id => id !== 'fxsend/1' && !/^fxsend/.test(id) && !/^rtn\/\d/.test(id) || /^rtn\/\d/.test(id);
  XR.eqBands = id => (/^(bus|lr)/.test(id) ? 6 : 4);
  XR.isMuted = id => { const on = store.get(id + '/mix/on', true); return !on; };
  XR.groupMuted = id => { const m = store.get(id + '/grp/mute', 0); for (let g = 1; g <= 4; g++) if ((m >> (g - 1)) & 1 && store.get('config/mute/' + g)) return true; return false; };
  /** reaplica os grupos de mute aos canais (modo demo; na mesa real ela mesma faz isso) */
  XR.applyMuteGroups = () => { XR.ALL.forEach(s => { const m = store.get(s.id + '/grp/mute', 0); if (!m) return; store.set(s.id + '/mix/on', !XR.groupMuted(s.id), { send: false }); }); };

  /* ---------- EQ: resposta em frequência (RBJ biquad) ---------- */
  XR.bandResponseDb = (type, f0, g, q, f, fs = 48000) => {
    const w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    q = Math.max(0.1, q); let b0, b1, b2, a0, a1, a2; const A = Math.pow(10, g / 40), al = sw / (2 * q);
    if (type === 'LCut') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'HCut') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'LShv' || type === 'HShv') {
      const s = Math.sqrt(A) * 2 * al, sg = type === 'LShv' ? 1 : -1;
      b0 = A * ((A + 1) - sg * (A - 1) * cw + s); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * cw); b2 = A * ((A + 1) - sg * (A - 1) * cw - s);
      a0 = (A + 1) + sg * (A - 1) * cw + s; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * cw); a2 = (A + 1) + sg * (A - 1) * cw - s;
    } else { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  };
  XR.eqResponseDb = (id, f) => {
    if (!store.get(id + '/eq/on')) return 0; let s = 0;
    for (let b = 1; b <= XR.eqBands(id); b++) s += XR.bandResponseDb(store.get(`${id}/eq/${b}/type`, 'PEQ'), store.get(`${id}/eq/${b}/f`, 1000), store.get(`${id}/eq/${b}/g`, 0), store.get(`${id}/eq/${b}/q`, 2), f);
    return s;
  };

  /* ---------- transporte (ponte PC / Android / demo) ---------- */
  XR.net = {
    mode: 'demo', ws: null, status: 'offline', listeners: [], ip: '',
    setStatus(s, extra) { this.status = s; this.listeners.forEach(f => f(s, extra)); },
    onStatus(f) { this.listeners.push(f); },
    sendRaw(bytes) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
      else if (window.XR18Native) window.XR18Native.send(btoa(String.fromCharCode(...bytes)));
    },
    sentAt: {},
    send(addr, args) { if (args && args.length) XR.net.sentAt[addr] = performance.now(); XR.net.sendRaw(XR.oscEncode(addr, args || [])); },
    recvBytes(u8) {
      let m; try { m = XR.oscDecode(u8); } catch (e) { return; }
      if (m.addr === '/meters/1' || /^\/meters\//.test(m.addr)) { XR.meters.fromBlob(m); return; }
      const t0 = XR.net.sentAt[m.addr]; if (t0) { XR.perf.oscRttMs = +(performance.now() - t0).toFixed(1); delete XR.net.sentAt[m.addr]; }
      XR.net.lastRx = Date.now(); XR.store.fromOsc(m.addr, m.args);
    },
    recvB64(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); XR.net.recvBytes(u); },
    connect(ip, bridgeUrl) {
      this.ip = ip; this.setStatus('connecting');
      const ready = () => {
        store.transport = { send: (a, g) => XR.net.send(a, g) };
        this.mode = 'live'; this.setStatus('online');
        this.kick = setInterval(() => { this.send('/xremote'); this.subMeters(); }, 5000); this.send('/xremote');
        this.pullAll();
      };
      if (window.XR18Native) { window.XR18Native.connect(ip); setTimeout(ready, 400); return; }
      const ws = (this.ws = new WebSocket(bridgeUrl || 'ws://localhost:8765'));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { ws.send(JSON.stringify({ cmd: 'connect', ip })); setTimeout(ready, 300); };
      ws.onmessage = e => { if (typeof e.data === 'string') { try { const j = JSON.parse(e.data); this.setStatus(j.evt, j); } catch (_) {} } else this.recvBytes(new Uint8Array(e.data)); };
      ws.onerror = () => this.setStatus('error', { msg: 'Ponte não encontrada. Rode "node servidor.js" no PC.' });
      ws.onclose = () => { clearInterval(this.kick); store.transport = null; this.mode = 'demo'; this.setStatus('offline'); };
    },
    disconnect() { if (this.ws) this.ws.close(); clearInterval(this.kick); store.transport = null; this.mode = 'demo'; this.setStatus('offline'); },
    /** pede à mesa o valor atual de todos os parâmetros conhecidos */
    pullAll() {
      const keys = Object.keys(store.d).filter(k => XR.codecFor(k)); let i = 0;
      const t = setInterval(() => { for (let n = 0; n < 12 && i < keys.length; n++, i++) XR.net.send('/' + keys[i]); if (i >= keys.length) clearInterval(t); }, 25);
      this.subMeters();
    },
    /** a assinatura de medidores da X-Air expira em ~10 s: renovada junto do /xremote (a confirmar na mesa real) */
    subMeters() { this.send('/meters', [{ t: 's', v: '/meters/1' }, { t: 'i', v: 0 }, { t: 'i', v: 0 }, { t: 'i', v: 1 }]); }
  };

  /* ---------- medidores ---------- */
  XR.meters = {
    v: {}, /* id -> dBFS */
    fromBlob(m) { // blob int16 LE: 1ª metade das entradas = canais (layout configurável)
      const b = m.args[0]; if (!b || b.length < 8) return;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getInt32(0, true), L = XR.meters.layout || XR.STRIPS.map(s => s.id);
      for (let i = 0; i < n && i < L.length; i++) XR.meters.v[L[i]] = dv.getInt16(4 + i * 2, true) / 256;
    },
    demoTick(t) {
      XR.ALL.forEach((s, i) => { const on = store.get(s.id + '/mix/on', true) !== false; const base = -40 + 12 * Math.sin(t / 700 + i * 1.7) + 8 * Math.sin(t / 130 + i); XR.meters.v[s.id] = on ? base : -90; });
      XR.meters.v['lr'] = -18 + 6 * Math.sin(t / 400);
    }
  };
})();
