/* XR18 Studio — gravador multipista (USB 18 canais), importação, exportação WAV e reprodução pelos retornos USB */
(function () {
  const XR = window.XR, store = XR.store, el = XR.el, S = XR.ui;
  const SR = 48000, PEAK_BIN = 480, MAXTR = 18;
  const R = (XR.rec = { tracks: [], state: 'idle', pos: 0, mode: 'usb', inId: '', outId: '', live: null, prevRtn: null, msg: '' });

  const newTrack = i => ({ i, name: '', chunks: [], frames: 0, peaks: [], mute: false, solo: false, arm: true, gain: 1, level: -90 });
  R.ensure = n => { while (R.tracks.length < n) R.tracks.push(newTrack(R.tracks.length)); };
  R.ensure(MAXTR);
  R.stripId = i => (i < 16 ? 'ch/' + String(i + 1).padStart(2, '0') : 'rtn/aux');
  R.trackName = i => R.tracks[i].name || (i < 16 ? XR.name(R.stripId(i)) : i === 16 ? 'Aux L' : 'Aux R');
  R.totalFrames = () => Math.max(0, ...R.tracks.map(t => t.frames));
  R.hasAudio = () => R.tracks.some(t => t.frames > 0);
  R.clear = () => { R.tracks = []; R.ensure(MAXTR); R.pos = 0; };

  const addInt16 = (t, f32) => {
    const i16 = new Int16Array(f32.length);
    for (let k = 0; k < f32.length; k++) { const x = f32[k] < -1 ? -1 : f32[k] > 1 ? 1 : f32[k]; i16[k] = x < 0 ? x * 32768 : x * 32767; }
    pushChunk(t, i16);
  };
  const pushChunk = (t, i16) => {
    const start = t.frames; t.chunks.push(i16); t.frames += i16.length;
    for (let k = 0; k < i16.length; k++) { const b = ((start + k) / PEAK_BIN) | 0, a = Math.abs(i16[k]) / 32768; if (t.peaks[b] === undefined || a > t.peaks[b]) t.peaks[b] = a; }
  };
  R.readFloat = (t, from, n) => { // lê n amostras a partir de 'from' como Float32 (0 após o fim)
    const out = new Float32Array(n); let pos = 0;
    for (const c of t.chunks) { const end = pos + c.length; if (end > from && pos < from + n) { const a = Math.max(from, pos), b = Math.min(from + n, end); for (let k = a; k < b; k++) out[k - from] = c[k - pos] / 32768; } pos = end; if (pos >= from + n) break; }
    return out;
  };

  /* ---------- captura ---------- */
  const WORKLET = `class RP extends AudioWorkletProcessor{process(i){const c=i[0];if(!c||!c.length)return true;if(!this.b){this.b=c.map(()=>new Float32Array(2048));this.p=0;}
  for(let k=0;k<c.length;k++)this.b[k].set(c[k],this.p);this.p+=c[0].length;if(this.p>=2048){this.port.postMessage(this.b.map(x=>x.slice()));this.p=0;}return true;}}registerProcessor('rp',RP);`;
  R.listDevices = async () => {
    try { await (navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()))); } catch (e) { /* sem permissão ainda */ }
    const d = await navigator.mediaDevices.enumerateDevices(); return { ins: d.filter(x => x.kind === 'audioinput'), outs: d.filter(x => x.kind === 'audiooutput') };
  };
  R.startCapture = async () => {
    if (R.state !== 'idle') return;
    if (R.hasAudio() && !(R.confirmOverwrite ? R.confirmOverwrite() : true)) { R.msg = 'Gravação cancelada: as faixas atuais foram mantidas.'; return; } // proteção contra sobrescrita acidental
    let stream = null; const base = { deviceId: R.inId ? { exact: R.inId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SR };
    for (const c of [18, 16, 8, 4, 2]) { try { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, channelCount: { exact: c } } }); break; } catch (e) { if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') throw e; } } // tenta 18 canais "exatos" antes de aceitar menos
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, channelCount: { ideal: 18 } } });
    const st = stream.getAudioTracks()[0].getSettings(), n = Math.min(MAXTR, st.channelCount || 2); R.inChannels = n;
    const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }); await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })); await ctx.audioWorklet.addModule(url);
    const src = ctx.createMediaStreamSource(stream); src.channelCount = n; src.channelCountMode = 'explicit'; src.channelInterpretation = 'discrete';
    const node = new AudioWorkletNode(ctx, 'rp', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: n, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    src.connect(node);
    const sp = ctx.createChannelSplitter(n), ana = []; src.connect(sp);
    for (let i = 0; i < n; i++) { const a = ctx.createAnalyser(); a.fftSize = 4096; a.smoothingTimeConstant = 0.8; sp.connect(a, i); ana.push(a); }
    R.clearForRecord(); R.ensure(n);
    node.port.onmessage = e => { if (R.state !== 'rec') return; e.data.forEach((f, i) => { if (R.tracks[i] && R.tracks[i].arm) addInt16(R.tracks[i], f); }); };
    R.live = { ctx, ana, stream, n, kind: 'rec', flush: setInterval(() => R.flushSession().catch(() => {}), 10000) }; R.state = 'rec'; R.msg = `Gravando ${n} canais @ ${SR / 1000} kHz`;
    if (n < 16) R.msg += ` — atenção: o Windows/driver expôs só ${n} canais. Veja a nota no README (ASIO/WASAPI).`;
  };
  R.clearForRecord = () => { if (XR.storage) XR.storage.recClear(); if (!R.hasAudio()) return; R.tracks.forEach(t => { t.chunks = []; t.frames = 0; t.peaks = []; t.saved = 0; t.segN = 0; }); R.pos = 0; };
  R.confirmOverwrite = () => (typeof confirm === 'function' ? confirm('Já existem faixas na sessão. Gravar agora APAGA as faixas atuais (exporte antes se precisar). Continuar?') : true);

  /* ---------- salvamento automático da gravação (recuperação após queda/fechamento) ----------
     A cada ~10 s os blocos novos vão para o IndexedDB em segmentos; o app oferece "Recuperar última gravação". */
  R.flushSession = async () => {
    if (!XR.storage) return;
    for (const t of R.tracks) {
      const from = t.saved | 0; if (from >= t.chunks.length) continue;
      const part = t.chunks.slice(from), n = part.reduce((a, c) => a + c.length, 0), seg = new Int16Array(n); let o = 0; part.forEach(c => { seg.set(c, o); o += c.length; });
      await XR.storage.recPut(t.i, t.segN | 0, seg); t.saved = t.chunks.length; t.segN = (t.segN | 0) + 1;
    }
    await XR.storage.recMeta({ frames: R.totalFrames(), at: Date.now(), names: R.tracks.map(t => t.name) });
  };
  R.recover = async () => {
    if (!XR.storage || R.state !== 'idle') return false; const segs = await XR.storage.recLoad(); if (!segs.length) return false;
    R.clear(); segs.forEach(({ track, data }) => { const t = R.tracks[track]; if (t) { pushChunk(t, data); t.saved = t.chunks.length; t.segN = (t.segN | 0) + 1; } });
    const m = await XR.storage.recMetaGet(); if (m && m.names) m.names.forEach((n, i) => { if (R.tracks[i] && n) R.tracks[i].name = n; });
    R.msg = 'Gravação recuperada da sessão anterior.'; return true;
  };
  R.stop = async () => {
    if (R.state === 'rec' && R.live) { clearInterval(R.live.flush); R.live.stream.getTracks().forEach(t => t.stop()); await R.live.ctx.close(); await R.flushSession().catch(() => {}); }
    if (R.state === 'play') await R.stopPlay();
    R.live = null; R.state = 'idle'; if (R.rec_end) R.rec_end();
  };

  /* ---------- reprodução ----------
     CORREÇÃO DE LATÊNCIA: antes, o ganho (fader/mute/solo) era "gravado" em cada bloco no momento em que ele era agendado
     (até 3 s à frente), então qualquer mudança só era ouvida depois que a fila agendada acabava. Agora cada faixa tem UM
     GainNode persistente DEPOIS da fila (fila -> GainNode da faixa -> mix). Mudar o ganho afeta também o áudio já agendado. */
  R.effUsb = false;
  R.perf = { faderToGainMs: null, estAudibleMs: null, oscRttMs: null, updates: 0 };
  R.trackGain = i => {
    const t = R.tracks[i], solo = R.tracks.some(x => x.solo);
    if (!t.frames || t.mute || (solo && !t.solo)) return 0;
    let g = t.gain;
    if (!R.effUsb) { // monitor local: fader/mute da mesa valem aqui; no modo USB quem aplica é a própria mesa
      const id = R.stripId(i); // (mute/OFF da mesa NÃO é aplicado aqui, como no original: use o botão M da faixa)
      const d = store.get(id + '/mix/fader', 0); g *= isFinite(d) ? Math.pow(10, d / 20) : 0;
    }
    return g;
  };
  R.updateGains = () => {
    const L = R.live; if (!L || L.kind !== 'play') return;
    const now = L.ctx.currentTime, p = R.perf;
    L.chain.forEach((g, i) => g.gain.setTargetAtTime(R.trackGain(i), now, 0.008)); // rampa de ~8 ms: sem estalo e sem atraso perceptível
    if (L.pans) L.pans.forEach((pn, i) => { const id = R.stripId(i); pn.pan.setTargetAtTime(i >= 16 ? (i === 16 ? -1 : 1) : Math.max(-1, Math.min(1, store.get(id + '/mix/pan', 0) / 100)), now, 0.01); });
    const t0 = XR.perf && XR.perf.uiAt; p.updates++;
    if (t0 && performance.now() - t0 < 200) { p.faderToGainMs = +(performance.now() - t0).toFixed(2); p.estAudibleMs = +(p.faderToGainMs + 1000 * ((L.ctx.baseLatency || 0) + (L.ctx.outputLatency || 0)) + 24).toFixed(1); }
  };
  store.on(k => { if (R.live && R.live.kind === 'play' && (k === '*' || /\/mix\/(fader|pan|on)$/.test(k))) R.updateGains(); });
  R.play = async () => {
    if (R.state === 'rec' || !R.hasAudio()) return; if (R.state === 'play') await R.stopPlay();
    const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }); // buffer de saída pequeno; o agendamento à frente é só da fila
    let nOut = 2, merger = null, master = null; R.warn = '';
    const need = R.tracks.reduce((m, t, i) => (t.frames ? i + 1 : m), 0); // maior número de faixa com áudio
    let usb = R.mode === 'usb';
    if (usb) {
      if (R.outId && ctx.setSinkId) { try { await ctx.setSinkId(R.outId); } catch (e) { R.msg = 'Não consegui selecionar a saída USB: ' + e.message; } }
      const max = ctx.destination.maxChannelCount || 2;
      if (max < need) { // antes, as faixas acima do nº de canais da saída ficavam MUDAS (ex.: só 1 e 2 em saída estéreo). Agora toca o mix estéreo de todas.
        usb = false; R.warn = `A saída escolhida expõe só ${max} canais e há áudio até a faixa ${need}. Tocando o MIX ESTÉREO de todas as faixas (nada vai aos retornos USB da mesa). Para retorno multicanal escolha o dispositivo XR18 em "Saída/Retorno" e configure 18 canais nas propriedades de som do Windows.`;
      } else { nOut = Math.min(MAXTR, max); ctx.destination.channelCount = nOut; ctx.destination.channelInterpretation = 'discrete'; merger = ctx.createChannelMerger(nOut); merger.connect(ctx.destination); }
    }
    R.effUsb = usb; if (!usb) { master = ctx.createGain(); master.connect(ctx.destination); }
    const ana = [], chain = [], pans = usb ? null : [];
    R.tracks.forEach((t, i) => { const g = ctx.createGain(), a = ctx.createAnalyser(); a.fftSize = 4096; g.gain.value = R.trackGain(i); g.connect(a); ana.push(a);
      if (usb) { if (i < nOut) g.connect(merger, 0, i); }
      else { const p = ctx.createStereoPanner(); g.connect(p); p.connect(master); pans.push(p); }
      chain.push(g); });
    const start = ctx.currentTime + 0.15, from = R.pos, total = R.totalFrames(), CH = SR / 2; let sf = from;
    const L = (R.live = { ctx, ana, chain, pans, n: R.tracks.length, kind: 'play', start, from });
    R.state = 'play'; R.updateGains();
    const pump = () => {
      const cur = (ctx.currentTime - start) * SR + from;
      while (sf < total && sf < cur + SR * 3) {
        R.tracks.forEach((t, i) => { // agenda SEMPRE (mute/solo/fader agora vivem no GainNode, não no agendamento)
          if (!t.frames || sf >= t.frames) return;
          const f = R.readFloat(t, sf, CH), b = ctx.createBuffer(1, CH, SR); b.copyToChannel(f, 0);
          const s = ctx.createBufferSource(); s.buffer = b; s.connect(chain[i]); s.start(Math.max(ctx.currentTime, start + (sf - from) / SR));
        });
        sf += CH;
      }
      R.pos = Math.min(total, Math.max(from, cur)); if (cur >= total) R.stop();
    };
    L.timer = setInterval(pump, 120); pump();
  };
  R.stopPlay = async () => { R.warn = ''; if (R.live && R.live.kind === 'play') { clearInterval(R.live.timer); try { await R.live.ctx.close(); } catch (e) {} R.live = null; } R.state = 'idle'; };
  R.pause = async () => { const p = R.pos; await R.stopPlay(); R.pos = p; };
  R.seek = f => { R.pos = Math.max(0, Math.min(R.totalFrames(), f | 0)); if (R.state === 'play') { R.stopPlay().then(R.play); } };

  /* retorno USB → entradas dos canais (rtnsw) */
  R.routeReturns = on => {
    if (on) { R.prevRtn = {}; R.tracks.forEach((t, i) => { if (i < 16 && t.frames) { const k = R.stripId(i) + '/preamp/rtnsw'; R.prevRtn[k] = store.get(k, false); store.set(k, true); } }); R.msg = 'Canais com áudio agora tocam o retorno USB (rtnsw = ON).'; }
    else if (R.prevRtn) { for (const k in R.prevRtn) store.set(k, R.prevRtn[k]); R.prevRtn = null; R.msg = 'Entradas analógicas restauradas.'; }
  };

  /* ---------- importar / exportar ---------- */
  /* ---------- remover / importar faixa individual ---------- */
  R.removeTrack = i => {
    const t = R.tracks[i]; if (!t || !t.frames) return;
    R.lastRemoved = { i, name: t.name, chunks: t.chunks, frames: t.frames, peaks: t.peaks, mute: t.mute, solo: t.solo };
    t.chunks = []; t.frames = 0; t.peaks = []; t.name = ''; t.saved = 0; t.segN = 0; t.level = -90;
    R.updateGains(); R.msg = `Faixa ${i + 1} removida. Use "Desfazer remoção" se foi sem querer.`;
  };
  R.undoRemove = () => { const u = R.lastRemoved; if (!u) return; const t = R.tracks[u.i]; if (t.frames && !confirm('A faixa já tem outro áudio. Substituir?')) return; Object.assign(t, { chunks: u.chunks, frames: u.frames, peaks: u.peaks, name: u.name }); R.lastRemoved = null; R.updateGains(); R.msg = `Faixa ${u.i + 1} restaurada.`; };
  R.importToTrack = async (i, file) => {
    if (R.state === 'rec') { R.msg = 'Pare a gravação antes de importar.'; return; }
    await R.importFiles([file], i); R.updateGains();
  };
  R.importFiles = async (files, startSlot) => {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, SR);
    let slot = startSlot !== undefined ? startSlot : R.tracks.findIndex(t => !t.frames); if (slot < 0) slot = 0;
    for (const f of files) {
      const ab = await f.arrayBuffer(); const buf = await ctx.decodeAudioData(ab);
      for (let c = 0; c < buf.numberOfChannels && slot < MAXTR; c++, slot++) {
        const t = R.tracks[slot]; t.chunks = []; t.frames = 0; t.peaks = [];
        let data = buf.getChannelData(c);
        if (buf.sampleRate !== SR) data = resample(data, buf.sampleRate, SR);
        for (let o = 0; o < data.length; o += 48000) addInt16(t, data.subarray(o, Math.min(data.length, o + 48000)));
        t.name = f.name.replace(/\.[^.]+$/, '') + (buf.numberOfChannels > 1 ? ' ' + (c + 1) : '');
      }
    }
    R.msg = startSlot !== undefined ? `Importado a partir da faixa ${startSlot + 1}.` : 'Arquivos importados.';
  };
  const resample = (d, a, b) => { const n = Math.floor(d.length * b / a), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * a / b, k = p | 0, fr = p - k; o[i] = d[k] * (1 - fr) + (d[k + 1] || 0) * fr; } return o; };
  const wavHeader = (nch, frames) => { const b = new ArrayBuffer(44), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0))); const dl = frames * nch * 2;
    w(0, 'RIFF'); v.setUint32(4, 36 + dl, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true); v.setUint32(24, SR, true); v.setUint32(28, SR * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, dl, true); return b; };
  R.wavMono = t => new Blob([wavHeader(1, t.frames), ...t.chunks], { type: 'audio/wav' });
  R.WAV_MAX = 4294967295 - 44;
  R.wavMulti = (idx) => {
    if (R.totalFrames() * idx.length * 2 > R.WAV_MAX) throw new Error('A sessão passa de 4 GB: o formato WAV não comporta. Use "Exportar 1 WAV por canal".');
    const total = R.totalFrames(), parts = [wavHeader(idx.length, total)], B = 8192;
    for (let f = 0; f < total; f += B) { const n = Math.min(B, total - f), o = new Int16Array(n * idx.length); idx.forEach((ti, c) => { const fl = R.readFloat(R.tracks[ti], f, n); for (let k = 0; k < n; k++) { const x = fl[k]; o[k * idx.length + c] = x < 0 ? x * 32768 : x * 32767; } }); parts.push(o); }
    return new Blob(parts, { type: 'audio/wav' });
  };
  const download = (blob, name) => { const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); };
  R.exportMulti = () => { try { R.wavMulti([]); } catch (e) { R.msg = e.message; return; } const idx = R.tracks.map((t, i) => i).filter(i => R.tracks[i].frames); if (idx.length) download(R.wavMulti(idx), `XR18_multipista_${idx.length}ch.wav`); };
  R.exportEach = async () => {
    const list = R.tracks.filter(t => t.frames);
    if (window.showDirectoryPicker) { try { const dir = await showDirectoryPicker({ mode: 'readwrite' }); for (const t of list) { const fh = await dir.getFileHandle(`${String(t.i + 1).padStart(2, '0')}_${R.trackName(t.i).replace(/[^\w\-]+/g, '_')}.wav`, { create: true }); const w = await fh.createWritable(); await w.write(R.wavMono(t)); await w.close(); } return; } catch (e) { if (e.name === 'AbortError') return; } }
    list.forEach(t => download(R.wavMono(t), `${String(t.i + 1).padStart(2, '0')}_${R.trackName(t.i).replace(/[^\w\-]+/g, '_')}.wav`));
  };

  /* ---------- sinais de teste sintéticos (sem hardware) ---------- */
  R.synth = (secs = 8) => {
    R.clear(); const n = SR * secs; let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const gens = [
      (t, i) => { const p = t % 0.5; return Math.exp(-p * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-p * 30)) * p) * 0.9; }, // bumbo
      (t) => { const p = t % 1; return Math.exp(-p * 9) * Math.sin(2 * Math.PI * 160 * p) * 0.5 + 0.1 * rnd() * Math.exp(-p * 10); }, // tom1
      (t) => { const p = (t + 0.3) % 1; return Math.exp(-p * 9) * Math.sin(2 * Math.PI * 110 * p) * 0.5; }, // tom2
      (t) => { const p = (t + 0.6) % 1; return Math.exp(-p * 7) * Math.sin(2 * Math.PI * 70 * p) * 0.6; }, // surdo
      (t) => { const p = t % 0.25; return rnd() * Math.exp(-p * 30) * 0.25; }, // pratos
      (t) => { const p = t % 0.25; return rnd() * Math.exp(-p * 22) * 0.2; }, // pratos g
      (t) => { const p = (t + 0.5) % 1; return (rnd() * 0.5 + Math.sin(2 * Math.PI * 190 * p) * 0.5) * Math.exp(-p * 14) * 0.6; }, // caixa
      (t) => 0.5 * Math.sin(2 * Math.PI * 82.4 * t) + 0.2 * Math.sin(2 * Math.PI * 164.8 * t), // baixo
      (t) => 0.2 * (Math.sin(2 * Math.PI * 330 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t) + 0.3 * Math.sin(2 * Math.PI * 990 * t)), // violão
      (t) => 0.25 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t)) / 1.5, // teclado
      (t) => 0.2 * (Math.sin(2 * Math.PI * 440 * t) + 0.6 * Math.sin(2 * Math.PI * 880 * t) + 0.5 * Math.sin(2 * Math.PI * 1320 * t) + 0.3 * rnd()), // guitarra
      (t) => (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 6500 * t)) * (0.6 + 0.4 * Math.sin(t * 3)), // voz
      (t) => 0.3 * Math.sin(2 * Math.PI * 246 * t) * (0.5 + 0.5 * Math.sin(t * 2)),
      (t) => 0.3 * Math.sin(2 * Math.PI * 277 * t) * (0.5 + 0.5 * Math.sin(t * 2.5)),
      (t) => 0.3 * Math.sin(2 * Math.PI * 311 * t) * (0.5 + 0.5 * Math.sin(t * 1.5)),
      (t) => 0.3 * Math.sin(2 * Math.PI * 349 * t) * (0.5 + 0.5 * Math.sin(t * 1.8))
    ];
    gens.forEach((g, i) => { const t = R.tracks[i], arr = new Float32Array(n); for (let k = 0; k < n; k++) arr[k] = g(k / SR, i); for (let o = 0; o < n; o += 48000) addInt16(t, arr.subarray(o, o + 48000)); });
    for (const side of [16, 17]) { const t = R.tracks[side], arr = new Float32Array(n); for (let k = 0; k < n; k++) arr[k] = 0.15 * Math.sin(2 * Math.PI * (side === 16 ? 440 : 523) * k / SR); for (let o = 0; o < n; o += 48000) addInt16(t, arr.subarray(o, o + 48000)); }
    R.msg = 'Sinais de TESTE sintéticos gerados (não são áudio real da mesa).';
  };

  /* ---------- espectro / níveis ao vivo ---------- */
  XR.getSpectrum = id => {
    const i = XR.STRIPS.findIndex(s => s.id === id); const L = R.live;
    if (L && i >= 0 && L.ana[i]) { const a = L.ana[i], d = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(d); const fr = Array.from(d, (_, k) => (k * L.ctx.sampleRate) / a.fftSize); return { freqs: fr, db: Array.from(d) }; }
    return (XR.ai && XR.ai.spectra && XR.ai.spectra[id]) || null;
  };
  R.tick = () => {
    const L = R.live;
    R.tracks.forEach((t, i) => {
      if (L && L.ana[i]) { const a = L.ana[i], b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); let m = 0; for (let k = 0; k < b.length; k++) m = Math.max(m, Math.abs(b[k])); t.level = m > 1e-5 ? 20 * Math.log10(m) : -90; }
      else t.level = -90;
      if (L && i < 16) XR.meters.v[R.stripId(i)] = t.level;
    });
    if (R.state === 'rec') R.pos = R.totalFrames();
  };

  /* ---------- aba REC ---------- */
  const fmtT = f => { const s = f / SR, m = (s / 60) | 0; return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
  S.tabs.rec = c => {
    const root = el('div', 'rec');
    root.innerHTML = `
    <div class="rrow">
      <label>Entrada (USB XR18) <select id="rin"></select></label>
      <label>Saída/Retorno <select id="rout"></select></label>
      <label>Reprodução <select id="rmode"><option value="usb">Retorno USB → canais da mesa</option><option value="mon">Monitor (stereo com fader/pan da mesa)</option></select></label>
      <button id="rdev" class="tg">Atualizar dispositivos</button>
    </div>
    <div class="rrow">
      <button id="rrec" class="tg red big">● Gravar</button><button id="rstop" class="tg big">■ Parar</button><button id="rplay" class="tg big">▶ Tocar</button><button id="rpause" class="tg big">⏸</button><button id="rrew" class="tg big">⏮</button>
      <span id="rtime" class="time">00:00.00</span><span id="rlen" class="time dim">/ 00:00.00</span><span id="rmsg" class="na"></span>
    </div>
    <div class="rrow">
      <label class="tg file">Importar áudio… <input id="rimp" type="file" accept="audio/*" multiple hidden></label>
      <button id="rexp" class="tg">Exportar WAV multicanal</button><button id="rexp2" class="tg">Exportar 1 WAV por canal</button><button id="rsyn" class="tg">Gerar sinais de teste</button><button id="rclr" class="tg">Limpar</button><button id="rundo" class="tg" hidden>Desfazer remoção</button>
      <button id="rret" class="tg">Ativar retorno nos canais (rtnsw ON)</button><button id="rret0" class="tg">Voltar entradas analógicas</button><button id="rrec2" class="tg" hidden>Recuperar última gravação</button>
    </div>
    <div class="na" id="rwarn" style="color:#e8a020"></div><div class="na" id="rperf"></div>
    <div id="rtracks"></div>`;
    c.append(root);
    const q = s => root.querySelector(s);
    const fill = async () => { const d = await R.listDevices(); const f = (sel, list, cur) => { sel.innerHTML = '<option value="">Padrão do sistema</option>'; list.forEach(x => { const o = el('option', '', x.label || x.deviceId.slice(0, 8)); o.value = x.deviceId; sel.append(o); }); sel.value = cur; if (!sel.value) { const x = list.find(v => /xr18|x-?air|behringer/i.test(v.label)); if (x) sel.value = x.deviceId; } };
      f(q('#rin'), d.ins, R.inId); f(q('#rout'), d.outs, R.outId); R.inId = q('#rin').value; R.outId = q('#rout').value; };
    q('#rdev').onclick = fill; fill().catch(() => {});
    q('#rin').onchange = e => (R.inId = e.target.value); q('#rout').onchange = e => (R.outId = e.target.value); q('#rmode').value = R.mode; q('#rmode').onchange = e => (R.mode = e.target.value);
    q('#rrec').onclick = () => R.startCapture().catch(e => (R.msg = 'Erro ao gravar: ' + e.message));
    q('#rstop').onclick = () => R.stop(); q('#rplay').onclick = () => R.play(); q('#rpause').onclick = () => R.pause(); q('#rrew').onclick = () => { R.seek(0); };
    q('#rimp').onchange = e => R.importFiles([...e.target.files]).catch(err => (R.msg = 'Falha ao importar: ' + err.message));
    q('#rexp').onclick = R.exportMulti; q('#rexp2').onclick = R.exportEach; q('#rsyn').onclick = () => R.synth(); q('#rclr').onclick = () => { if (R.hasAudio() && !confirm('Apagar TODAS as faixas da sessão?')) return; R.stop(); R.clear(); }; q('#rundo').onclick = R.undoRemove;
    q('#rrec2').onclick = async () => { const ok = await R.recover(); if (!ok) R.msg = 'Nada para recuperar.'; };
    if (XR.storage) XR.storage.recMetaGet().then(m => { if (m && m.frames && !R.hasAudio()) { q('#rrec2').hidden = false; q('#rrec2').textContent = `Recuperar última gravação (${fmtT(m.frames).slice(0, 5)} min)`; } }).catch(() => {});
    q('#rret').onclick = () => R.routeReturns(true); q('#rret0').onclick = () => R.routeReturns(false);
    const list = q('#rtracks'), cvs = [], WCV = 760;
    R.tracks.forEach((t, i) => {
      const row = el('div', 'trk-row'), id = R.stripId(i), col = XR.colorOf(i < 16 ? store.get(id + '/config/color', 0) : 7);
      const nm = el('div', 'tn'); nm.textContent = `${i + 1} ${R.trackName(i)}`; nm.style.background = col.bg; nm.style.color = col.fg;
      const bt = (lbl, cls, fn) => { const b = el('button', 'tb ' + cls, lbl); b.onclick = () => { fn(); b.classList.toggle('on'); }; return b; };
      const arm = bt('R', 'red on', () => (t.arm = !t.arm)), mu = bt('M', '', () => { t.mute = !t.mute; R.updateGains(); }), so = bt('S', 'yel', () => { t.solo = !t.solo; R.updateGains(); });
      const cv = el('canvas', 'wf'); cv.width = WCV; cv.height = 34; cv.onclick = e => { const r = cv.getBoundingClientRect(); R.seek(((e.clientX - r.left) / r.width) * Math.max(R.totalFrames(), SR * 10)); };
      const vu = el('div', 'vu'); vu.append(el('i')); cvs.push({ cv, vu: vu.firstChild, t });
      const fi = el('input'); fi.type = 'file'; fi.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a'; fi.hidden = true; fi.onchange = () => { if (fi.files[0]) R.importToTrack(i, fi.files[0]).catch(err => (R.msg = 'Falha ao importar: ' + err.message)); fi.value = ''; };
      const imp = el('button', 'tb', '📁'); imp.title = 'Carregar um arquivo de áudio nesta faixa'; imp.onclick = () => fi.click();
      const del = el('button', 'tb del', '✕'); del.title = 'Remover o áudio desta faixa'; del.onclick = () => R.removeTrack(i);
      row.ondragover = e => { e.preventDefault(); row.classList.add('drop'); }; row.ondragleave = () => row.classList.remove('drop');
      row.ondrop = e => { e.preventDefault(); row.classList.remove('drop'); const f = e.dataTransfer.files[0]; if (f) R.importToTrack(i, f).catch(err => (R.msg = 'Falha ao importar: ' + err.message)); };
      row.append(nm, arm, mu, so, imp, del, fi, cv, vu); list.append(row);
    });
    const draw = () => {
      const total = Math.max(R.totalFrames(), SR * 10), bins = total / PEAK_BIN;
      cvs.forEach(({ cv, vu, t }) => { const g = cv.getContext('2d'), w = cv.width, h = cv.height; g.fillStyle = '#050505'; g.fillRect(0, 0, w, h); g.fillStyle = '#2fb7d6';
        for (let x = 0; x < w; x++) { const b0 = Math.floor((x / w) * bins), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * bins)); let m = 0; for (let b = b0; b < b1; b++) m = Math.max(m, t.peaks[b] || 0); if (m) g.fillRect(x, h / 2 - m * h / 2, 1, Math.max(1, m * h)); }
        const px = (R.pos / total) * w; g.fillStyle = '#ff4040'; g.fillRect(px, 0, 1.5, h);
        vu.style.width = Math.max(0, Math.min(100, (t.level + 60) / 60 * 100)) + '%'; });
      const P = R.perf, N = XR.perf || {}; q('#rperf').textContent = `Latência (medida): fader→ganho local ${P.faderToGainMs ?? '–'} ms · percepção estimada ${P.estAudibleMs ?? '–'} ms · OSC→eco da mesa ${N.oscRttMs ?? '–'} ms`;
      q('#rtime').textContent = fmtT(R.pos); q('#rlen').textContent = '/ ' + fmtT(R.totalFrames()); q('#rmsg').textContent = R.msg; q('#rwarn').textContent = R.warn || (R.inChannels && R.inChannels < 16 && R.state === 'rec' ? `Entrada expõe só ${R.inChannels} canais: só as faixas 1–${R.inChannels} recebem áudio.` : ''); q('#rundo').hidden = !R.lastRemoved; cvs.forEach(({ t }, k) => { const d = list.children[k] && list.children[k].querySelector('.del'); if (d) d.disabled = !t.frames; });
      q('#rrec').classList.toggle('on', R.state === 'rec'); q('#rplay').classList.toggle('on', R.state === 'play');
    };
    S.ups.push(draw); S.recDraw = draw; R.rec_end = draw; draw();
  };
})();
