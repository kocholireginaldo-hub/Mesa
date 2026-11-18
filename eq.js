/* XR18 Studio — editor de EQ (PEQ/GEQ), curvas de dinâmica */
(function () {
  const XR = window.XR, store = XR.store, el = XR.el, S = XR.ui;
  const FMIN = 20, FMAX = 20000, GR = 15;
  const NAMES4 = ['Low', 'LoMid', 'HiMid', 'High'], NAMES6 = ['Low', 'Low2', 'LoMid', 'HiMid', 'High2', 'High'];
  const COL6 = ['#1cc6d8', '#2a9aa6', '#e0209a', '#38b24d', '#f5a31a', '#e8312a'], COL4 = [COL6[0], COL6[2], COL6[3], COL6[5]];
  const DEF4 = [['LShv', 100], ['PEQ', 400], ['PEQ', 2000], ['HShv', 8000]], DEF6 = [['LShv', 79.6], ['PEQ', 158.9], ['PEQ', 496.6], ['PEQ', 1970], ['PEQ', 5020], ['HShv', 10020]];
  const xOf = (f, w) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w, fOf = (x, w) => FMIN * Math.pow(FMAX / FMIN, x / w);
  const yOf = (g, h) => h / 2 - (g / GR) * (h / 2), gOf = (y, h) => ((h / 2 - y) / (h / 2)) * GR;
  const parseNum = s => { s = String(s).trim().toLowerCase().replace(',', '.'); const m = /^([+-]?\d*\.?\d+)\s*k$/.exec(s); return m ? parseFloat(m[1]) * 1000 : parseFloat(s); };
  XR.parseNum = parseNum;
  XR.getSpectrum = XR.getSpectrum || (() => null);

  XR.buildEq = (id, big) => {
    const nb = XR.eqBands(id), names = nb === 6 ? NAMES6 : NAMES4, cols = nb === 6 ? COL6 : COL4;
    const sec = el('section', 'sec eqsec' + (big ? ' big' : '')); sec.append(el('h3', '', 'EQ'));
    const mode = () => store.get(id + '/eq/mode', 'PEQ');
    const top = el('div', 'eqtop');
    if (big) {
      const onb = XR.W.toggle(id + '/eq/on', 'EQ'), rs = el('button', 'tg', 'RESET'); rs.onclick = () => resetEq(id);
      const modes = el('div', 'modes');
      if (nb === 6) ['PEQ', 'GEQ', 'TEQ'].forEach(m => { const l = el('label', '', `<input type="radio" name="eqm" value="${m}"> ${m}`); l.firstChild.onchange = () => { store.set(id + '/eq/mode', m, { send: false }); S.renderContent(); }; modes.append(l); });
      top.append(onb, rs, modes);
    } else top.append(XR.W.toggle(id + '/eq/on', 'EQ ON'));
    sec.append(top);
    const body = el('div', 'eqbody'); sec.append(body);

    if (big && nb === 6 && mode() === 'GEQ') { buildGeq(id, body); return sec; }
    if (big && nb === 6 && mode() === 'TEQ') { body.append(el('div', 'na', 'TEQ (True EQ): não implementado nesta versão. Use PEQ ou GEQ.')); return sec; }

    const cv = el('canvas', 'eqcv'); cv.width = big ? 1000 : 360; cv.height = big ? 250 : 150; body.append(cv);
    let rtaOn = false, sel = 1;
    const draw = () => {
      const g = cv.getContext('2d'), w = cv.width, h = cv.height; g.clearRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#2b2b2b'; g.lineWidth = 1; g.font = '10px Arial'; g.fillStyle = '#777';
      [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000].forEach(f => { const x = xOf(f, w); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
      for (let d = -15; d <= 15; d += 5) { const y = yOf(d, h); g.strokeStyle = d === 0 ? '#444' : '#262626'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText(d, 3, y - 2); }
      [100, 1000, 10000].forEach(f => g.fillText(XR.fmtHz(f), xOf(f, w) + 2, h - 3));
      if (rtaOn) { const sp = XR.getSpectrum(id); if (sp) { g.beginPath(); g.moveTo(0, h); sp.freqs.forEach((f, i) => { if (f < FMIN) return; const y = h - Math.min(1, Math.max(0, (sp.db[i] + 90) / 90)) * h * 0.9; g.lineTo(xOf(f, w), y); }); g.lineTo(w, h); g.fillStyle = 'rgba(40,160,200,.35)'; g.fill(); } }
      const on = store.get(id + '/eq/on');
      g.beginPath(); for (let x = 0; x <= w; x += 2) { const y = yOf(Math.max(-GR, Math.min(GR, XR.eqResponseDb(id, fOf(x, w)))), h); x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = on ? '#f08a1c' : '#666'; g.lineWidth = 2; g.stroke();
      g.lineTo(w, yOf(0, h)); g.lineTo(0, yOf(0, h)); g.fillStyle = on ? 'rgba(240,138,28,.18)' : 'rgba(120,120,120,.12)'; g.fill();
      for (let b = 1; b <= nb; b++) {
        const t = store.get(`${id}/eq/${b}/type`, 'PEQ'), f = store.get(`${id}/eq/${b}/f`, 1000), gn = store.get(`${id}/eq/${b}/g`, 0), x = xOf(f, w), y = /Cut/.test(t) ? yOf(0, h) : yOf(gn, h);
        g.strokeStyle = cols[b - 1]; g.lineWidth = 1; g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h); g.stroke(); g.globalAlpha = 1;
        g.beginPath(); g.arc(x, y, b === sel ? 14 : 11, 0, 7); g.lineWidth = b === sel ? 3 : 2; g.stroke();
        g.fillStyle = cols[b - 1]; g.beginPath(); g.arc(x, 8, 7, 0, 7); g.fill(); g.fillStyle = '#000'; g.textAlign = 'center'; g.fillText(b, x, 11); g.textAlign = 'left';
      }
    };
    reg(draw); S.eqDraw = () => { if (rtaOn) draw(); };
    function reg(f) { S.ups.push(f); f(); }
    let drag = 0;
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    const hit = (x, y) => { let best = 0, bd = 1e9; for (let b = 1; b <= nb; b++) { const t = store.get(`${id}/eq/${b}/type`, 'PEQ'), px = xOf(store.get(`${id}/eq/${b}/f`, 1000), cv.width), py = /Cut/.test(t) ? yOf(0, cv.height) : yOf(store.get(`${id}/eq/${b}/g`, 0), cv.height), d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = b; } } return bd < 30 ? best : 0; };
    cv.onpointerdown = e => { const [x, y] = pos(e); drag = hit(x, y); if (drag) { sel = drag; cv.setPointerCapture(e.pointerId); draw(); } };
    cv.onpointermove = e => { if (!drag) return; const [x, y] = pos(e), t = store.get(`${id}/eq/${drag}/type`, 'PEQ'); store.set(`${id}/eq/${drag}/f`, Math.min(FMAX, Math.max(FMIN, Math.round(fOf(Math.min(Math.max(x, 0), cv.width), cv.width) * 10) / 10))); if (!/Cut/.test(t)) store.set(`${id}/eq/${drag}/g`, Math.round(Math.min(GR, Math.max(-GR, gOf(y, cv.height))) * 4) / 4); };
    cv.onpointerup = () => (drag = 0);
    cv.onwheel = e => { const [x, y] = pos(e), b = hit(x, y) || sel; e.preventDefault(); const q = store.get(`${id}/eq/${b}/q`, 2); store.set(`${id}/eq/${b}/q`, Math.min(10, Math.max(0.3, Math.round(q * (e.deltaY < 0 ? 1.1 : 0.9) * 10) / 10))); };

    // colunas por banda
    const cols_ = el('div', 'eqcols');
    for (let b = 1; b <= nb; b++) {
      const c = el('div', 'eqcol'), hb = el('button', 'bandbtn', names[b - 1]); hb.style.borderColor = cols[b - 1]; hb.onclick = () => { sel = b; draw(); };
      const pw = el('button', 'pw', '⏻'); pw.title = 'Zera/restaura o ganho da banda'; let memo = 0; pw.onclick = () => { const k = `${id}/eq/${b}/g`, g = store.get(k, 0); if (g) { memo = g; store.set(k, 0); } else store.set(k, memo || 3); };
      const head = el('div', 'bandhead'); head.append(hb, pw); c.append(head);
      const sel_ = el('select'); XR.EQ_TYPES.forEach(t => { const o = el('option', '', t); o.value = t; sel_.append(o); }); sel_.onchange = () => store.set(`${id}/eq/${b}/type`, sel_.value);
      const num = (key, lbl, fmt) => { const r = el('label', 'eqf'), i = el('input'); i.type = 'text'; i.onchange = () => { const v = parseNum(i.value); if (!isNaN(v)) store.set(key, v); else i.value = fmt(store.get(key)); }; r.append(el('span', '', lbl), i); reg(() => { if (document.activeElement !== i) { const v = store.get(key); i.value = v === undefined ? '' : fmt(v); } }); return r; };
      const mrow = el('label', 'eqf'); mrow.append(el('span', '', 'Mode'), sel_); reg(() => (sel_.value = store.get(`${id}/eq/${b}/type`, 'PEQ')));
      c.append(mrow, num(`${id}/eq/${b}/g`, 'Gain', v => (v >= 0 ? '+' : '') + v.toFixed(2)), num(`${id}/eq/${b}/f`, 'Freq', v => XR.fmtHz(v).replace(' ', '')), num(`${id}/eq/${b}/q`, 'Qual', v => v.toFixed(1)));
      cols_.append(c);
    }
    body.append(cols_);
    if (big) {
      const ex = el('div', 'eqextra'), rta = el('button', 'tg', 'RTA'); rta.onclick = () => { rtaOn = !rtaOn; rta.classList.toggle('on', rtaOn); XR.rtaWanted = rtaOn; draw(); };
      ex.append(rta, el('span', 'na', ' RTA mostra o espectro do canal vindo do áudio USB (aba REC) ou arquivos importados.')); body.append(ex);
      reg(() => { const m = mode(); sec.querySelectorAll('input[name=eqm]').forEach(r => (r.checked = r.value === m)); });
    }
    return sec;
  };
  XR.ui.tabs.eq = (c, id) => { const g = el('div', 'one wide'); g.append(XR.buildEq(id, true)); c.append(g); };

  function buildGeq(id, body) {
    const bars = el('div', 'geq'), fr = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
    for (let i = 1; i <= 31; i++) {
      const k = `${id}/geq/${String(i).padStart(2, '0')}`, c = el('div', 'gb'), r = el('input'); r.type = 'range'; r.min = -15; r.max = 15; r.step = 0.5; r.setAttribute('orient', 'vertical'); r.oninput = () => store.set(k, +r.value);
      const v = el('span', 'gv'); c.append(v, r, el('span', 'gf', XR.fmtHz(fr[i - 1]))); bars.append(c);
      S.ups.push(() => { const x = store.get(k, 0); if (document.activeElement !== r) r.value = x; v.textContent = x.toFixed(1); });
    }
    const rs = el('button', 'tg', 'RESET GEQ'); rs.onclick = () => { for (let i = 1; i <= 31; i++) store.set(`${id}/geq/${String(i).padStart(2, '0')}`, 0); };
    body.append(bars, rs); XR.refresh();
  }
  function resetEq(id) {
    const nb = XR.eqBands(id), d = nb === 6 ? DEF6 : DEF4;
    for (let b = 1; b <= nb; b++) { store.set(`${id}/eq/${b}/type`, d[b - 1][0]); store.set(`${id}/eq/${b}/f`, d[b - 1][1]); store.set(`${id}/eq/${b}/g`, 0); store.set(`${id}/eq/${b}/q`, 2); }
  }
  XR.resetEq = resetEq;

  /* ---------- curvas de gate / compressor ---------- */
  XR.drawDynCurve = (cv, id, kind) => {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height, lo = -80, hi = 0; g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const X = d => ((d - lo) / (hi - lo)) * w, Y = d => h - ((d - lo) / (hi - lo)) * h;
    g.strokeStyle = '#262626'; g.fillStyle = '#666'; g.font = '10px Arial'; for (let d = -80; d <= 0; d += 20) { g.beginPath(); g.moveTo(X(d), 0); g.lineTo(X(d), h); g.moveTo(0, Y(d)); g.lineTo(w, Y(d)); g.stroke(); g.fillText(d, X(d) + 2, h - 3); }
    g.strokeStyle = '#444'; g.beginPath(); g.moveTo(X(lo), Y(lo)); g.lineTo(X(hi), Y(hi)); g.stroke();
    const on = store.get(`${id}/${kind}/on`), thr = store.get(`${id}/${kind}/thr`, -20); let f;
    if (kind === 'gate') {
      const range = store.get(id + '/gate/range', 60), mode = store.get(id + '/gate/mode', 'GATE'), ratio = { EXP2: 2, EXP3: 3, EXP4: 4 }[mode] || 100;
      f = x => (x >= thr ? x : Math.max(x - range, thr + (x - thr) * ratio));
    } else {
      const r = store.get(id + '/dyn/ratio', 3), kn = store.get(id + '/dyn/knee', 0) * 3, mg = store.get(id + '/dyn/mgain', 0), mode = store.get(id + '/dyn/mode', 'COMP');
      f = x => { let y; if (mode === 'EXP') y = x >= thr ? x : thr + (x - thr) * r; else if (kn > 0 && Math.abs(x - thr) <= kn / 2) { const t = x - thr + kn / 2; y = x + (1 / r - 1) * t * t / (2 * kn); } else y = x > thr ? thr + (x - thr) / r : x; return y + mg; };
    }
    g.beginPath(); for (let x = lo; x <= hi; x += 1) { const y = Math.max(lo, Math.min(hi, f(x))); x === lo ? g.moveTo(X(x), Y(y)) : g.lineTo(X(x), Y(y)); } g.strokeStyle = on ? '#f08a1c' : '#777'; g.lineWidth = 2; g.stroke();
    g.strokeStyle = '#1cc6d8'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(thr), 0); g.lineTo(X(thr), h); g.stroke(); g.setLineDash([]);
  };
})();
