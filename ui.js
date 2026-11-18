/* XR18 Studio — interface: abas, strips, painel direito, seções de canal */
(function () {
  const XR = window.XR, store = XR.store, $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  XR.el = el; XR.$ = $;

  const S = (XR.ui = { tab: 'eq', sel: 'lr', layer: null /* null = principal, 1..10 = envio p/ bus */, solo: {}, ups: [], tabs: {} });

  /* ---------- widgets ligados ao store ---------- */
  const reg = f => { S.ups.push(f); f(); };
  const schedule = (() => { let p = false; return () => { if (p) return; p = true; requestAnimationFrame(() => { p = false; S.ups.forEach(f => { try { f(); } catch (e) { console.error(e); } }); updateStrips(); }); }; })();
  store.on(schedule); XR.refresh = schedule;
  const fDb = v => XR.fmtDb(v) + ' dB', fHz = v => XR.fmtHz(v) + ' Hz', fMs = v => (v < 10 ? v.toFixed(2) : v.toFixed(0)) + ' ms', fN = v => (Math.round(v * 10) / 10).toString();
  XR.fmt = { db: fDb, hz: fHz, ms: fMs, n: fN, pct: v => v.toFixed(0) + ' %' };

  const W = (XR.W = {
    slider(key, label, fmt) {
      const c = XR.codecFor(key), w = el('label', 'param'), inp = el('input'), val = el('span', 'pv');
      inp.type = 'range'; inp.min = 0; inp.max = 1000;
      w.append(el('span', 'pl', label), inp, val);
      inp.oninput = () => store.set(key, c.dec(inp.value / 1000));
      reg(() => { const v = store.get(key); if (v === undefined) { val.textContent = '–'; return; } if (document.activeElement !== inp) inp.value = Math.round(c.enc(isFinite(v) ? v : -90) * 1000); val.textContent = fmt(v); });
      return w;
    },
    toggle(key, label, cls) {
      const b = el('button', 'tg ' + (cls || ''), label); b.onclick = () => store.set(key, !store.get(key));
      reg(() => b.classList.toggle('on', !!store.get(key))); return b;
    },
    select(key, label, opts) {
      const w = el('label', 'param'), s = el('select');
      opts.forEach(o => { const op = el('option', '', String(o)); op.value = String(o); s.append(op); });
      s.onchange = () => { const raw = s.value; const o = opts.find(x => String(x) === raw); store.set(key, o); };
      w.append(el('span', 'pl', label), s, el('span', 'pv'));
      reg(() => { const v = store.get(key); if (v !== undefined) s.value = String(v); });
      return w;
    },
    text(key, label, ph) {
      const w = el('label', 'param'), i = el('input'); i.type = 'text'; i.maxLength = 12; i.placeholder = ph || '';
      i.onchange = () => store.set(key, i.value);
      w.append(el('span', 'pl', label), i, el('span', 'pv'));
      reg(() => { if (document.activeElement !== i) i.value = store.get(key, ''); }); return w;
    },
    ro(label, fn) { const w = el('div', 'param'), v = el('span', 'pv wide'); w.append(el('span', 'pl', label), el('span'), v); reg(() => (v.textContent = fn())); return w; },
    sec(title, ...kids) { const s = el('section', 'sec'); s.append(el('h3', '', title), ...kids); return s; }
  });

  /* ---------- seções ---------- */
  const isCh = id => /^ch\//.test(id), hasDyn = id => /^(ch|bus|lr)/.test(id) && !/^fxsend/.test(id), hasGate = isCh;
  const na = t => { const d = el('div', 'na', t); return d; };

  S.secInput = id => {
    if (/^(bus|lr|fxsend)/.test(id)) return W.sec('Input', na('Sem entrada de pré-amplificador neste canal.'));
    const kids = [];
    if (isCh(id)) {
      const n = id.slice(3);
      kids.push(W.ro('Fonte', () => (store.get(id + '/preamp/rtnsw') ? 'USB ' + store.get(id + '/config/rtnsrc', '') : store.get(id + '/config/insrc', '') || 'Entrada ' + n)));
      kids.push(W.toggle(id + '/preamp/rtnsw', 'Retorno USB (reprodução)'));
      kids.push(W.slider(`headamp/${n}/gain`, 'Ganho (headamp)', fDb));
      kids.push(W.toggle(`headamp/${n}/phantom`, '+48V'));
      kids.push(W.slider(id + '/preamp/rtntrim', 'Trim', fDb));
      kids.push(W.toggle(id + '/preamp/hpon', 'Low cut'));
      kids.push(W.slider(id + '/preamp/hpf', 'Frequência low cut', fHz));
    } else kids.push(W.slider(id + '/preamp/rtntrim', 'Trim', fDb));
    kids.push(W.toggle(id + '/preamp/invert', 'Inverter fase (Ø)'));
    kids.push(W.text(id + '/config/name', 'Nome'));
    return W.sec('Input', ...kids);
  };

  S.secGate = id => {
    if (!hasGate(id)) return W.sec('Gate', na('Gate disponível apenas nos canais 1–16.'));
    const cv = el('canvas', 'curve'); cv.width = 220; cv.height = 220;
    reg(() => XR.drawDynCurve(cv, id, 'gate'));
    return W.sec('Gate', W.toggle(id + '/gate/on', 'Gate ON'), W.select(id + '/gate/mode', 'Modo', XR.GATE_MODES), cv,
      W.slider(id + '/gate/thr', 'Threshold', fDb), W.slider(id + '/gate/range', 'Range', fDb), W.slider(id + '/gate/attack', 'Attack', fMs),
      W.slider(id + '/gate/hold', 'Hold', fMs), W.slider(id + '/gate/release', 'Release', fMs),
      W.toggle(id + '/gate/filter/on', 'Filtro side-chain'), W.select(id + '/gate/filter/type', 'Tipo', XR.FILTERS), W.slider(id + '/gate/filter/f', 'Freq. filtro', fHz));
  };

  S.secComp = id => {
    if (!hasDyn(id)) return W.sec('Comp', na('Sem compressor neste canal.'));
    const cv = el('canvas', 'curve'); cv.width = 220; cv.height = 220;
    reg(() => XR.drawDynCurve(cv, id, 'dyn'));
    return W.sec('Compressor', W.toggle(id + '/dyn/on', 'Comp ON'), W.select(id + '/dyn/mode', 'Modo', ['COMP', 'EXP']), W.select(id + '/dyn/det', 'Detecção', ['PEAK', 'RMS']),
      W.select(id + '/dyn/env', 'Envelope', ['LIN', 'LOG']), cv, W.slider(id + '/dyn/thr', 'Threshold', fDb), W.select(id + '/dyn/ratio', 'Ratio', XR.RATIOS),
      W.slider(id + '/dyn/knee', 'Knee', fN), W.slider(id + '/dyn/mgain', 'Make-up', fDb), W.slider(id + '/dyn/attack', 'Attack', fMs),
      W.slider(id + '/dyn/hold', 'Hold', fMs), W.slider(id + '/dyn/release', 'Release', fMs), W.slider(id + '/dyn/mix', 'Mix', XR.fmt.pct),
      W.toggle(id + '/dyn/auto', 'Auto'), W.toggle(id + '/dyn/filter/on', 'Filtro side-chain'), W.select(id + '/dyn/filter/type', 'Tipo', XR.FILTERS), W.slider(id + '/dyn/filter/f', 'Freq. filtro', fHz));
  };

  S.secSends = id => {
    if (!/^(ch|rtn)\//.test(id)) return W.sec('Sends', na('Sends disponíveis para canais e retornos.'));
    const rows = XR.sendBuses.map((b, i) => {
      const nn = String(i + 1).padStart(2, '0'), r = el('div', 'sendrow');
      const nm = el('span', 'sn'); reg(() => { nm.textContent = (i < 6 ? 'Bus ' + (i + 1) : 'FX ' + (i - 5)) + ' · ' + XR.name(b.id); });
      r.append(nm, W.slider(`${id}/mix/${nn}/level`, '', fDb), W.toggle(`${id}/mix/${nn}/on`, 'ON'), W.select(`${id}/mix/${nn}/tap`, '', XR.TAPS));
      return r;
    });
    return W.sec('Sends', ...rows);
  };

  S.secMain = id => {
    const k = [];
    if (id !== 'lr') k.push(W.toggle(id + '/mix/on', 'Canal ON'));
    k.push(W.slider(id + '/mix/fader', 'Fader', fDb));
    if (id !== 'lr' && !/^fxsend/.test(id)) k.push(W.slider(id + '/mix/pan', 'Pan', v => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v)));
    if (id !== 'lr' && !/^fxsend/.test(id)) k.push(W.toggle(id + '/mix/lr', 'Assinar ao Main LR'));
    if (id !== 'lr' && !/^fxsend/.test(id)) {
      const g = el('div', 'grp'); g.append(el('b', '', 'DCA: '));
      for (let i = 1; i <= 4; i++) g.append(maskBtn(id + '/grp/dca', i, 'DCA ' + i));
      const m = el('div', 'grp'); m.append(el('b', '', 'Mute group: '));
      for (let i = 1; i <= 4; i++) m.append(maskBtn(id + '/grp/mute', i, 'M' + i));
      k.push(g, m);
    }
    k.push(W.text(id + '/config/name', 'Nome'));
    const c = el('label', 'param'), cs = el('select');
    ['OFF', 'RD', 'GN', 'YE', 'BL', 'MG', 'CY', 'WH', 'OFFi', 'RDi', 'GNi', 'YEi', 'BLi', 'MGi', 'CYi', 'WHi'].forEach((n, i) => { const o = el('option', '', n); o.value = i; cs.append(o); });
    cs.onchange = () => store.set(id + '/config/color', +cs.value); c.append(el('span', 'pl', 'Cor'), cs, el('span')); reg(() => (cs.value = store.get(id + '/config/color', 0))); k.push(c);
    return W.sec('Main / Assign', ...k);
  };
  const maskBtn = (key, bit, label) => { const b = el('button', 'tg', label); b.onclick = () => store.set(key, store.get(key, 0) ^ (1 << (bit - 1))); reg(() => b.classList.toggle('on', !!(store.get(key, 0) & (1 << (bit - 1))))); return b; };

  /* ---------- abas ---------- */
  const TABS = [['mixer', 'Mixer', '▥'], ['channel', 'Channel', '☰'], ['input', 'Input', '⇥'], ['gate', 'Gate', '◢'], ['eq', 'EQ', '∿'], ['comp', 'Comp', '◣'], ['sends', 'Sends', '⇉'], ['main', 'Main', '▤'], ['fx', 'FX', '≋'], ['meter', 'Meter', '▮'], ['rec', 'REC', '●'], ['ai', 'IA', '✦']];
  S.tabs.mixer = c => { c.append(el('div', 'na big', 'Visão Mixer: use os faders abaixo. Clique no nome de um canal para editá-lo nas outras abas.')); };
  S.tabs.channel = (c, id) => { const g = el('div', 'chgrid'); g.append(S.secInput(id), S.secGate(id), S.secComp(id), XR.buildEq(id, false), S.secSends(id), S.secMain(id)); c.append(g); };
  S.tabs.input = (c, id) => { const g = el('div', 'one'); g.append(S.secInput(id)); c.append(g); };
  S.tabs.gate = (c, id) => { const g = el('div', 'one'); g.append(S.secGate(id)); c.append(g); };
  S.tabs.comp = (c, id) => { const g = el('div', 'one'); g.append(S.secComp(id)); c.append(g); };
  S.tabs.sends = (c, id) => { const g = el('div', 'one wide'); g.append(S.secSends(id)); c.append(g); };
  S.tabs.main = (c, id) => {
    const g = el('div', 'chgrid'); g.append(S.secMain(id));
    const d = [];
    for (let i = 1; i <= 4; i++) { const r = el('div', 'sendrow'); r.append(W.text(`dca/${i}/config/name`, 'DCA ' + i), W.slider(`dca/${i}/fader`, '', fDb), W.toggle(`dca/${i}/on`, 'ON')); d.push(r); }
    const m = []; for (let i = 1; i <= 4; i++) m.push(W.toggle('config/mute/' + i, 'Mute group ' + i, 'red'));
    g.append(W.sec('DCA groups', ...d), W.sec('Mute groups', ...m)); c.append(g);
  };
  S.tabs.fx = c => {
    const g = el('div', 'chgrid');
    for (let n = 1; n <= 4; n++) {
      const kids = [W.ro('Efeito', () => store.get(`fx/${n}/type`, '?')), W.toggle(`fx/${n}/on`, 'Ativo'), W.slider(`fxsend/${n}/mix/fader`, 'Master send', fDb), W.text(`fxsend/${n}/config/name`, 'Nome send'), W.slider(`rtn/${n}/mix/fader`, 'Retorno', fDb)];
      const p = el('div', 'fxpar'); reg(() => { const a = store.get(`fx/${n}/par`, []); const t = store.get(`fx/${n}/type`, ''); p.innerHTML = /^GEQ/.test(t) ? '<div class="bars">' + a.slice(0, 31).map(v => `<i style="height:${50 + v * 3}%"></i>`).join('') + '</div>' : 'Parâmetros: ' + a.filter((v, i) => i < 24).join(' · '); });
      kids.push(p, el('div', 'na', 'Edição dos parâmetros internos do efeito: somente leitura nesta versão.'));
      g.append(W.sec('FX ' + n, ...kids));
    }
    c.append(g);
  };
  S.tabs.meter = c => { const cv = el('canvas', 'bigmeter'); cv.width = 1100; cv.height = 340; c.append(cv); S.bigMeter = cv; };

  function renderTabs() {
    const t = $('#tabs'); t.innerHTML = '';
    TABS.forEach(([id, label, ic]) => { const b = el('button', 'tab' + (S.tab === id ? ' on' : ''), `<span class="ic">${ic}</span>${label}`); b.onclick = () => { S.tab = id; renderTabs(); renderContent(); }; t.append(b); });
    const sp = el('span', 'tspacer'); t.append(sp);
  }
  function renderContent() {
    S.ups = []; S.bigMeter = null; S.eqCanvas = null;
    const c = $('#content'); c.innerHTML = ''; document.body.className = 'tab-' + S.tab;
    (S.tabs[S.tab] || (() => {}))(c, S.sel);
    $('#selbox').textContent = XR.name(S.sel); const col = XR.colorOf(store.get(S.sel + '/config/color', 7));
    $('#selbox').style.background = col.bg; $('#selbox').style.color = col.fg; $('#sellabel').textContent = XR.name(S.sel).slice(0, 8);
    schedule();
  }
  S.select = id => { S.sel = id; renderStripsSel(); renderContent(); };

  /* ---------- strips ---------- */
  const faderRange = { top: 8, bottom: 8 };
  function buildStrip(s, big) {
    const d = el('div', 'strip'); d.dataset.id = s.id;
    d.innerHTML = `<button class="nm"></button><button class="solo">Solo</button><div class="db"></div><div class="circ"><i class="c1"></i><i class="c2"></i></div>
      <div class="fad"><div class="scale"></div><div class="trk"></div><div class="knob"></div><canvas class="vu" width="6" height="200"></canvas></div><button class="mute">Mute</button><div class="num">${s.label || ''}</div>`;
    d.querySelector('.nm').onclick = () => S.select(s.id);
    d.querySelector('.solo').onclick = () => { S.solo[s.id] = !S.solo[s.id]; if (s.kind === 'ch') store.transport && store.transport.send('/-stat/solosw/' + s.id.slice(3), [{ t: 'i', v: S.solo[s.id] ? 1 : 0 }]); schedule(); };
    d.querySelector('.mute').onclick = () => { if (s.id === 'lr' || s.kind !== 'fxsend') store.set(s.id + '/mix/on', !store.get(s.id + '/mix/on', true)); };
    const fad = d.querySelector('.fad'); let drag = false;
    const key = () => faderKey(s.id);
    const setFromY = ev => { XR.perf.uiAt = performance.now(); const r = fad.getBoundingClientRect(), y = Math.min(Math.max(ev.clientY - r.top - faderRange.top, 0), r.height - faderRange.top - faderRange.bottom); const f = 1 - y / (r.height - faderRange.top - faderRange.bottom); store.set(key(), f < 0.003 ? -Infinity : Math.round(XR.faderToDb(f) * 2) / 2); };
    fad.onpointerdown = ev => { // toque: só agarra o fader se tocar perto do botão (rolagem acidental não move o fader)
      if (ev.pointerType === 'touch') { const kb = d.querySelector('.knob').getBoundingClientRect(); if (Math.abs(ev.clientY - (kb.top + kb.height / 2)) > 44) return; }
      drag = true; fad.setPointerCapture(ev.pointerId); setFromY(ev); };
    fad.onpointermove = ev => { if (drag) setFromY(ev); }; fad.onpointerup = fad.onpointercancel = () => (drag = false);
    fad.ondblclick = () => store.set(key(), 0);
    const sc = d.querySelector('.scale'); [10, 5, 0, -5, -10, -20, -30, -50].forEach(v => { const t = el('span', '', (v > 0 ? '' : '') + Math.abs(v)); t.style.top = 100 - XR.dbToFader(v) * 100 + '%'; sc.append(t); });
    return d;
  }
  function faderKey(id) {
    const s = XR.byId(id);
    if (S.layer && /^(ch|rtn)\//.test(id)) return `${id}/mix/${String(S.layer).padStart(2, '0')}/level`;
    return id + '/mix/fader';
  }
  function renderStrips() {
    const c = $('#strips'); c.innerHTML = ''; XR.STRIPS.forEach(s => c.append(buildStrip(s)));
    const l = $('#lrcol'); l.innerHTML = ''; l.append(buildStrip(XR.LR)); renderStripsSel();
  }
  function renderStripsSel() { document.querySelectorAll('.strip').forEach(d => d.classList.toggle('sel', d.dataset.id === S.sel)); }
  function updateStrips() {
    document.querySelectorAll('.strip').forEach(d => {
      const id = d.dataset.id, s = XR.byId(id), k = faderKey(id), v = store.get(k), col = XR.colorOf(store.get(id + '/config/color', 0));
      const nm = d.querySelector('.nm'); nm.textContent = XR.name(id); nm.style.background = col.bg; nm.style.color = col.fg; nm.style.borderColor = col.bd;
      d.querySelector('.db').textContent = v === undefined ? '' : XR.fmtDb(v);
      d.querySelector('.knob').style.top = `calc(${faderRange.top}px + (100% - ${faderRange.top + faderRange.bottom}px) * ${1 - (v === undefined ? 0 : XR.dbToFader(v))})`;
      const muted = !store.get(id + '/mix/on', true), gm = XR.groupMuted(id);
      d.querySelector('.mute').classList.toggle('on', muted && !gm); d.classList.toggle('dim', muted);
      d.querySelector('.solo').classList.toggle('on', !!S.solo[id]);
      const dm = store.get(id + '/grp/dca', 0), c1 = d.querySelector('.c1'); const g = dm ? Math.log2(dm & -dm) + 1 : 0; c1.textContent = g || ''; c1.style.visibility = g ? 'visible' : 'hidden';
      d.querySelector('.c2').classList.toggle('act', gm);
      d.classList.toggle('layer', !!S.layer && !/^(ch|rtn)\//.test(id) && id !== 'lr');
    });
  }
  XR.updateStrips = updateStrips;

  /* ---------- painel direito ---------- */
  function buildRight() {
    const t1 = $('#toolbar1'), t2 = $('#toolbar2');
    const tb = (p, ic, lb, fn) => { const b = el('button', 'tbtn', `<span>${ic}</span>${lb}`); b.onclick = fn; p.append(b); return b; };
    tb(t1, '⚙', 'Setup', () => XR.modal('Setup / Conexão', XR.setupModal)); tb(t1, '⇅', 'In/Out', () => XR.modal('In/Out · Roteamento', XR.routingModal));
    tb(t1, '🔧', 'Utility', () => XR.modal('Utility', XR.utilityModal)); tb(t1, '⤢', 'Resize', () => document.body.classList.toggle('compact'));
    tb(t2, '💾', 'Save', () => XR.saveScene()); tb(t2, '📂', 'Load', () => XR.loadSceneDialog()); tb(t2, '⎘', 'Copy', () => XR.copyStrip()); tb(t2, '📋', 'Paste', () => XR.pasteStrip());
    const d = $('#dcabtn'); for (let i = 1; i <= 4; i++) { const b = el('button', 'sq', i); b.title = 'Atribuir canal selecionado ao DCA ' + i; b.onclick = () => { if (/^(ch|rtn|bus)/.test(S.sel)) store.set(S.sel + '/grp/dca', store.get(S.sel + '/grp/dca', 0) ^ (1 << (i - 1))); }; d.append(b); reg2(() => b.classList.toggle('on', !!(store.get(S.sel + '/grp/dca', 0) & (1 << (i - 1))))); }
    const m = $('#mutebtn'); for (let i = 1; i <= 4; i++) { const b = el('button', 'sq red', i); b.onclick = () => { store.set('config/mute/' + i, !store.get('config/mute/' + i)); XR.applyMuteGroups(); }; m.append(b); reg2(() => b.classList.toggle('on', !!store.get('config/mute/' + i))); }
    $('#clrsolo').onclick = () => { S.solo = {}; store.transport && store.transport.send('/-stat/solosw/01', [{ t: 'i', v: 0 }]); schedule(); };
    const bb = $('#busbtns');
    const lay = (id, layerN, b) => { b.onclick = () => { S.layer = layerN; $('#mainlr').classList.toggle('on', !layerN); document.querySelectorAll('#busbtns .bb').forEach(x => x.classList.toggle('on', x === b)); S.sel = id; renderStripsSel(); renderContent(); }; };
    XR.sendBuses.forEach((b, i) => { const x = el('button', 'bb', ''); x.dataset.id = b.id; lay(b.id, i + 1, x); bb.append(x); reg2(() => { const c = XR.colorOf(store.get(b.id + '/config/color', 0)); x.textContent = XR.name(b.id); x.style.borderLeftColor = c.bd; }); });
    $('#mainlr').onclick = () => { S.layer = null; document.querySelectorAll('#busbtns .bb').forEach(x => x.classList.remove('on')); $('#mainlr').classList.add('on'); S.select('lr'); };
    $('#amx').onclick = () => store.set('config/amixenable', 'ON OFF');
  }
  const right = []; const reg2 = f => { right.push(f); f(); }; store.on(() => requestAnimationFrame(() => right.forEach(f => f())));

  /* ---------- modais ---------- */
  XR.modal = (title, fn) => { $('#mtitle').textContent = title; const b = $('#mbody'); b.innerHTML = ''; fn(b); $('#modal').hidden = false; };
  $('#mclose').onclick = () => ($('#modal').hidden = true);

  S.init = () => { renderTabs(); renderStrips(); buildRight(); renderContent(); store.on(k => { if (k === '*') { renderStrips(); renderContent(); } }); };
  S.renderContent = renderContent;
})();
