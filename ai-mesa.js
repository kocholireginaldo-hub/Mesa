/* XR18 Studio — IA DA MESA (operador auxiliar de som ao vivo).
   Independente do gravador: lê só os medidores e o estado da mesa (XR.meters / XR.store).
   Camadas: monitor local (regras rápidas, sem internet) → camada de SEGURANÇA (valida todo comando) → execução com registro,
   confirmação e desfazer. A nuvem (Gemini, via núcleo XR.aiCore) só interpreta; a proteção contra picos é 100 % local. */
(function () {
  const XR = window.XR, store = XR.store, el = XR.el, C = XR.aiCore;
  const M = (XR.mesa = { mon: {}, alerts: [], advice: [], pending: [], history: [], diag: null, baseline: {}, changes: [], auth: {}, limits: {}, lastCloudSig: '', busy: false });
  const R1 = v => Math.round(v * 10) / 10, R05 = v => Math.round(v * 2) / 2, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const LEVELS = { 1: 'Nível 1 · Consultor', 2: 'Nível 2 · Assistido', 3: 'Nível 3 · Supervisionado', 4: 'Nível 4 · Autônomo' };
  M.LEVELS = LEVELS;
  const CH = XR.STRIPS.filter(s => s.kind === 'ch').map(s => s.id);
  const isProtected = id => /preg|pastor|palestr|ministr|mic\s?(1|pulpito|púlpito)?$|voz|vocal|altar/i.test(XR.name(id)); // microfones de fala/pregação

  /* =====================  CAMADA DE SEGURANÇA  ===================== */
  // Nunca permitido para a IA, em nenhum nível: mute, Main LR, phantom, roteamento, atribuições, links, grupos.
  const BLOCK = [
    [/\/mix\/on$/, 'a IA nunca liga/desliga mute'], [/phantom/, 'phantom power nunca é alterado pela IA'], [/^routing\//, 'roteamento crítico exige ação manual'],
    [/\/config\//, 'atribuições/nomes de canais exigem ação manual'], [/^config\//, 'configuração global exige ação manual'], [/\/(rtnsw|invert)$/, 'fonte/polaridade exigem ação manual'],
    [/\/grp\//, 'grupos DCA/mute exigem ação manual'], [/\/mix\/lr$/, 'envio ao Main LR exige ação manual'], [/^(dca)\//, 'DCA exige ação manual'], [/\/mix\/\d\d\//, 'envios exigem ação manual']
  ];
  // Permitido, com limites rígidos. step = variação máx. por ação; dev = desvio máx. acumulado do valor "base"; min/max absolutos.
  const RULES = [
    { cls: 'fader', re: /^(ch\/\d\d|rtn\/\w+)\/mix\/fader$/, step: 3, dev: 6, min: -40, max: 6, label: 'Fader de canal' },
    { cls: 'main', re: /^lr\/mix\/fader$/, step: 2, dev: 4, min: -20, max: 3, label: 'Fader Main LR (só redução de proteção)' },
    { cls: 'gain', re: /^(headamp\/\d\d\/gain|ch\/\d\d\/preamp\/rtntrim)$/, step: 3, dev: 6, min: -12, max: 60, label: 'Ganho de entrada' },
    { cls: 'lowcut', re: /\/preamp\/(hpf|hpon)$/, step: 120, dev: 200, min: 20, max: 250, label: 'Low-cut' },
    { cls: 'eq', re: /\/eq\/(\d\/g|on)$/, step: 3, dev: 6, min: -9, max: 6, label: 'Equalização' },
    { cls: 'comp', re: /\/dyn\/(on|thr|ratio|attack|release)$/, step: 12, dev: 24, min: -60, max: 120, label: 'Compressor' },
    { cls: 'gate', re: /\/gate\/(on|thr)$/, step: 8, dev: 16, min: -70, max: -20, label: 'Gate' }
  ];
  M.RULES = RULES;
  const lim = (r, key) => Object.assign({ step: r.step, dev: r.dev }, M.limits[r.cls] || {}, M.limits[key] || {});
  const ruleOf = key => RULES.find(r => r.re.test(key));
  const rate = []; // carimbos das últimas ações automáticas
  /** Valida UMA alteração. Retorna {ok, reason}. Não altera nada. */
  M.validate = (key, value, opts = {}) => {
    for (const [re, why] of BLOCK) if (re.test(key)) return { ok: false, reason: 'Bloqueado: ' + why };
    const r = ruleOf(key); if (!r) return { ok: false, reason: 'Bloqueado: parâmetro fora da lista permitida' };
    if (!XR.codecFor(key)) return { ok: false, reason: 'Bloqueado: parâmetro desconhecido' };
    const cur = store.get(key);
    if (typeof value === 'boolean') { if (/\/hpon$/.test(key) && value === false) return { ok: false, reason: 'Bloqueado: a IA só liga o low-cut' }; if (!/\/(on|hpon)$/.test(key)) return { ok: false, reason: 'Valor inválido' }; return { ok: true, value }; }
    if (typeof value !== 'number' || !isFinite(value)) return { ok: false, reason: 'Bloqueado: valor não numérico ou -∞ (a IA nunca fecha um canal)' };
    const L = lim(r, key), c = typeof cur === 'number' && isFinite(cur) ? cur : null;
    if (/\/(attack|release|ratio)$/.test(key)) return { ok: true, value };
    const mn = r.cls === 'eq' ? -9 : r.min, mx = r.cls === 'eq' ? 6 : r.max;
    if (value < mn || value > mx) return { ok: false, reason: `Fora dos limites absolutos (${mn} a ${mx})` };
    if (c !== null && Math.abs(value - c) > L.step + 1e-6) return { ok: false, reason: `Variação de ${R1(Math.abs(value - c))} excede o máximo por ação (${L.step})` };
    if (c !== null && r.cls !== 'lowcut' && r.cls !== 'comp' && r.cls !== 'gate') { const base = M.baseline[key] !== undefined ? M.baseline[key] : c, dev = isProtected(key.slice(0, 5)) && r.cls === 'fader' ? Math.min(L.dev, 4) : L.dev; if (Math.abs(value - base) > dev + 1e-6) return { ok: false, reason: `Afastaria ${R1(Math.abs(value - base))} do valor definido pelo operador (máx. ${dev})` }; }
    if (r.cls === 'main' && c !== null && value > c) return { ok: false, reason: 'Bloqueado: a IA só reduz o Main LR' };
    if (opts.auto) { const now = Date.now(); while (rate.length && now - rate[0] > 60000) rate.shift(); if (rate.length >= 6) return { ok: false, reason: 'Limite de 6 ações automáticas por minuto' }; }
    return { ok: true, value };
  };

  /* =====================  EXECUÇÃO, CONFIRMAÇÃO, HISTÓRICO  ===================== */
  const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.6 : a === b);
  let hid = 0, executing = false;
  const record = e => { e.id = ++hid; e.t = Date.now(); M.history.push(e); if (M.history.length > 300) M.history.shift(); if (XR.storage) XR.storage.pushLog('mesa', { ...e }, 500); emit(); return e; };
  M.record = e => record(e);
  const emit = () => M.listeners.forEach(f => { try { f(); } catch (e) {} }); M.listeners = []; M.onChange = f => M.listeners.push(f);
  const waitEcho = (key, val) => new Promise(res => { const f = (k, v) => { if (k === key && near(v, val)) { done(true); } }; const done = ok => { const i = store.remote.indexOf(f); if (i >= 0) store.remote.splice(i, 1); clearTimeout(t); res(ok); }; const t = setTimeout(() => done(false), 1500); store.remote.push(f); XR.net.send('/' + key); });
  M.execute = async (key, value, { reason = '', source = 'IA', auto = false, severity = 'info' } = {}) => {
    const v = M.validate(key, value, { auto });
    const before = store.get(key);
    if (!v.ok) { record({ key, before, after: value, reason, source, result: 'bloqueado', detail: v.reason }); return { ok: false, reason: v.reason }; }
    if (M.baseline[key] === undefined) M.baseline[key] = before;
    if (auto) rate.push(Date.now());
    executing = true; try { store.set(key, v.value); } finally { executing = false; }
    const live = XR.net.mode === 'live', e = record({ key, before, after: v.value, reason, source, result: live ? 'enviado' : 'aplicado (demo, sem mesa)', level: C.state.level });
    if (live) waitEcho(key, v.value).then(ok => { e.result = ok ? 'confirmado pela mesa' : 'NÃO confirmado pela mesa'; if (!ok) M.addAlert({ id: 'noconf:' + key, sev: 'warn', ch: key, title: 'Alteração não confirmada', detail: `A mesa não confirmou ${key}. Verifique a conexão.` }); emit(); });
    return { ok: true, entry: e };
  };
  M.undo = id => {
    const e = M.history.find(x => x.id === id); if (!e || e.undone || e.result === 'bloqueado' || e.before === undefined) return false;
    executing = true; try { store.set(e.key, e.before); } finally { executing = false; }
    M.baseline[e.key] = e.before; e.undone = true; record({ key: e.key, before: e.after, after: e.before, reason: 'Desfazer #' + e.id, source: 'usuário', result: XR.net.mode === 'live' ? 'enviado' : 'aplicado (demo, sem mesa)' }); return true;
  };
  // mudanças feitas por pessoas (ou por outro aparelho/mesa) viram o novo valor "base" e entram no histórico de alterações
  store.on((k, v) => { if (executing || k === '*') return; if (/\/mix\/fader$|\/gain$|\/hpf$|\/eq\/\d\/g$|\/dyn\/thr$|\/gate\/thr$/.test(k)) { M.baseline[k] = v; M.changes.push({ t: Date.now(), k, v: typeof v === 'number' ? R1(v) : v }); if (M.changes.length > 40) M.changes.shift(); } });

  /* =====================  PROPOSTAS POR NÍVEL DE AUTONOMIA  ===================== */
  const needsApproval = key => { const r = ruleOf(key); if (!r) return true; if (r.cls === 'gain' && isProtected(key.startsWith('headamp') ? 'ch/' + key.slice(8, 10) : key.slice(0, 5))) return true; return false; };
  M.propose = async (p) => { // p: {key,value,reason,sev,source,title,ch}
    const S = C.state, v = M.validate(p.key, p.value, { auto: true });
    p.id = p.id || p.key + '=' + p.value; M.advice = M.advice.filter(a => a.id !== p.id); M.pending = M.pending.filter(a => a.id !== p.id);
    if (!v.ok) { M.advice.push({ ...p, note: v.reason, blocked: true }); if (p.source === 'IA nuvem') record({ key: p.key, before: store.get(p.key), after: p.value, reason: p.reason, source: p.source, result: 'bloqueado', detail: v.reason }); emit(); return 'bloqueado'; }
    if (!S.enabled) { emit(); return 'ia-desligada'; }
    const L = S.level, authorized = M.auth[ruleOf(p.key).cls];
    if (L === 1) { M.advice.push(p); emit(); return 'recomendado'; }
    if (L === 2 || needsApproval(p.key) || (L === 3 && !authorized)) { M.pending.push(p); emit(); return 'aguardando'; }
    if (S.paused) { M.pending.push(p); emit(); return 'aguardando (pausada)'; }
    const r = await M.execute(p.key, p.value, { reason: p.reason, source: p.source, auto: true }); return r.ok ? 'executado' : 'bloqueado';
  };
  M.approve = async id => { const p = M.pending.find(x => x.id === id); if (!p) return; M.pending = M.pending.filter(x => x !== p); await M.execute(p.key, p.value, { reason: p.reason + ' (aprovado pelo operador)', source: p.source }); emit(); };
  M.reject = id => { M.pending = M.pending.filter(x => x.id !== id); emit(); };

  /* =====================  MONITOR LOCAL (sem internet, sem gravador)  ===================== */
  const WIN = 40; // ~10 s a 4 amostras/s
  M.sample = () => {
    const now = Date.now(), ids = [...CH, 'lr'];
    ids.forEach(id => { const v = XR.meters.v[id]; if (typeof v !== 'number') return; const m = (M.mon[id] = M.mon[id] || { r: [], peak: -90, clip: 0 }); m.r.push(v); if (m.r.length > WIN) m.r.shift(); m.peak = Math.max(v, m.peak - 0.4); m.at = now; });
  };
  const stats = id => { const m = M.mon[id]; if (!m || !m.r.length) return null; const r = m.r, last8 = r.slice(-8), pw = a => a.length ? 10 * Math.log10(a.reduce((s, x) => s + Math.pow(10, x / 10), 0) / a.length) : -90;
    return { avg: pw(r), avg2: pw(last8), max: Math.max(...r), max2: Math.max(...last8), hot: last8.filter(x => x > -6).length, clip: r.slice(-8).filter(x => x > -0.5).length, n: r.length }; };
  M.stats = stats;
  M.addAlert = a => { const o = M.alerts.find(x => x.id === a.id); if (o) { o.seen = Date.now(); Object.assign(o, a); } else M.alerts.push({ ...a, since: Date.now(), seen: Date.now() }); };
  const lastAct = (M.lastAct = {});
  M.evaluate = async () => {
    const now = Date.now(), S = C.state; let changed = false;
    const live = new Set();
    const alert = a => { live.add(a.id); M.addAlert(a); };
    const act = [];
    CH.forEach(id => {
      const s = stats(id); if (!s || s.n < 8) return; const nm = XR.name(id), n2 = id.slice(3);
      const faderDb = store.get(id + '/mix/fader'), muted = store.get(id + '/mix/on', true) === false;
      if (s.clip >= 3) { alert({ id: 'clip:' + id, sev: 'crit', ch: id, title: 'Clipping', detail: `${nm}: picos acima de −0,5 dBFS repetidos. O conversor pode estar estourando: reduza o ganho de entrada.` });
        const g = gainKey(id); if (g && !muted) act.push({ id: 'g:' + id, key: g.key, value: R05(g.cur - 3), title: 'Reduzir ganho de entrada', ch: id, sev: 'crit', reason: `Clipping persistente em ${nm} (${s.clip} picos > −0,5 dBFS em 2 s)`, source: 'IA local' }); }
      else if (s.hot >= 5 && s.avg2 > -10) { alert({ id: 'hot:' + id, sev: 'warn', ch: id, title: 'Nível alto persistente', detail: `${nm}: média ${R1(s.avg2)} dBFS e picos frequentes acima de −6 dBFS por vários segundos (não é um pico isolado).` });
        if (typeof faderDb === 'number' && isFinite(faderDb) && !muted && now - (lastAct[id] || 0) > 10000) { lastAct[id] = now; act.push({ id: 'f:' + id, key: id + '/mix/fader', value: R05(faderDb - 1.5), title: 'Reduzir fader 1,5 dB', ch: id, sev: 'warn', reason: `Excesso persistente em ${nm} (média ${R1(s.avg2)} dBFS)`, source: 'IA local' }); }
        if (!store.get(id + '/dyn/on') && s.avg2 > -8) act.push({ id: 'c:' + id, key: id + '/dyn/on', value: true, title: 'Ligar compressor do canal', ch: id, sev: 'info', reason: `${nm} sem compressor com nível alto: o compressor protege sem cortar a fala`, source: 'IA local' }); }
      else if (s.max2 > -3 && s.hot < 3) { M.alerts.forEach(a => 0); /* pico momentâneo: apenas observado, sem ação */ }
      // recuperação: se a IA reduziu e o nível ficou baixo por 30 s, devolve aos poucos (evita terminar mais baixo que o operador quis)
      const key = id + '/mix/fader', base = M.baseline[key], cur = store.get(key);
      if (base !== undefined && typeof cur === 'number' && cur < base - 0.1 && s.max < -16 && s.n >= WIN && now - (lastAct[id] || 0) > 30000 && !muted) { lastAct[id] = now; act.push({ id: 'r:' + id, key, value: R05(Math.min(base, cur + 1)), title: 'Restaurar fader 1 dB', ch: id, sev: 'info', reason: `Nível de ${nm} voltou ao normal: devolvendo ao valor do operador`, source: 'IA local' }); }
      if (muted === false && typeof faderDb === 'number' && !isFinite(faderDb) && s.avg > -35) alert({ id: 'closed:' + id, sev: 'info', ch: id, title: 'Sinal com fader fechado', detail: `${nm} tem sinal, mas o fader está em −∞ (ninguém ouve).` });
    });
    const lr = stats('lr');
    if (lr && lr.n >= 8) {
      if (lr.max2 > -1) alert({ id: 'lrclip', sev: 'crit', ch: 'lr', title: 'Main LR no limite', detail: `Main LR com picos de ${R1(lr.max2)} dBFS. Reduza o fader do Main ou verifique limiter/compressor do LR.` });
      else if (lr.hot >= 5) alert({ id: 'lrhot', sev: 'warn', ch: 'lr', title: 'Main LR alto', detail: `Média ${R1(lr.avg2)} dBFS no Main LR; pouca margem.` });
      if (store.get('lr/mix/on', true) === false) alert({ id: 'lrmute', sev: 'warn', ch: 'lr', title: 'Main LR silenciado', detail: 'O Main LR está em mute. A IA nunca altera isso; confirme se é intencional.' });
    }
    const act2 = CH.map(id => ({ id, s: stats(id) })).filter(x => x.s && x.s.avg > -45 && store.get(x.id + '/mix/on', true) !== false); // equilíbrio entre canais
    if (act2.length >= 4) { const a = act2.map(x => x.s.avg).sort((p, q) => p - q), med = a[a.length >> 1], top = act2.reduce((b, x) => (x.s.avg > b.s.avg ? x : b)); if (top.s.avg - med > 16) alert({ id: 'bal:' + top.id, sev: 'info', ch: top.id, title: 'Canal muito acima dos demais', detail: `${XR.name(top.id)} está ${R1(top.s.avg - med)} dB acima da mediana dos canais ativos.` }); }
    if (store.get('config/mute/1') || store.get('config/mute/2') || store.get('config/mute/3') || store.get('config/mute/4')) alert({ id: 'mg', sev: 'info', ch: 'config', title: 'Mute group ativo', detail: 'Há grupo de mute ligado; canais podem estar silenciados.' });
    if (XR.net.mode === 'live' && XR.net.lastRx && now - XR.net.lastRx > 15000) alert({ id: 'comm', sev: 'crit', ch: 'rede', title: 'Sem resposta da mesa', detail: 'Nenhum dado recebido da XR18 há mais de 15 s. Verifique rede/Wi-Fi.' });
    // alertas que não se repetem mais saem da lista depois de 10 s
    const before = M.alerts.length; M.alerts = M.alerts.filter(a => live.has(a.id) || a.id.startsWith('noconf:') || a.id.startsWith('scn:') || now - a.seen < 10000); if (M.alerts.length !== before) changed = true;
    for (const p of act) await M.propose(p);
    if (act.length || live.size) emit();
    return changed;
  };
  const gainKey = id => { const rtn = store.get(id + '/preamp/rtnsw'); const key = rtn ? id + '/preamp/rtntrim' : 'headamp/' + id.slice(3) + '/gain', cur = store.get(key); return typeof cur === 'number' ? { key, cur } : null; };

  /* auditoria de configuração (usa as regras do módulo de gravação apenas como função pura sobre o store; opcional) */
  M.auditConfig = () => { if (!XR.ai || !XR.ai.auditScene) return; const found = XR.ai.auditScene().filter(x => x.sev !== 'info' || x.changes); const ids = new Set(); found.slice(0, 12).forEach(x => { const id = 'scn:' + x.ch + x.title; ids.add(id); M.addAlert({ id, sev: x.sev === 'warn' ? 'warn' : 'info', ch: x.ch, title: x.title, detail: x.detail }); }); M.alerts = M.alerts.filter(a => !a.id.startsWith('scn:') || ids.has(a.id)); };

  /* =====================  NUVEM (Gemini): interpretação contextual  ===================== */
  const SYSTEM = `Você é um operador auxiliar de som ao vivo para a mesa digital Behringer XR18, ajudando operadores sem muita experiência.
Receberá um resumo numérico (níveis em dBFS, faders, ganhos, estado de processamento, alertas e mudanças recentes). Responda SOMENTE JSON:
{"diagnostico":"texto curto em português do Brasil explicando o que está acontecendo","recomendacoes":[{"canal":"ch/01","parametro":"mix/fader","valor":-3.5,"motivo":"...","severidade":"info|warn|crit"}]}
Regras: no máximo 4 recomendações; só use parametros "mix/fader","preamp/hpf","preamp/hpon","eq/N/g","dyn/on","dyn/thr","dyn/ratio","gate/thr","gate/on" ou, para ganho, "headamp/NN/gain" com canal "headamp"; "valor" é o NOVO valor absoluto.
NUNCA sugira mutar, desligar microfone, mexer no Main LR por mute, phantom power, roteamento ou atribuições. Prefira reduções moderadas (até 3 dB).
Diferencie pico momentâneo (não agir), aumento natural de intensidade, proximidade do microfone e excesso persistente. Se nada precisa de ação, devolva "recomendacoes":[].`;
  const summary = () => {
    const ch = CH.map(id => ({ id, s: stats(id) })).filter(x => x.s && (x.s.avg > -60 || M.alerts.some(a => a.ch === x.id))).map(({ id, s }) => ({ id, nome: XR.name(id), media_dBFS: Math.round(s.avg), pico_dBFS: Math.round(s.max), clip: s.clip, fader_dB: R1(store.get(id + '/mix/fader', -90)), ganho_dB: (gainKey(id) || {}).cur, mute: store.get(id + '/mix/on', true) === false, lowcut: !!store.get(id + '/preamp/hpon'), eq_on: !!store.get(id + '/eq/on'), comp_on: !!store.get(id + '/dyn/on'), gate_on: !!store.get(id + '/gate/on'), protegido: isProtected(id) }));
    const lr = stats('lr');
    return { autonomia: C.state.level, main: lr && { media_dBFS: Math.round(lr.avg), pico_dBFS: Math.round(lr.max), fader_dB: R1(store.get('lr/mix/fader', 0)) }, canais_ativos: ch, alertas: M.alerts.filter(a => !a.id.startsWith('scn:')).map(a => ({ canal: a.ch, titulo: a.title })), mudancas_recentes: M.changes.slice(-8), contexto_anterior: C.ctx.mesa.slice(-2).map(x => x.resumo) };
  };
  M.cloud = async (manual = false) => {
    if (M.busy) return; const S = C.state; if (!manual && (!S.enabled || S.paused || !C.cfg.autoCloudMesa)) return;
    const sum = summary(); if (!sum.canais_ativos.length && !sum.alertas.length) { if (manual) M.diag = { text: 'Sem sinal nos canais para analisar.', local: true }; emit(); return; }
    const sig = JSON.stringify([sum.alertas, sum.mudancas_recentes.length, sum.canais_ativos.map(c => c.fader_dB + ':' + c.ganho_dB)]); if (!manual && sig === M.lastCloudSig) return; // nada relevante mudou
    M.busy = true; emit();
    try {
      const r = await C.ask('mesa', { system: SYSTEM, prompt: JSON.stringify(sum) }, { auto: !manual });
      if (!r.ok) { if (manual) M.diag = { text: 'IA em nuvem indisponível: ' + r.reason + '. A análise local continua ativa.', local: true }; return; }
      M.lastCloudSig = sig; const d = r.data || {}; M.diag = { text: d.diagnostico || r.text.slice(0, 300), t: Date.now(), key: r.keyLabel };
      for (const x of (d.recomendacoes || []).slice(0, 4)) { const key = x.canal === 'headamp' ? x.parametro : `${x.canal}/${x.parametro}`; if (typeof key !== 'string' || x.valor === undefined) continue; await M.propose({ key, value: typeof x.valor === 'boolean' ? x.valor : +x.valor, title: 'Sugestão da IA (nuvem)', ch: x.canal, sev: ['info', 'warn', 'crit'].includes(x.severidade) ? x.severidade : 'info', reason: String(x.motivo || '').slice(0, 200), source: 'IA nuvem' }); }
    } finally { M.busy = false; emit(); }
  };

  /* =====================  BARRA GLOBAL + PAINEL  ===================== */
  M.buildBar = box => {
    const S = C.state; box.innerHTML = `<button id="ai-on" class="aib" title="Ativar/desativar a IA da mesa"></button><button id="ai-pause" class="aib" title="Pausar intervenções automáticas">⏸</button><button id="ai-stop" class="aib red" title="Interromper novas ações automáticas e limpar pendências">■</button><select id="ai-lvl" title="Nível de autonomia"></select><button id="ai-open" class="aib" title="Painel da IA: alertas, histórico, limites">IA <span id="ai-badge" class="badge"></span></button><span id="ai-cloud" class="cloudchip"></span>`;
    const q = s => box.querySelector(s); const sel = q('#ai-lvl'); Object.entries(LEVELS).forEach(([k, v]) => sel.append(new Option(v, k)));
    q('#ai-on').onclick = () => { S.enabled = !S.enabled; C.save(); draw(); }; q('#ai-pause').onclick = () => { S.paused = !S.paused; draw(); };
    q('#ai-stop').onclick = () => { S.paused = true; M.pending = []; M.busy = false; draw(); emit(); };
    sel.onchange = () => { const n = +sel.value; if (n >= 3 && !confirm(`${LEVELS[n]}: a IA poderá alterar parâmetros da mesa sozinha, dentro dos limites do painel (nunca mute, Main, phantom, roteamento). Todas as ações ficam no histórico e podem ser desfeitas. Ativar?`)) { sel.value = S.level; return; } S.level = n; C.save(); M.pending = n === 1 ? [] : M.pending; draw(); };
    q('#ai-open').onclick = () => XR.modal('IA da Mesa', M.panel);
    const draw = () => { q('#ai-on').textContent = S.enabled ? 'IA: ON' : 'IA: OFF'; q('#ai-on').classList.toggle('on', S.enabled); q('#ai-pause').classList.toggle('on', S.paused); q('#ai-pause').textContent = S.paused ? '▶' : '⏸'; sel.value = S.level;
      const n = M.alerts.filter(a => a.sev !== 'info').length + M.pending.length, b = q('#ai-badge'); b.textContent = n || ''; b.classList.toggle('crit', M.alerts.some(a => a.sev === 'crit'));
      const c = q('#ai-cloud'); c.textContent = { ok: '☁ nuvem OK', offline: '☁ sem internet · IA local', noserver: '☁ sem servidor · IA local', nokeys: '☁ sem chave · IA local', unavailable: '☁ chaves indisponíveis · IA local', unknown: '☁ …' }[S.cloud] + (S.paused ? ' · PAUSADA' : '') + (!S.enabled ? ' · DESLIGADA' : ''); c.className = 'cloudchip ' + S.cloud; c.title = S.cloudMsg; };
    C.onChange(draw); M.onChange(draw); draw();
  };
  const fmtV = v => (typeof v === 'number' ? R1(v) : String(v));
  M.panel = box => {
    box.classList.add('aipanel'); const S = C.state;
    const render = () => {
      const tab = M._tab || 'alertas'; box.innerHTML = '';
      const tabs = el('div', 'subtabs'); [['alertas', 'Alertas e recomendações'], ['hist', 'Histórico de ações'], ['lim', 'Autonomia e limites'], ['nuvem', 'Chaves Gemini']].forEach(([k, t]) => { const b = el('button', 'tg' + (k === tab ? ' on' : ''), t); b.onclick = () => { M._tab = k; render(); }; tabs.append(b); }); box.append(tabs);
      const body = el('div'); box.append(body);
      if (tab === 'alertas') {
        body.append(el('div', 'na', `${LEVELS[S.level]} · ${S.enabled ? (S.paused ? 'PAUSADA' : 'ativa') : 'DESLIGADA'} · ${S.cloudMsg}`));
        const row = el('div', 'mrow'); const b = el('button', 'tg green', M.busy ? 'Consultando…' : 'Analisar agora com IA (nuvem)'); b.onclick = () => M.cloud(true); row.append(b); body.append(row);
        if (M.diag) body.append(el('div', 'mast', `<b>Diagnóstico${M.diag.local ? ' (local)' : ''}:</b> ${M.diag.text}${M.diag.key ? ` <small>via ${M.diag.key}</small>` : ''}`));
        if (M.pending.length) { body.append(el('h4', '', 'Aguardando sua autorização')); M.pending.forEach(p => { const r = el('div', 'sug warn'); r.append(el('div', '', `<b>${p.title}</b> · ${XR.name(p.ch) || p.ch}<br>${p.reason}<br><small>${p.key}: ${fmtV(store.get(p.key))} → ${fmtV(p.value)}</small>`)); const ok = el('button', 'tg green', 'Aplicar'); ok.onclick = () => M.approve(p.id); const no = el('button', 'tg', 'Recusar'); no.onclick = () => M.reject(p.id); r.append(ok, no); body.append(r); }); }
        body.append(el('h4', '', 'Alertas atuais')); if (!M.alerts.length) body.append(el('div', 'na', 'Nenhum alerta no momento.'));
        M.alerts.slice().sort((a, b) => ({ crit: 0, warn: 1, info: 2 }[a.sev] - { crit: 0, warn: 1, info: 2 }[b.sev])).forEach(a => body.append(el('div', 'sug ' + a.sev, `<div><b>${a.title}</b><br>${a.detail}</div>`)));
        if (M.advice.length) { body.append(el('h4', '', 'Recomendações (modo consultor / bloqueadas)')); M.advice.forEach(p => body.append(el('div', 'sug ' + (p.blocked ? 'info' : p.sev), `<div><b>${p.title}</b> · ${XR.name(p.ch) || p.ch}<br>${p.reason || ''}<br><small>${p.key}: ${fmtV(store.get(p.key))} → ${fmtV(p.value)}${p.blocked ? ' · ' + p.note : ' · faça manualmente ou suba o nível de autonomia'}</small></div>`))); }
      } else if (tab === 'hist') {
        const rows = M.history.slice().reverse(); if (!rows.length) body.append(el('div', 'na', 'Nenhuma ação registrada nesta sessão.'));
        rows.forEach(e => { const r = el('div', 'sug ' + (e.result === 'bloqueado' ? 'info' : 'warn')); r.append(el('div', '', `<b>${new Date(e.t).toLocaleTimeString()} · ${e.source}</b> · ${e.key}<br>${fmtV(e.before)} → ${fmtV(e.after)} · <b>${e.result}${e.undone ? ' (desfeito)' : ''}</b><br><small>${e.reason || ''}${e.detail ? ' · ' + e.detail : ''}</small>`)); if (e.result !== 'bloqueado' && !e.undone && e.before !== undefined && !/Desfazer/.test(e.reason)) { const u = el('button', 'tg', 'Desfazer'); u.onclick = () => { M.undo(e.id); render(); }; r.append(u); } body.append(r); });
      } else if (tab === 'lim') {
        body.append(el('p', 'na', 'No Nível 3, a IA só executa sozinha as classes marcadas abaixo. Em qualquer nível ela NUNCA muta, mexe em Main por mute, phantom, roteamento ou atribuições, e em canais de pregador/voz o ganho de entrada sempre pede sua autorização.'));
        const t = el('table', 'atb'); t.innerHTML = '<tr><th>Classe</th><th>Autorizada (Nível 3)</th><th>Máx. por ação</th><th>Máx. desvio do seu valor</th></tr>';
        RULES.forEach(r => { const L = lim(r, ''), tr = el('tr'); tr.innerHTML = `<td>${r.label}</td><td><input type="checkbox" ${M.auth[r.cls] ? 'checked' : ''}></td><td><input type="number" step="0.5" value="${L.step}" style="width:60px"></td><td><input type="number" step="0.5" value="${L.dev}" style="width:60px"></td>`; const [a, s, d] = tr.querySelectorAll('input'); a.onchange = () => { M.auth[r.cls] = a.checked; persistLim(); }; s.onchange = () => { M.limits[r.cls] = { ...(M.limits[r.cls] || {}), step: clamp(+s.value, 0.5, r.step * 2) }; persistLim(); }; d.onchange = () => { M.limits[r.cls] = { ...(M.limits[r.cls] || {}), dev: clamp(+d.value, 0.5, r.dev * 2) }; persistLim(); }; t.append(tr); }); body.append(t);
        const cfg = el('div', 'mrow'); cfg.innerHTML = `<label>Consulta automática à nuvem a cada <input type="number" id="ci" min="15" value="${C.cfg.minIntervalS.mesa}" style="width:60px"> s</label><label><input type="checkbox" id="cauto" ${C.cfg.autoCloudMesa ? 'checked' : ''}> Consultas automáticas</label><label>Máx. <input type="number" id="cmax" min="1" value="${C.cfg.maxPerHour}" style="width:60px"> chamadas/hora</label>`; cfg.querySelector('#ci').onchange = e => { C.cfg.minIntervalS.mesa = Math.max(15, +e.target.value || 45); C.save(); }; cfg.querySelector('#cauto').onchange = e => { C.cfg.autoCloudMesa = e.target.checked; C.save(); }; cfg.querySelector('#cmax').onchange = e => { C.cfg.maxPerHour = Math.max(1, +e.target.value || 40); C.save(); }; body.append(cfg);
      } else C.keysPanel(body);
    };
    const persistLim = () => XR.storage && XR.storage.set('ai.mesa', { auth: M.auth, limits: M.limits });
    M.onChange(() => { if (document.contains(box) && M._tab !== 'nuvem') render(); }); render();
  };

  /* =====================  LAÇOS  ===================== */
  XR.storage && XR.storage.ready.then(() => { const s = XR.storage.getSync('ai.mesa'); if (s) { M.auth = s.auth || {}; M.limits = s.limits || {}; } });
  M.timers = [];
  M.stop = () => { M.timers.forEach(clearInterval); M.timers = []; };
  M.start = () => {
    M.stop(); const T = (f, ms) => M.timers.push(setInterval(f, ms));
    T(M.sample, 250); T(() => M.evaluate().catch(() => {}), 1000); T(M.auditConfig, 30000); setTimeout(M.auditConfig, 1500);
    T(() => M.cloud(false).catch(() => {}), 15000);
  };
})();
