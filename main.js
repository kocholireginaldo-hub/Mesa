/* XR18 Studio — inicialização, cenas (.scn), conexão, modais, laço de medidores */
(function () {
  const XR = window.XR, store = XR.store, el = XR.el, S = XR.ui, $ = XR.$;

  /* ---------- fila de envio com coalescência (evita inundar a UDP da mesa) ---------- */
  const q = new Map(); let timer = 0; const rawSend = XR.net.send.bind(XR.net);
  XR.net.send = (addr, args) => { q.set(addr + (args && args.length ? (args.length > 1 ? Math.random() : '') : '#leitura'), [addr, args]); /* leitura (sem argumentos) não pode substituir um ajuste pendente do mesmo endereço */ if (!timer) timer = setInterval(pump, 5); };
  function pump() { let n = 0; for (const [k, [a, g]] of q) { rawSend(a, g); q.delete(k); if (++n >= 6) break; } if (!q.size) { clearInterval(timer); timer = 0; } }

  /* ---------- gravar .scn no formato do X AIR Edit ---------- */
  const g = (k, d) => store.get(k, d), pad = (v, n) => String(v).padStart(n);
  const fdb = v => pad(!isFinite(v) ? '-oo' : (v < 0 ? '-' : '+') + Math.abs(v).toFixed(1), 5);
  const fsg = v => { const a = Math.abs(v); return (v < 0 ? '-' : '') + (a >= 1000 ? Math.round(a) : a >= 100 ? a.toFixed(1) : a >= 10 ? a.toFixed(1) : a.toFixed(2)); };
  const fgain = v => (v < 0 ? '-' : '+') + (Math.abs(v) >= 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(2));
  const ffreq = f => (f >= 1000 ? Math.floor(f / 1000) + 'k' + pad(Math.round((f % 1000) / 10), 2).replace(' ', '0') : f.toFixed(1));
  const fq = q_ => (q_ >= 10 ? '10' : q_.toFixed(1)), onoff = v => (v ? 'ON' : 'OFF'), fpan = v => (v < 0 ? '-' : '+') + Math.round(Math.abs(v || 0));
  const bin = v => '%' + (v | 0).toString(2).padStart(4, '0'), qn = s => '"' + (s || '') + '"';
  const fratio = r => (r >= 10 ? String(Math.round(r)) : r.toFixed(1));
  XR.writeScn = () => {
    const L = []; const w = (p, ...v) => L.push('/' + p + ' ' + v.join(' '));
    ['chlink', 'buslink', 'linkcfg', 'solo', 'amixenable', 'amixlock'].forEach(k => g('config/' + k) !== undefined && w('config/' + k, g('config/' + k)));
    w('config/mute', [1, 2, 3, 4].map(i => onoff(g('config/mute/' + i))).join(' '));
    const dyn = id => { const d = id + '/dyn/'; w(id + '/dyn', onoff(g(d + 'on')), g(d + 'mode', 'COMP'), g(d + 'det', 'PEAK'), g(d + 'env', 'LOG'), fdb(g(d + 'thr', 0)).trim(), fratio(g(d + 'ratio', 3)), Math.round(g(d + 'knee', 0)), fsg(g(d + 'mgain', 0)), Math.round(g(d + 'attack', 10)), fsg(g(d + 'hold', 10)), Math.round(g(d + 'release', 100)), Math.round(g(d + 'mix', 100)), ...(g(d + 'keysrc') !== undefined ? [g(d + 'keysrc')] : []), onoff(g(d + 'auto'))); w(id + '/dyn/filter', onoff(g(d + 'filter/on')), g(d + 'filter/type', '3.0'), ffreq(g(d + 'filter/f', 200))); };
    const eq = (id, n, mode) => { w(id + '/eq', onoff(g(id + '/eq/on')), ...(mode ? [g(id + '/eq/mode', 'PEQ')] : [])); for (let b = 1; b <= n; b++) w(`${id}/eq/${b}`, g(`${id}/eq/${b}/type`, 'PEQ'), ffreq(g(`${id}/eq/${b}/f`, 1000)), fgain(g(`${id}/eq/${b}/g`, 0)), fq(g(`${id}/eq/${b}/q`, 2))); };
    const geq = id => w(id + '/geq', Array.from({ length: 31 }, (_, i) => g(id + '/geq/' + String(i + 1).padStart(2, '0'), 0).toFixed(1)).join(' '));
    const mixn = (id, pairs) => { for (let i = 1; i <= 10; i++) { const k = `${id}/mix/${String(i).padStart(2, '0')}/`; w(`${id}/mix/${String(i).padStart(2, '0')}`, fdb(g(k + 'level', -Infinity)), onoff(g(k + 'on')), g(k + 'tap', 'POST'), ...(g(k + 'pan') !== undefined && i <= 5 && i % 2 ? [fpan(g(k + 'pan'))] : [])); } };
    const grp = id => w(id + '/grp', bin(g(id + '/grp/dca', 0)), bin(g(id + '/grp/mute', 0)));
    XR.STRIPS.filter(s => s.kind === 'ch').forEach(s => { const id = s.id, n = id.slice(3);
      w(id + '/config', qn(g(id + '/config/name')), g(id + '/config/color', 0), g(id + '/config/insrc', 'In' + n), g(id + '/config/rtnsrc', 'U' + n));
      w(id + '/preamp', fdb(g(id + '/preamp/rtntrim', 0)), onoff(g(id + '/preamp/rtnsw')), onoff(g(id + '/preamp/invert')), onoff(g(id + '/preamp/hpon')), pad(Math.round(g(id + '/preamp/hpf', 20)), 3));
      const gt = id + '/gate/'; w(id + '/gate', onoff(g(gt + 'on')), g(gt + 'mode', 'GATE'), fdb(g(gt + 'thr', -80)).trim(), fsg(g(gt + 'range', 60)).replace(/\.00$/, '.0'), Math.round(g(gt + 'attack', 10)), fsg(g(gt + 'hold', 50)), Math.round(g(gt + 'release', 100)), g(gt + 'keysrc', 'SELF'));
      w(id + '/gate/filter', onoff(g(gt + 'filter/on')), g(gt + 'filter/type', '3.0'), ffreq(g(gt + 'filter/f', 200)));
      dyn(id); w(id + '/insert', 'OFF OFF'); eq(id, 4, false);
      w(id + '/mix', onoff(g(id + '/mix/on', true)), fdb(g(id + '/mix/fader', -Infinity)), onoff(g(id + '/mix/lr', true)), fpan(g(id + '/mix/pan', 0))); mixn(id); grp(id); w(id + '/automix', onoff(g(id + '/automix/on')), fdb(g(id + '/automix/weight', 0)).trim()); });
    ['aux', '1', '2', '3', '4'].forEach(k => { const id = 'rtn/' + k;
      w(id + '/config', qn(g(id + '/config/name')), g(id + '/config/color', 0), g(id + '/config/src', 'U0102'));
      w(id + '/preamp', fdb(g(id + '/preamp/rtntrim', 0)), onoff(g(id + '/preamp/invert'))); eq(id, 4, false);
      w(id + '/mix', onoff(g(id + '/mix/on', true)), fdb(g(id + '/mix/fader', -Infinity)), onoff(g(id + '/mix/lr', true)), fpan(g(id + '/mix/pan', 0))); mixn(id); grp(id); });
    for (let b = 1; b <= 6; b++) { const id = 'bus/' + b; w(id + '/config', qn(g(id + '/config/name')), g(id + '/config/color', 0)); dyn(id); w(id + '/insert', 'OFF OFF'); eq(id, 6, true); geq(id); w(id + '/mix', onoff(g(id + '/mix/on', true)), fdb(g(id + '/mix/fader', 0)), onoff(g(id + '/mix/lr')), fpan(g(id + '/mix/pan', 0))); grp(id); }
    for (let f = 1; f <= 4; f++) { const id = 'fxsend/' + f; w(id + '/config', qn(g(id + '/config/name')), g(id + '/config/color', 0)); w(id + '/mix', onoff(g(id + '/mix/on', true)), fdb(g(id + '/mix/fader', 0))); grp(id); }
    w('lr/config', qn(g('lr/config/name', 'LR')), g('lr/config/color', 0)); dyn('lr'); w('lr/insert', 'OFF OFF'); eq('lr', 6, true); geq('lr'); w('lr/mix', onoff(g('lr/mix/on', true)), fdb(g('lr/mix/fader', 0)), fpan(g('lr/mix/pan', 0)));
    for (let d = 1; d <= 4; d++) { w('dca/' + d, onoff(g(`dca/${d}/on`, true)), fdb(g(`dca/${d}/fader`, 0))); w(`dca/${d}/config`, qn(g(`dca/${d}/config/name`)), g(`dca/${d}/config/color`, 0)); }
    for (let f = 1; f <= 4; f++) { w('fx/' + f, g(`fx/${f}/type`, 'HALL'), onoff(g(`fx/${f}/on`))); w(`fx/${f}/par`, (g(`fx/${f}/par`, []) || []).map(v => (v === true ? 'ON' : v === false ? 'OFF' : v)).join(' ')); }
    Object.keys(store.d).filter(k => k.startsWith('routing/')).sort().forEach(k => w(k, g(k)));
    for (let h = 1; h <= 24; h++) { const k = 'headamp/' + String(h).padStart(2, '0') + '/'; if (g(k + 'gain') === undefined) continue; w(k.slice(0, -1), fdb(g(k + 'gain')), ...(h <= 16 ? [onoff(g(k + 'phantom'))] : [])); }
    return L.join('\n') + '\n';
  };
  const download = (text, name) => { const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; document.body.append(a); a.click(); setTimeout(() => a.remove(), 500); };
  XR.saveScene = () => download(XR.writeScn(), 'cena_xr18_studio.scn');
  XR.loadSceneText = (t, toMixer) => { const o = XR.parseScn(t); XR.store.load(o, !!toMixer); S.renderContent(); };
  XR.loadSceneDialog = () => { const i = el('input'); i.type = 'file'; i.accept = '.scn,.txt'; i.onchange = async () => { const t = await i.files[0].text(); const live = XR.net.mode === 'live'; XR.loadSceneText(t, live && confirm('Enviar esta cena para a mesa? Isso sobrescreve os ajustes atuais da XR18.')); }; i.click(); };

  XR.clip = null;
  XR.copyStrip = () => { const id = S.sel, d = {}; for (const k in store.d) if (k.startsWith(id + '/') && /\/(eq|gate|dyn|preamp)\//.test(k.slice(id.length))) d[k.slice(id.length)] = store.d[k]; XR.clip = { from: id, d }; };
  XR.pasteStrip = () => { if (!XR.clip) return; const id = S.sel, ch = {}; for (const k in XR.clip.d) { if (/eq\/[5-6]\//.test(k) && XR.eqBands(id) < 6) continue; if (/gate|preamp\/(rtnsw)/.test(k) && !/^ch/.test(id)) continue; ch[id + k] = XR.clip.d[k]; } store.apply(ch); };

  /* ---------- modais ---------- */
  XR.setupModal = b => {
    const h = location.protocol.startsWith('http') ? location.hostname : 'localhost';
    b.innerHTML = `<p>O USB da XR18 carrega <b>áudio</b> (gravação/retorno). O <b>controle</b> (faders, EQ…) vai pela <b>rede</b> (Wi-Fi/cabo, OSC porta 10024). Use os dois ao mesmo tempo.</p>
    <label class="mrow">Ponte (PC) <input id="mb" value="${(XR.storage && XR.storage.getSync('bridge')) || 'ws://' + h + ':8765'}"></label>
    <label class="mrow">IP da mesa <input id="mip" placeholder="192.168.0.50" value="${(XR.storage && XR.storage.getSync('ip')) || ''}"></label>
    <div class="mrow"><button id="mdisc" class="tg">Descobrir mesa</button><button id="mcon" class="tg green">Conectar</button><button id="mdis" class="tg">Desconectar (modo demo)</button></div>
    <div id="mfound" class="na"></div>
    <hr><div class="mrow"><button id="mdemo" class="tg">Carregar cena demo (cena_2026)</button></div>
    <hr><h4>Backup e restauração</h4><p class="na">Salva configurações, cena atual e histórico da IA em um arquivo. As chaves de API NÃO entram no backup (ficam só no servidor local). O app também guarda automaticamente a cena e as configurações neste navegador e, se o servidor local estiver rodando, em uma cópia no computador.</p>
    <div class="mrow"><button id="mbk" class="tg green">Exportar backup</button><button id="mbr" class="tg">Restaurar backup…</button><button id="mbu" class="tg">Desfazer última restauração</button></div><div id="mbmsg" class="na"></div>
    <hr><h4>IA em nuvem (Gemini)</h4><label class="mrow">Servidor da IA (vazio = automático) <input id="maiurl" placeholder="http://192.168.0.20:8080" value="${(XR.storage && XR.storage.getSync('aiUrl')) || ''}"></label><div id="mkeys"></div>`;
    b.querySelector('#maiurl').onchange = e => { XR.storage.set('aiUrl', e.target.value.trim()); XR.aiCore.refresh(); };
    b.querySelector('#mbk').onclick = async () => (b.querySelector('#mbmsg').textContent = await XR.storage.exportBackup());
    b.querySelector('#mbr').onclick = async () => (b.querySelector('#mbmsg').textContent = await XR.storage.importDialog());
    b.querySelector('#mbu').onclick = async () => (b.querySelector('#mbmsg').textContent = await XR.storage.undoImport());
    XR.aiCore.keysPanel(b.querySelector('#mkeys'));
    const sv = () => { XR.storage && XR.storage.set('ip', b.querySelector('#mip').value); XR.storage && XR.storage.set('bridge', b.querySelector('#mb').value); };
    b.querySelector('#mcon').onclick = () => { sv(); XR.net.connect(b.querySelector('#mip').value.trim(), b.querySelector('#mb').value.trim()); };
    b.querySelector('#mdis').onclick = () => XR.net.disconnect();
    b.querySelector('#mdemo').onclick = () => { XR.loadSceneText(window.XR_DEMO_SCENE); };
    b.querySelector('#mdisc').onclick = () => { const ws = new WebSocket(b.querySelector('#mb').value.trim()); ws.onopen = () => ws.send(JSON.stringify({ cmd: 'discover' })); ws.onmessage = e => { if (typeof e.data === 'string') { const j = JSON.parse(e.data); if (j.evt === 'found') { b.querySelector('#mfound').innerHTML = 'Encontrada: <b>' + j.ip + '</b> ' + (j.name || ''); b.querySelector('#mip').value = j.ip; ws.close(); } } }; ws.onerror = () => (b.querySelector('#mfound').textContent = 'Ponte não encontrada. No PC rode: node servidor.js'); setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000); };
  };
  XR.routingModal = b => {
    const groups = [['main', 2, 'Main'], ['aux', 6, 'Aux out'], ['p16', 16, 'P16'], ['usb', 18, 'USB (gravação — o app lê 1–16 = canais, 17/18 = Aux ou Main LR)']];
    groups.forEach(([g_, n, t]) => { b.append(el('h4', '', t)); const row = el('div', 'rgrid'); for (let i = 1; i <= n; i++) { const k = `routing/${g_}/${String(i).padStart(2, '0')}`; const c = el('label', 'rcell'); c.append(el('span', '', i)); const inp = el('input'); inp.value = store.get(k, ''); inp.onchange = () => store.set(k, inp.value); c.append(inp); row.append(c); } b.append(row); });
    b.append(el('p', 'na', 'Nota: a edição do roteamento fica na cena (.scn). Para a mesa real, o formato do comando OSC de roteamento não é verificado nesta versão — altere no X AIR Edit se necessário.'));
  };
  XR.utilityModal = b => {
    b.innerHTML = `<div class="mrow"><button id="u1" class="tg">Gerar sinais de teste (REC)</button><button id="u2" class="tg">Desfazer última alteração da IA</button><button id="u3" class="tg">Atualizar da mesa</button></div>
    <p class="na">XR18 Studio · app de controle e mixagem para Behringer XR18 · protocolo OSC. Atalhos: duplo clique no fader = 0 dB; roda do mouse sobre ponto do EQ = Q.</p>`;
    b.querySelector('#u1').onclick = () => { XR.rec.synth(); $('#mclose').click(); S.tab = 'rec'; location.hash = ''; document.querySelectorAll('.tab')[10].click(); };
    b.querySelector('#u2').onclick = () => store.undo(); b.querySelector('#u3').onclick = () => XR.net.mode === 'live' && XR.net.pullAll();
  };

  /* ---------- status ---------- */
  /* estados distintos: MODO DEMO · MESA CONECTADA · MESA DESCONECTADA · ERRO DE COMUNICAÇÃO */
  let everOnline = false, errMsg = '';
  const badge = () => { const s = XR.net.status, b = $('#modebadge'); let k, t;
    if (s === 'online') { const stale = XR.net.lastRx && Date.now() - XR.net.lastRx > 15000; k = stale ? 'error' : 'online'; t = stale ? 'ERRO DE COMUNICAÇÃO · sem resposta da mesa' : 'MESA CONECTADA · ' + XR.net.ip; }
    else if (s === 'connecting') { k = 'connecting'; t = 'CONECTANDO…'; }
    else if (s === 'error') { k = 'error'; t = 'ERRO DE COMUNICAÇÃO' + (errMsg ? ' · ' + errMsg : ''); }
    else if (everOnline) { k = 'offline'; t = 'MESA DESCONECTADA (controles locais; sem envio)'; }
    else { k = 'demo'; t = 'MODO DEMO (simulador, sem mesa)'; }
    b.className = k; b.textContent = t; };
  XR.net.onStatus((s, x) => { if (s === 'online') everOnline = true; if (s === 'error') errMsg = (x && x.msg) || ''; badge(); const d = $('#dot'), t = $('#stxt'); d.className = s; t.textContent = { online: 'Conectado: ' + XR.net.ip, connecting: 'Conectando…', offline: everOnline ? 'Mesa desconectada' : 'Modo demo (offline)', error: errMsg || 'Erro de conexão', ready: 'Ponte pronta' }[s] || s; });
  setInterval(badge, 1000);
  $('#menubtn').onclick = () => document.body.classList.toggle('menu-open');
  $('#right').addEventListener('click', e => { if (e.target.closest('.bb,#mainlr,.tbtn')) document.body.classList.remove('menu-open'); });

  /* ---------- medidores / laço ---------- */
  const vuColor = (g_, h, v) => { const gr = g_.createLinearGradient(0, h, 0, 0); gr.addColorStop(0, '#1fc84a'); gr.addColorStop(0.7, '#e8d21a'); gr.addColorStop(1, '#e63030'); return gr; };
  const lvl = v => Math.max(0, Math.min(1, (v + 60) / 60));
  const meterCanvas = (cv, v) => { const g_ = cv.getContext('2d'), w = cv.width, h = cv.height; g_.clearRect(0, 0, w, h); g_.fillStyle = vuColor(g_, h); const hh = lvl(v) * h; g_.fillRect(0, h - hh, w, hh); };
  let last = 0;
  function loop(t) {
    requestAnimationFrame(loop); if (t - last < 33) return; last = t;
    if (XR.net.mode === 'demo' && !XR.rec.live) XR.meters.demoTick(t);
    XR.rec.tick();
    document.querySelectorAll('.strip').forEach(d => { const c = d.querySelector('.vu'); if (c) meterCanvas(c, XR.meters.v[d.dataset.id] ?? -90); });
    meterCanvas($('#selmeter'), XR.meters.v[S.sel] ?? -90); meterCanvas($('#lrmeter'), XR.meters.v['lr'] ?? -90);
    if (S.bigMeter) drawBig(S.bigMeter); if (S.eqDraw) S.eqDraw(); if (S.tab === 'rec' && S.recDraw) S.recDraw();
  }
  function drawBig(cv) {
    const g_ = cv.getContext('2d'), w = cv.width, h = cv.height, list = [...XR.STRIPS, ...XR.BUSES, XR.LR]; g_.fillStyle = '#000'; g_.fillRect(0, 0, w, h); const bw = w / list.length;
    list.forEach((s, i) => { const v = XR.meters.v[s.id] ?? -90, c = XR.colorOf(store.get(s.id + '/config/color', 0)); g_.fillStyle = '#111'; g_.fillRect(i * bw + 3, 14, bw - 6, h - 40); g_.fillStyle = vuColor(g_, h); g_.save(); g_.beginPath(); g_.rect(i * bw + 3, 14 + (h - 40) * (1 - lvl(v)), bw - 6, (h - 40) * lvl(v)); g_.clip(); g_.fillRect(i * bw + 3, 14, bw - 6, h - 40); g_.restore(); g_.fillStyle = c.bd; g_.font = '11px Arial'; g_.textAlign = 'center'; g_.fillText(XR.name(s.id).slice(0, 7), i * bw + bw / 2, h - 18); g_.fillStyle = '#aaa'; g_.fillText(isFinite(v) && v > -90 ? v.toFixed(0) : '', i * bw + bw / 2, 11); });
  }

  /* ---------- start ---------- */
  XR.store.load(XR.parseScn(window.XR_DEMO_SCENE || ''));
  S.init(); requestAnimationFrame(loop);
  XR.mesa.buildBar($('#aibar')); XR.mesa.start(); badge();
  XR.storage.ready.then(async () => { let at = 0; try { at = await XR.storage.restoreScene(); } catch (e) {} XR.storage.armed = true; XR.storage.autosaveScene(); if (at) { S.renderContent(); } const ip = XR.storage.getSync('ip'); if (XR.storage.msg) console.info(XR.storage.msg); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').hidden = true; });
})();
