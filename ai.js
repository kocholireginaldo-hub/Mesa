/* XR18 Studio — IA de mixagem/masterização: análise matemática do áudio USB + auditoria da cena + aplicação na mesa */
(function () {
  const XR = window.XR, store = XR.store, el = XR.el, S = XR.ui, SR = 48000;
  const AI = (XR.ai = { spectra: {}, results: [], master: null, sugs: [], audit: [], note: '' });

  /* ---------- DSP ---------- */
  const N = 8192, WIN = new Float64Array(N), TW = { c: new Float64Array(N / 2), s: new Float64Array(N / 2) };
  let WS = 0; for (let i = 0; i < N; i++) { WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); WS += WIN[i]; }
  for (let i = 0; i < N / 2; i++) { TW.c[i] = Math.cos((-2 * Math.PI * i) / N); TW.s[i] = Math.sin((-2 * Math.PI * i) / N); }
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const h = len >> 1, st = n / len; for (let i = 0; i < n; i += len) for (let k = 0; k < h; k++) { const wr = TW.c[k * st], wi = TW.s[k * st], a = i + k, b = a + h, xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; } }
  };
  XR.dsp = { fft };
  /** espectro médio (Welch). Devolve potência linear por bin (≈ valor quadrático médio). */
  const welch = x => {
    const P = new Float64Array(N / 2 + 1), re = new Float64Array(N), im = new Float64Array(N); let cnt = 0;
    const hop = N / 2, frames = Math.max(1, Math.floor((x.length - N) / hop) + 1), stepF = Math.max(1, Math.floor(frames / 240));
    for (let f = 0; f < frames; f += stepF) {
      const o = f * hop; for (let i = 0; i < N; i++) { re[i] = (x[o + i] || 0) * WIN[i]; im[i] = 0; }
      fft(re, im); for (let k = 0; k <= N / 2; k++) P[k] += ((re[k] * re[k] + im[k] * im[k]) / (WS * WS)) * 2; cnt++;
    }
    for (let k = 0; k <= N / 2; k++) P[k] /= cnt; return P;
  };
  const EDGES = [20, 60, 200, 500, 2000, 5000, 10000, 20000], BNAMES = ['Sub 20–60', 'Grave 60–200', 'Médio-grave 200–500', 'Médio 0,5–2k', 'Médio-agudo 2–5k', 'Presença 5–10k', 'Brilho 10–20k'], BCEN = [35, 110, 316, 1000, 3160, 7070, 14100];
  const bandSum = (P, lo, hi) => { let s = 0; for (let k = 1; k < P.length; k++) { const f = (k * SR) / N; if (f >= lo && f < hi) s += P[k]; } return s; };
  const toDb = v => (v > 1e-14 ? 10 * Math.log10(v) : -140);
  const bands7 = P => EDGES.slice(0, 7).map((lo, i) => toDb(bandSum(P, lo, EDGES[i + 1])));
  const ISO = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
  const bands31 = P => ISO.map(f => toDb(bandSum(P, f / Math.pow(2, 1 / 6), f * Math.pow(2, 1 / 6))));
  const centroid = P => { let a = 0, b = 0; for (let k = 1; k < P.length; k++) { const f = (k * SR) / N; a += f * P[k]; b += P[k]; } return b ? a / b : 0; };
  const toSpectrum = P => { const fr = [], db = []; for (let k = 1; k < P.length; k++) { fr.push((k * SR) / N); db.push(toDb(P[k])); } return { freqs: fr, db }; };

  const biquad = (x, b, a) => { const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  const kw = x => biquad(biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  /** loudness integrada ITU-R BS.1770 (gated) e máximo de curto prazo (3 s) */
  const lufs = chans => {
    const k = chans.map(kw), blk = 0.4 * SR, hop = 0.1 * SR, ms = [];
    for (let o = 0; o + blk <= k[0].length; o += hop) { let s = 0; k.forEach(c => { let a = 0; for (let i = o; i < o + blk; i++) a += c[i] * c[i]; s += a / blk; }); ms.push(s); }
    if (!ms.length) return { i: -Infinity, st: -Infinity };
    const L = v => -0.691 + 10 * Math.log10(v), abs = ms.filter(v => L(v) > -70); if (!abs.length) return { i: -Infinity, st: -Infinity };
    const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10, g = abs.filter(v => L(v) > rel), integ = g.length ? L(g.reduce((a, b) => a + b, 0) / g.length) : -Infinity;
    let st = -Infinity; const w = 30; for (let i = 0; i + w <= ms.length; i += 5) { const m = ms.slice(i, i + w).reduce((a, b) => a + b, 0) / w; st = Math.max(st, L(m)); }
    return { i: integ, st };
  };

  /* ---------- perfis por instrumento (metas heurísticas, editáveis) ---------- */
  const PROF = {
    kick: { n: 'Bumbo', re: /bumbo|kick|bd\b/i, hpf: 35, shape: [0, 7, 1, -5, -2, -9, -16], crest: 16, ratio: 4, att: 20, rel: 120, gate: true, tip: 'Corpo em 60–100 Hz, corte "lama" em 250–400 Hz, ataque em 3–5 kHz.' },
    snare: { n: 'Caixa', re: /caixa|snare|\bsn\b/i, hpf: 90, shape: [-16, -3, 4, 1, 3, -2, -10], crest: 16, ratio: 4, att: 8, rel: 90, gate: true, tip: 'Corpo em 150–250 Hz, estalo em 3–5 kHz; cuide do ressoar em 400–600 Hz.' },
    tom: { n: 'Tom', re: /tom/i, hpf: 60, shape: [-8, 4, 4, -2, -1, -8, -16], crest: 16, ratio: 3, att: 15, rel: 150, gate: true, tip: 'Fundamental em 80–200 Hz; corte 400–600 Hz (caixa de papelão); ataque 4–5 kHz.' },
    surdo: { n: 'Surdo', re: /surdo/i, hpf: 40, shape: [2, 8, 0, -6, -8, -14, -22], crest: 16, ratio: 4, att: 25, rel: 150, gate: true, tip: 'Concentre em 60–120 Hz; filtre abaixo de 40 Hz e controle o médio-grave.' },
    oh: { n: 'Pratos/Overhead', re: /prato|overhead|\boh\b|hat/i, hpf: 250, shape: [-22, -14, -6, 0, 2, 3, 0], crest: 18, ratio: 2, att: 20, rel: 150, gate: false, tip: 'Filtre graves (>200 Hz); ar em 10 kHz; atenção a 3–4 kHz agressivo.' },
    bass: { n: 'Baixo', re: /baix|bass|\bdi\b/i, hpf: 30, shape: [3, 6, 0, -6, -12, -18, -26], crest: 12, ratio: 4, att: 25, rel: 150, gate: false, tip: 'Fundamental 60–120 Hz, definição em 700–1k; corte sub <30 Hz. Compressão 3–4:1 estabiliza.' },
    acoustic: { n: 'Violão', re: /viol[aã]o|acoust/i, hpf: 80, shape: [-18, -4, 2, 3, 1, -3, -10], crest: 14, ratio: 3, att: 15, rel: 120, gate: false, tip: 'Corte 200–300 Hz (caixa), brilho em 8–10 kHz; HPF 80–100 Hz.' },
    keys: { n: 'Teclado', re: /teclad|key|piano|synth/i, hpf: 50, shape: [-12, 0, 3, 1, -2, -8, -16], crest: 14, ratio: 2, att: 20, rel: 150, gate: false, tip: 'Abra espaço para voz em 1–3 kHz; limpe 200–400 Hz.' },
    guitar: { n: 'Guitarra', re: /guitar|gtr/i, hpf: 90, shape: [-20, -6, 2, 4, 2, -4, -14], crest: 14, ratio: 3, att: 15, rel: 120, gate: false, tip: 'Corpo 200–400 Hz, mordida 2–4 kHz; HPF 80–100 Hz.' },
    vocal: { n: 'Voz', re: /^mic$|mic\b|voz|vocal|altar|vox|coro|lead/i, hpf: 100, shape: [-26, -10, 0, 5, 2, -3, -12], crest: 16, ratio: 3, att: 10, rel: 100, gate: false, tip: 'HPF 80–120 Hz; 200–300 Hz lama; presença 2–5 kHz; sibilância 5–8 kHz (de-esser).' },
    play: { n: 'Playback', re: /play|back|track/i, hpf: 30, shape: [-6, 0, 0, -2, -5, -9, -15], crest: 18, ratio: 2, att: 30, rel: 200, gate: false, tip: 'Já masterizado: ajuste só o nível relativo à banda.' },
    gen: { n: 'Genérico', re: /./, hpf: 80, shape: [-14, -2, 2, 2, 0, -4, -12], crest: 16, ratio: 3, att: 15, rel: 120, gate: false, tip: 'Perfil genérico.' }
  };
  AI.PROF = PROF;
  const profileOf = name => { for (const k of ['kick', 'snare', 'surdo', 'tom', 'oh', 'bass', 'acoustic', 'keys', 'guitar', 'play', 'vocal']) if (PROF[k].re.test(name)) return k; return 'gen'; };

  /* ---------- análise de uma faixa ---------- */
  const lastSeconds = 60;
  AI.analyseTrack = i => {
    const t = XR.rec.tracks[i]; if (!t || !t.frames) return null;
    const n = Math.min(t.frames, lastSeconds * SR), x = XR.rec.readFloat(t, t.frames - n, n);
    let pk = 0; for (let k = 0; k < n; k++) pk = Math.max(pk, Math.abs(x[k]));
    const B = 0.05 * SR, rms = []; for (let o = 0; o + B <= n; o += B) { let s = 0; for (let k = o; k < o + B; k++) s += x[k] * x[k]; rms.push(s / B); }
    const dbs = rms.map(toDb), mx = Math.max(...dbs), act = rms.filter((v, k) => dbs[k] > Math.max(mx - 30, -65));
    const activeRms = act.length ? toDb(act.reduce((a, b) => a + b, 0) / act.length) : -140, sorted = [...dbs].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)] || -140;
    const P = welch(x), b7 = bands7(P), mean = b7.reduce((a, b) => a + b, 0) / 7;
    return { i, id: XR.rec.stripId(i), name: XR.rec.trackName(i), peak: pk > 0 ? 20 * Math.log10(pk) : -140, rms: activeRms, crest: (pk > 0 ? 20 * Math.log10(pk) : -140) - activeRms, floor, bands: b7, shape: b7.map(v => v - mean), cent: centroid(P), P, activity: act.length / Math.max(1, rms.length) };
  };

  /* ---------- sugestões por canal ---------- */
  const R1 = v => Math.round(v * 10) / 10, R05 = v => Math.round(v * 2) / 2, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  AI.suggestTrack = m => {
    const out = [], id = m.id, isCh = m.i < 16, pk = profileOf(m.name), pr = PROF[pk], n2 = String(m.i + 1).padStart(2, '0'); m.prof = pk;
    const add = (sev, title, detail, changes) => out.push({ id: id + ':' + title, ch: m.name, sev, title, detail, changes, on: sev !== 'info' && !!changes });
    if (m.peak > -140 && m.rms < -60) { add('info', 'Sem sinal', 'Faixa praticamente silenciosa; nada a analisar.'); return out; }
    if (m.peak >= -0.5) add('crit', 'Clipping na entrada', `Pico em ${R1(m.peak)} dBFS: o conversor está estourando. Reduza o ganho do pré-amplificador.`, isCh ? gainChange(id, n2, -(m.peak + 9)) : null);
    else if (isCh) {
      if (m.peak > -4) add('warn', 'Ganho de entrada alto', `Pico em ${R1(m.peak)} dBFS deixa pouca margem. Alvo: pico entre −18 e −8 dBFS.`, gainChange(id, n2, -9 - m.peak));
      else if (m.peak < -26) add('warn', 'Ganho de entrada baixo', `Pico em ${R1(m.peak)} dBFS (alvo −18…−8). Sinal fraco aumenta o ruído relativo.`, gainChange(id, n2, clamp(-12 - m.peak, 0, 14)));
    }
    if (isCh) {
      const on = store.get(id + '/preamp/hpon'), f = store.get(id + '/preamp/hpf', 20);
      if (!on) add('warn', 'Low cut desligado', `Para ${pr.n} use low cut em ~${pr.hpf} Hz para tirar ruído de palco/vento.`, { [id + '/preamp/hpon']: true, [id + '/preamp/hpf']: pr.hpf });
      else if (f > pr.hpf * 1.8 && !['oh'].includes(pk)) add('info', 'Low cut alto', `${f} Hz está acima do típico (${pr.hpf} Hz) para ${pr.n}: pode afinar o som.`, { [id + '/preamp/hpf']: pr.hpf });
    }
    // EQ: corrigir desvio espectral considerando o EQ atual (o sinal medido é pré-EQ: tap AIN)
    if (isCh || m.i >= 16) {
      const dev = m.shape.map((v, k) => v - pr.shape[k]); m.dev = dev;
      const ch = {}, why = [];
      for (let k = 1; k <= 5; k++) {
        if (Math.abs(dev[k]) < 3.5) continue;
        const want = clamp(-dev[k], -4, 4), have = XR.eqResponseDb(id, BCEN[k]), delta = want - have; if (Math.abs(delta) < 1.5) continue;
        const band = pickBand(id, BCEN[k], ch); if (!band) continue;
        const g0 = store.get(`${id}/eq/${band}/g`, 0), ty = store.get(`${id}/eq/${band}/type`, 'PEQ'), f0 = store.get(`${id}/eq/${band}/f`, BCEN[k]);
        if (Math.abs(Math.log2(f0 / BCEN[k])) > 0.8) { ch[`${id}/eq/${band}/f`] = Math.round(BCEN[k]); ch[`${id}/eq/${band}/q`] = 1.4; }
        ch[`${id}/eq/${band}/g`] = R05(clamp(g0 + delta, -12, 12)); if (/Cut/.test(ty)) delete ch[`${id}/eq/${band}/g`];
        why.push(`${BNAMES[k]}: ${dev[k] > 0 ? 'excesso' : 'falta'} de ${R1(Math.abs(dev[k]))} dB vs. meta → ${delta > 0 ? '+' : ''}${R1(delta)} dB na banda ${band}`);
      }
      if (Object.keys(ch).length) { ch[id + '/eq/on'] = true; add('warn', 'Equalização', why.join(' · '), ch); }
    }
    // dinâmica
    if (isCh && m.crest > pr.crest + 3) {
      const d = id + '/dyn/', on = store.get(d + 'on'), thr = store.get(d + 'thr', 0), want = R05(clamp(m.rms + 2, -45, -6));
      if (!on || thr > want + 6) add('warn', 'Compressão', `Fator de crista ${R1(m.crest)} dB (típico ≤ ${pr.crest}). Comp ${pr.ratio}:1, threshold ${want} dB.`, { [d + 'on']: true, [d + 'thr']: want, [d + 'ratio']: pr.ratio, [d + 'attack']: pr.att, [d + 'release']: pr.rel });
    }
    // gate
    if (isCh && pr.gate && m.rms - m.floor > 25 && !store.get(id + '/gate/on')) { const thr = R05(clamp(m.floor + (m.rms - m.floor) * 0.4, -70, -20)); add('info', 'Gate sugerido', `Piso de ruído ${R1(m.floor)} dBFS vs. sinal ${R1(m.rms)} dBFS: gate com threshold ${thr} dB reduz vazamento.`, { [id + '/gate/on']: true, [id + '/gate/thr']: thr }); }
    if (!out.length) add('info', 'Canal OK', 'Níveis e balanço espectral dentro das metas.');
    return out;
  };
  const gainChange = (id, n2, delta) => { delta = R05(delta); if (!delta) return null; if (store.get(id + '/preamp/rtnsw')) { const k = id + '/preamp/rtntrim'; return { [k]: R05(clamp(store.get(k, 0) + delta, -18, 18)) }; } const k = `headamp/${n2}/gain`; return { [k]: R05(clamp(store.get(k, 0) + delta, -12, 60)) }; };
  const pickBand = (id, f, used) => { let best = 0, bd = 9; for (let b = 1; b <= XR.eqBands(id); b++) { const t = store.get(`${id}/eq/${b}/type`, 'PEQ'); if (/Cut/.test(t) || (used[`${id}/eq/${b}/g`] !== undefined)) continue; const d = Math.abs(Math.log2(store.get(`${id}/eq/${b}/f`, f) / f)); const pen = t === 'PEQ' || t === 'VEQ' ? 0 : 0.6; if (d + pen < bd) { bd = d + pen; best = b; } } return best; };

  /* ---------- master ---------- */
  const TARGETS = { stream: ['Streaming (−14 LUFS)', -14], pa: ['Show / PA (−18 LUFS)', -18], loud: ['Master forte (−10 LUFS)', -10] };
  AI.analyseMaster = (tgtKey = 'stream') => {
    const tl = XR.rec.tracks[16], tr = XR.rec.tracks[17]; if (!tl.frames || !tr.frames) return null;
    const n = Math.min(tl.frames, tr.frames, 120 * SR), l = XR.rec.readFloat(tl, tl.frames - n, n), r = XR.rec.readFloat(tr, tr.frames - n, n);
    let pk = 0, sl = 0, sr = 0, slr = 0, sm = 0, ss = 0; for (let k = 0; k < n; k++) { pk = Math.max(pk, Math.abs(l[k]), Math.abs(r[k])); sl += l[k] * l[k]; sr += r[k] * r[k]; slr += l[k] * r[k]; const m = (l[k] + r[k]) / 2, s = (l[k] - r[k]) / 2; sm += m * m; ss += s * s; }
    const L = lufs([l, r]), mono = new Float32Array(n); for (let k = 0; k < n; k++) mono[k] = (l[k] + r[k]) / 2;
    const P = welch(mono), b31 = bands31(P), peakDb = 20 * Math.log10(pk || 1e-9), corr = slr / Math.sqrt(sl * sr || 1);
    const T = f => (f >= 200 ? -3.5 * Math.log2(f / 1000) : -3.5 * Math.log2(0.2) - (f < 60 ? 6 * Math.log2(60 / f) : 0));
    const idx = ISO.map((f, k) => k).filter(k => ISO[k] >= 63 && ISO[k] <= 12500), mm = idx.reduce((a, k) => a + b31[k], 0) / idx.length, tm = idx.reduce((a, k) => a + T(ISO[k]), 0) / idx.length;
    const dev = ISO.map((f, k) => b31[k] - mm - (T(f) - tm)), sm_ = dev.map((v, k) => (v + (dev[k - 1] ?? v) + (dev[k + 1] ?? v)) / 3);
    AI.spectra['lr'] = toSpectrum(P);
    const target = TARGETS[tgtKey][1], M = { lufs: L.i, st: L.st, peak: peakDb, plr: peakDb - L.i, corr, width: ss / (sm + ss + 1e-12), b31, dev: sm_, target, tname: TARGETS[tgtKey][0] }; AI.master = M;
    const out = [], add = (sev, title, detail, changes) => out.push({ id: 'master:' + title, ch: 'MASTER', sev, title, detail, changes, on: sev !== 'info' && !!changes });
    if (peakDb > -1) add('crit', 'Pico do master acima de −1 dBFS', `Pico ${R1(peakDb)} dBFS: risco de clipping/inter-sample. Reduza o fader Main ou coloque limiter com teto −1 dBTP.`, { 'lr/mix/fader': R05(store.get('lr/mix/fader', 0) - (peakDb + 1.5)) });
    if (isFinite(L.i)) { const d = target - L.i; if (Math.abs(d) > 1.5) add('warn', 'Loudness fora da meta', `Integrado ${R1(L.i)} LUFS vs. meta ${target} LUFS (${M.tname}). ${d > 0 ? 'Suba' : 'Desça'} ${R1(Math.abs(d))} dB no Main.${d > 0 && peakDb + d > -1 ? ' Atenção: o pico passaria de −1 dBFS; use compressor/limiter no LR.' : ''}`, d > 0 && peakDb + d > -1 ? null : { 'lr/mix/fader': R05(clamp(store.get('lr/mix/fader', 0) + d, -30, 10)) }); }
    if (M.plr > 16) add('info', 'Dinâmica muito aberta', `Pico − loudness = ${R1(M.plr)} dB (típico 10–14). Aumente a compressão no LR (ratio 2–3:1, threshold em ~${R05(L.i + 3)} dB).`, { 'lr/dyn/on': true, 'lr/dyn/ratio': 3, 'lr/dyn/thr': R05(clamp(L.i + 3, -40, -6)) });
    if (corr < 0.2) add('warn', 'Fase / correlação baixa', `Correlação L/R ${corr.toFixed(2)}: risco de cancelamento em mono. Verifique polaridade dos microfones e efeitos estéreo.`);
    const ch = {}, why = [];
    ISO.forEach((f, k) => { if (Math.abs(sm_[k]) >= 2.5 && f >= 50 && f <= 16000) { const cur = store.get('lr/geq/' + String(k + 1).padStart(2, '0'), 0); ch['lr/geq/' + String(k + 1).padStart(2, '0')] = R05(clamp(cur - clamp(sm_[k], -4, 4) * 0.6, -12, 12)); why.push(`${XR.fmtHz(f)}: ${sm_[k] > 0 ? '+' : ''}${R1(sm_[k])} dB`); } });
    if (Object.keys(ch).length) add('warn', 'Balanço espectral (GEQ do Main)', `Desvios em relação à curva alvo: ${why.slice(0, 10).join(' · ')}${why.length > 10 ? '…' : ''}. Correção suave (60 %) — reanalise após aplicar.`, ch);
    if (!out.length) add('info', 'Master OK', `Loudness ${R1(L.i)} LUFS, pico ${R1(peakDb)} dBFS, correlação ${corr.toFixed(2)}.`);
    return out;
  };

  /* ---------- auditoria da cena (offline) ---------- */
  AI.auditScene = () => {
    const out = [], add = (sev, ch, title, detail, changes) => out.push({ id: 'scn:' + ch + title, ch, sev, title, detail, changes, on: false });
    XR.STRIPS.filter(s => s.kind === 'ch').forEach(s => {
      const id = s.id, name = XR.name(id), pk = profileOf(name), pr = PROF[pk], gains = [1, 2, 3, 4].map(b => store.get(`${id}/eq/${b}/g`, 0)), types = [1, 2, 3, 4].map(b => store.get(`${id}/eq/${b}/type`));
      const boosts = gains.filter((g, i) => g > 0 && !/Cut/.test(types[i])), sum = boosts.reduce((a, b) => a + b, 0);
      if (store.get(id + '/eq/on') && (sum > 12 || Math.max(0, ...boosts) >= 8)) add('warn', name, 'EQ com muito realce', `Realces somam +${R1(sum)} dB (maior +${R1(Math.max(...boosts))} dB). Prefira cortar o que incomoda e subir o fader/ganho; muito boost estoura o headroom do canal.`);
      if (store.get(id + '/eq/on') === false && gains.some(g => Math.abs(g) > 1)) add('info', name, 'EQ desligado com ajustes', 'Há ganhos configurados, mas o EQ do canal está desligado.', { [id + '/eq/on']: true });
      const hpon = store.get(id + '/preamp/hpon'), hpf = store.get(id + '/preamp/hpf', 20);
      if (!hpon && ['vocal', 'guitar', 'acoustic', 'keys', 'snare'].includes(pk)) add('warn', name, 'Low cut desligado', `${pr.n}: ative o low cut em ~${pr.hpf} Hz.`, { [id + '/preamp/hpon']: true, [id + '/preamp/hpf']: pr.hpf });
      if (hpon && ['kick', 'bass', 'surdo'].includes(pk) && hpf > 120) add('warn', name, 'Low cut alto demais', `Low cut em ${hpf} Hz remove o fundamental do ${pr.n}.`, { [id + '/preamp/hpf']: pr.hpf });
      const hm = store.get('headamp/' + id.slice(3) + '/gain', 0); if (hm >= 40) add('info', name, 'Ganho de pré muito alto', `${R1(hm)} dB: confira ruído e vazamento.`);
      if (store.get(id + '/dyn/on') && store.get(id + '/dyn/ratio', 1) >= 100) add('info', name, 'Compressor funcionando como limitador', `Ratio ${store.get(id + '/dyn/ratio')}:1 — OK para pico, mas segura bastante a dinâmica.`);
      if (store.get(id + '/gate/on') && store.get(id + '/gate/thr', -80) > store.get(id + '/dyn/thr', -60) + 10 && store.get(id + '/dyn/on')) add('info', name, 'Gate mais alto que compressor', `Threshold do gate (${R1(store.get(id + '/gate/thr'))} dB) bem acima do compressor (${R1(store.get(id + '/dyn/thr'))} dB): verifique se não corta a cauda.`);
    });
    for (let g = 1; g <= 4; g++) if (store.get('config/mute/' + g)) { const who = XR.ALL.filter(s => (store.get(s.id + '/grp/mute', 0) >> (g - 1)) & 1).map(s => XR.name(s.id)); add('warn', 'Mute group ' + g, 'Grupo de mute ATIVO', `Silenciando: ${who.join(', ') || '(ninguém)'}. Normal se for intencional; desative antes de gravar/mixar.`, { ['config/mute/' + g]: false }); }
    XR.BUSES.forEach(b => { const nm = XR.name(b.id); if (/sub/i.test(nm)) { let hi = 0; for (let i = 18; i <= 31; i++) hi = Math.max(hi, store.get(b.id + '/geq/' + String(i).padStart(2, '0'), 0)); if (hi >= 2) add('warn', nm, 'Bus de sub com realce nos agudos', `O GEQ tem até +${R1(hi)} dB acima de 1 kHz num bus de subwoofer; normalmente ele só deve conter graves.`); } });
    ['lr'].forEach(id => { for (let b = 1; b <= 6; b++) { const t = store.get(`${id}/eq/${b}/type`), g = store.get(`${id}/eq/${b}/g`, 0); if (!/Cut/.test(t) && g >= 8) add('warn', 'Main LR', 'Realce forte no Main', `Banda ${b} com +${R1(g)} dB em ${XR.fmtHz(store.get(`${id}/eq/${b}/f`))} Hz consome headroom e pode saturar as caixas; prefira corrigir no canal/sub.`); } });
    if (!out.length) add('info', 'Cena', 'Auditoria', 'Nada suspeito encontrado nas configurações.');
    return out;
  };

  /* ---------- dicas em texto com Gemini (opcional) — via núcleo central XR.aiCore, módulo "rec" ----------
     Contexto próprio da gravação: nunca mistura dados da operação ao vivo. A chave fica só no servidor local. */
  AI.askCloud = async () => {
    const data = { canais: AI.results.map(m => ({ nome: m.name, perfil: m.prof, pico_dBFS: R1(m.peak), rms_dBFS: R1(m.rms), crista_dB: R1(m.crest), piso_dBFS: R1(m.floor), desvio_espectral_por_banda_dB: (m.dev || []).map(R1) })), master: AI.master && { lufs: R1(AI.master.lufs), pico: R1(AI.master.peak), plr: R1(AI.master.plr), correlacao: +AI.master.corr.toFixed(2) } };
    if (!data.canais.length && !data.master) throw new Error('Analise os canais/master antes (botões acima).');
    const r = await XR.aiCore.ask('rec', { json: false, system: 'Você é engenheiro de som analisando GRAVAÇÕES multipista de uma mesa Behringer XR18 (bandas: sub, grave, médio-grave, médio, médio-agudo, presença, brilho; desvio positivo = excesso vs. meta). Dê no máximo 8 dicas práticas e curtas em português do Brasil para mixagem e masterização, priorizando as mais importantes. Não sugira controlar a mesa ao vivo.', prompt: JSON.stringify(data) });
    if (!r.ok) throw new Error(r.reason || 'IA em nuvem indisponível (as análises locais continuam funcionando).');
    return r.text;
  };

  /* ---------- aplicar ---------- */
  AI.applySelected = () => { const ch = {}; AI.sugs.filter(s => s.on && s.changes).forEach(s => Object.assign(ch, s.changes)); const n = Object.keys(ch).length; if (!n) return 0; const prev = store.apply(ch); if (XR.mesa) for (const k in ch) XR.mesa.record({ key: k, before: prev[k], after: ch[k], reason: 'Sugestão da IA da gravação aprovada pelo operador', source: 'IA gravação (manual)', result: XR.net.mode === 'live' ? 'enviado' : 'aplicado (demo, sem mesa)' }); AI.note = `${n} parâmetros aplicados na mesa. Use "Desfazer" para voltar.`; return n; };
  AI.runChannels = () => { AI.results = []; let all = []; for (let i = 0; i < 16; i++) { const m = AI.analyseTrack(i); if (!m) continue; AI.results.push(m); AI.spectra[m.id] = toSpectrum(m.P); all = all.concat(AI.suggestTrack(m)); } AI.sugs = AI.sugs.filter(s => s.ch === 'MASTER' || s.id.startsWith('scn:')).concat(all); AI.note = AI.results.length ? `${AI.results.length} canais analisados.` : 'Nenhum áudio nas faixas 1–16. Grave pela aba REC, importe arquivos ou gere sinais de teste.'; };

  /* ---------- aba IA ---------- */
  S.tabs.ai = c => {
    const root = el('div', 'ai'); c.append(root);
    root.innerHTML = `<div class="rrow">
      <button id="a1" class="tg big">▶ Analisar canais</button><button id="a2" class="tg big">▶ Analisar master (faixas 17/18)</button><button id="a3" class="tg big">Auditar cena</button>
      <select id="atg">${Object.entries(TARGETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
      <button id="a4" class="tg">USB 17/18 = Main LR</button>
      <button id="a5" class="tg green big">Aplicar selecionados</button><button id="a6" class="tg">Desfazer</button></div>
      <div class="na" id="anote"></div><div id="ares"></div><div id="asug"></div>
      <details class="claude"><summary>Dicas em texto com Gemini (opcional · precisa de internet, servidor local e chave cadastrada em Setup → IA)</summary><button id="a7" class="tg">Pedir dicas</button><pre id="atxt"></pre></details>`;
    const q = s => root.querySelector(s);
    const render = () => {
      q('#anote').textContent = AI.note;
      const rs = q('#ares'); rs.innerHTML = '';
      if (AI.results.length || AI.master) {
        const tb = el('table', 'atb'); tb.innerHTML = '<tr><th>Canal</th><th>Perfil</th><th>Pico</th><th>RMS</th><th>Crista</th><th>Piso</th><th>Brilho (centroide)</th><th>Balanço vs. meta (7 bandas)</th></tr>';
        AI.results.forEach(m => { const tr = el('tr'); tr.innerHTML = `<td>${m.i + 1} ${m.name}</td><td>${PROF[m.prof || profileOf(m.name)].n}</td><td>${R1(m.peak)}</td><td>${R1(m.rms)}</td><td>${R1(m.crest)}</td><td>${R1(m.floor)}</td><td>${Math.round(m.cent)} Hz</td>`; const td = el('td'), cv = el('canvas'); cv.width = 140; cv.height = 30; td.append(cv); tr.append(td); tb.append(tr); drawBands(cv, m.shape, PROF[m.prof || profileOf(m.name)].shape); });
        rs.append(tb);
        if (AI.master) { const M = AI.master; rs.append(el('div', 'mast', `<b>MASTER</b> · ${R1(M.lufs)} LUFS integrado · curto prazo máx. ${R1(M.st)} LUFS · pico ${R1(M.peak)} dBFS · PLR ${R1(M.plr)} dB · correlação ${M.corr.toFixed(2)} · largura ${(M.width * 100).toFixed(0)} % · meta ${M.target} LUFS`)); }
      }
      const sg = q('#asug'); sg.innerHTML = '';
      const groups = {}; AI.sugs.forEach(s => (groups[s.ch] = groups[s.ch] || []).push(s));
      for (const ch in groups) { const g = el('div', 'sgrp'); g.append(el('h4', '', ch));
        groups[ch].forEach(s => { const r = el('label', 'sug ' + s.sev); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!s.on; cb.disabled = !s.changes; cb.onchange = () => (s.on = cb.checked);
          const ch2 = s.changes ? '<small>' + Object.entries(s.changes).slice(0, 6).map(([k, v]) => `${k} → ${typeof v === 'number' ? R1(v) : v}`).join(' · ') + '</small>' : '<small>(dica, sem ajuste automático)</small>';
          r.append(cb, el('div', '', `<b>${s.title}</b><br>${s.detail}<br>${ch2}`)); g.append(r); });
        sg.append(g); }
      if (!Object.keys(groups).length) sg.append(el('div', 'na', 'Nenhuma análise ainda. Dica: sem a mesa conectada use "Gerar sinais de teste" na aba REC para ver como funciona.'));
      if (AI.results.some(m => m.prof)) { const tips = el('div', 'tips'); const seen = new Set(); AI.results.forEach(m => { if (!seen.has(m.prof)) { seen.add(m.prof); tips.append(el('div', '', `<b>${PROF[m.prof].n}:</b> ${PROF[m.prof].tip}`)); } }); sg.append(tips); }
    };
    q('#a1').onclick = () => { AI.runChannels(); render(); }; q('#a2').onclick = () => { const o = AI.analyseMaster(q('#atg').value); AI.sugs = AI.sugs.filter(s => s.ch !== 'MASTER'); if (!o) AI.note = 'Sem áudio nas faixas 17/18. Use "USB 17/18 = Main LR" e grave, ou importe um stereo bounce.'; else { AI.sugs = AI.sugs.concat(o); AI.note = 'Master analisado.'; } render(); };
    q('#a3').onclick = () => { AI.sugs = AI.sugs.filter(s => !s.id.startsWith('scn:')).concat(AI.auditScene()); AI.note = 'Auditoria da cena concluída.'; render(); };
    q('#a4').onclick = () => { store.set('routing/usb/17', 'L AIN', { send: false }); store.set('routing/usb/18', 'R AIN', { send: false }); if (store.transport) { store.transport.send('/routing/usb/17', [{ t: 's', v: 'L AIN' }]); } AI.note = 'USB 17/18 configuradas para o Main L/R (confirme em In/Out). Grave de novo para a IA ouvir a saída.'; render(); };
    q('#a5').onclick = () => { const n = AI.applySelected(); if (!n) AI.note = 'Nada selecionado para aplicar.'; render(); XR.refresh(); };
    q('#a6').onclick = () => { AI.note = store.undo() ? 'Última aplicação desfeita.' : 'Nada para desfazer.'; render(); };
    q('#a7').onclick = async () => { q('#atxt').textContent = 'Consultando…'; try { q('#atxt').textContent = await AI.askCloud(); } catch (e) { q('#atxt').textContent = 'Erro: ' + e.message; } };
    render();
  };
  function drawBands(cv, shape, target) {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height, bw = w / 7; g.clearRect(0, 0, w, h);
    shape.forEach((v, i) => { const y = clamp(v, -24, 12); g.fillStyle = Math.abs(v - target[i]) >= 3.5 ? '#e8a020' : '#2fb7d6'; const hh = ((y + 24) / 36) * (h - 2); g.fillRect(i * bw + 2, h - hh, bw - 6, hh); const ty = h - ((clamp(target[i], -24, 12) + 24) / 36) * (h - 2); g.fillStyle = '#fff'; g.fillRect(i * bw, ty, bw - 2, 2); });
  }
})();
