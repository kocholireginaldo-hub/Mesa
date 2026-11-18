/* XR18 Studio — NÚCLEO CENTRAL DE IA (compartilhado pela IA da Mesa e pela IA da Gravação).
   Cuida de: comunicação com o servidor local (que guarda as chaves Gemini), disponibilidade, limites de consumo,
   tratamento de erros, registro e histórico. Cada módulo mantém contexto, histórico e regras próprios.
   Nenhuma chave de API existe neste arquivo, no navegador ou no localStorage. */
(function () {
  const XR = window.XR, el = XR.el;
  const C = (XR.aiCore = {
    state: { enabled: true, paused: false, level: 1, cloud: 'unknown', cloudMsg: 'Verificando…', keys: [], model: '', local: false, activeKey: '' },
    cfg: { minIntervalS: { mesa: 45, rec: 3 }, maxPerHour: 40, autoCloudMesa: true },
    ctx: { mesa: [], rec: [] },          // contexto independente por módulo (resumos curtos das últimas trocas)
    usage: { requests: 0, failures: 0, tin: 0, tout: 0, byModule: { mesa: 0, rec: 0 } },
    log: [], listeners: [], stamps: [], last: {}
  });
  const note = (lvl, msg) => { C.log.push({ t: Date.now(), lvl, msg }); if (C.log.length > 200) C.log.shift(); };
  const emit = () => C.listeners.forEach(f => { try { f(C.state); } catch (e) {} });
  C.onChange = f => C.listeners.push(f);

  /* ---------- endereço do servidor local ---------- */
  C.baseUrl = () => {
    const set = XR.storage && XR.storage.getSync('aiUrl'); if (set) return set.replace(/\/$/, '');
    const l = location; if (/^https?:$/.test(l.protocol) && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(l.hostname) && l.hostname !== 'appassets.androidplatform.net') return l.origin;
    return 'http://localhost:8080';
  };
  const j = async (path, opt) => { const r = await fetch(C.baseUrl() + path, { ...opt, headers: { 'content-type': 'application/json' } }); return r.json(); };

  /* ---------- disponibilidade ---------- */
  C.refresh = async () => {
    const S = C.state;
    if (!navigator.onLine) { S.cloud = 'offline'; S.cloudMsg = 'Sem internet — IA em nuvem indisponível (análise local ativa)'; emit(); return; }
    try {
      const st = await Promise.race([j('/api/status'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      S.keys = st.keys || []; S.model = st.model; S.local = !!st.local; const ready = S.keys.filter(k => k.state === 'pronta');
      S.activeKey = ready[0] ? ready[0].label : '';
      if (!S.keys.length) { S.cloud = 'nokeys'; S.cloudMsg = 'Nenhuma chave Gemini cadastrada (Setup → IA)'; }
      else if (!ready.length) { S.cloud = 'unavailable'; S.cloudMsg = 'Todas as chaves indisponíveis agora — IA local ativa'; }
      else { S.cloud = 'ok'; S.cloudMsg = `Nuvem OK · chave ativa: ${S.activeKey}`; }
    } catch (e) { S.cloud = 'noserver'; S.cloudMsg = 'Servidor local da IA não encontrado — IA local ativa'; S.keys = []; }
    emit();
  };
  window.addEventListener('online', C.refresh); window.addEventListener('offline', C.refresh);
  setInterval(C.refresh, 30000);

  /* ---------- chamada à nuvem (única porta de saída) ---------- */
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  /** module: 'mesa' | 'rec'. opts: {auto:true} para chamadas automáticas (sujeitas a pausa/intervalo/duplicata). */
  C.ask = async (module, { system, prompt, json = true }, opts = {}) => {
    const S = C.state, now = Date.now();
    const refuse = (reason, code) => { note('info', `[${module}] não enviado: ${reason}`); return { ok: false, local: true, code, reason }; };
    if (opts.auto && (!S.enabled || S.paused)) return refuse('IA desativada ou pausada', 'disabled');
    if (S.cloud !== 'ok' && S.cloud !== 'unknown') return refuse(S.cloudMsg, 'cloud_' + S.cloud);
    const minI = (opts.auto ? C.cfg.minIntervalS[module] : 2) * 1000; if (C.last[module] && now - C.last[module].t < minI) return refuse('intervalo mínimo entre chamadas ainda não passou', 'too_soon');
    C.stamps = C.stamps.filter(t => now - t < 3600e3); if (C.stamps.length >= C.cfg.maxPerHour) return refuse(`limite de ${C.cfg.maxPerHour} chamadas/hora atingido (configurável)`, 'budget');
    const h = hash(system + prompt); if (opts.auto && C.last[module] && C.last[module].h === h) return refuse('dados iguais aos da última chamada', 'duplicate');
    C.last[module] = { t: now, h }; C.stamps.push(now); C.usage.requests++; C.usage.byModule[module]++;
    let r; try { r = await j('/api/ia', { method: 'POST', body: JSON.stringify({ system, prompt, json }) }); } catch (e) { C.usage.failures++; S.cloud = 'noserver'; S.cloudMsg = 'Servidor local da IA não encontrado — IA local ativa'; emit(); return refuse('servidor local inacessível', 'noserver'); }
    if (!r.ok) { C.usage.failures++; note('error', `[${module}] ${r.error}`); C.refresh(); return { ok: false, local: true, code: r.code, reason: r.error }; }
    C.usage.tin += r.usage.tin; C.usage.tout += r.usage.tout; S.activeKey = r.keyLabel; note('info', `[${module}] resposta via ${r.keyLabel} (${r.model}) ${r.usage.tin}+${r.usage.tout} tokens`);
    let data = null; if (json) { try { data = JSON.parse(r.text.replace(/^```json\s*|```$/g, '')); } catch (e) { data = null; } }
    C.ctx[module].push({ t: now, resumo: (data && data.diagnostico) || r.text.slice(0, 160) }); if (C.ctx[module].length > 6) C.ctx[module].shift();
    if (XR.storage) XR.storage.pushLog(module, { t: now, tipo: 'nuvem', chave: r.keyLabel, modelo: r.model, tokens: r.usage, resumo: C.ctx[module].slice(-1)[0].resumo }, 200);
    emit(); return { ok: true, text: r.text, data, keyLabel: r.keyLabel, model: r.model, usage: r.usage };
  };

  /* ---------- gerenciamento de chaves (painel) ---------- */
  C.keysPanel = box => {
    box.innerHTML = '';
    const info = el('div', 'na'); const list = el('div', 'keylist'); box.append(info, list);
    const draw = () => {
      const S = C.state; info.textContent = S.cloudMsg + (S.model ? ` · modelo: ${S.model}` : '');
      list.innerHTML = '';
      S.keys.forEach((k, i) => {
        const row = el('div', 'keyrow'); row.innerHTML = `<b>${i + 1}. ${k.label}</b> <code>${k.mask}</code> <span class="kst ${k.state === 'pronta' ? 'ok' : 'bad'}">${k.state}${k.cooldownS ? ' (' + k.cooldownS + ' s)' : ''}</span> <small>hoje: ${k.usage.req} chamadas, ${k.usage.fail} falhas, ~${k.usage.tin + k.usage.tout} tokens${k.lastError ? ' · ' + k.lastError : ''}</small>`;
        if (S.local) {
          const b = (t, fn) => { const x = el('button', 'tg', t); x.onclick = async () => { await fn(); await C.refresh(); }; row.append(x); };
          b('▲', () => i && j('/api/keys/order', { method: 'POST', body: JSON.stringify({ ids: S.keys.map(x => x.id).map((id, n, a) => (n === i - 1 ? a[i] : n === i ? a[i - 1] : id)) }) }));
          b(k.enabled ? 'Desativar' : 'Ativar', () => j('/api/keys/' + k.id, { method: 'PATCH', body: JSON.stringify({ enabled: !k.enabled }) }));
          b('Limite/dia', () => { const v = prompt('Limite diário de chamadas para esta chave neste app (0 = sem limite):', k.dailyLimit); return v === null ? 0 : j('/api/keys/' + k.id, { method: 'PATCH', body: JSON.stringify({ dailyLimit: +v || 0 }) }); });
          b('Substituir', () => { const v = prompt('Cole a nova chave (ela não será exibida novamente):'); return v ? j('/api/keys/' + k.id, { method: 'PATCH', body: JSON.stringify({ key: v }) }).then(r => r.ok || alert(r.error)) : 0; });
          b('Remover', () => confirm('Remover esta chave?') && j('/api/keys/' + k.id, { method: 'DELETE' }));
        }
        list.append(row);
      });
      if (S.local) {
        const add = el('div', 'mrow'); add.innerHTML = '<input id="kl" placeholder="Nome (ex.: Principal)" style="width:130px"><input id="kk" type="password" placeholder="Cole a chave Gemini" autocomplete="off" style="flex:1"><button class="tg green" id="ka">Adicionar</button>';
        add.querySelector('#ka').onclick = async () => { const r = await j('/api/keys', { method: 'POST', body: JSON.stringify({ label: add.querySelector('#kl').value, key: add.querySelector('#kk').value }) }); add.querySelector('#kk').value = ''; if (!r.ok) alert(r.error); await C.refresh(); };
        list.append(add);
        const m = el('div', 'mrow'); m.innerHTML = `<label>Modelo <input id="km" value="${S.model || ''}" style="width:200px"></label><button class="tg" id="kms">Salvar modelo</button>`; m.querySelector('#kms').onclick = async () => { await j('/api/config', { method: 'POST', body: JSON.stringify({ model: m.querySelector('#km').value }) }); C.refresh(); };
        list.append(m);
      } else if (S.cloud !== 'noserver') list.append(el('div', 'na', 'As chaves só podem ser cadastradas no computador que roda o servidor (por segurança).'));
      else list.append(el('div', 'na', 'Para usar a IA em nuvem, inicie o servidor local (iniciar-pc.bat / iniciar-pc.sh) e abra o app por http://localhost:8080.'));
      const u = C.usage; list.append(el('div', 'na', `Sessão: ${u.requests} chamadas (mesa ${u.byModule.mesa}, gravação ${u.byModule.rec}), ${u.failures} falhas, ~${u.tin + u.tout} tokens. Limite configurado: ${C.cfg.maxPerHour} chamadas/hora. Trocar de chave só ajuda se cada chave pertencer a um projeto/cota distinto.`));
    };
    C.onChange(draw); C.refresh().then(draw); draw();
  };

  if (XR.storage) XR.storage.ready.then(() => { Object.assign(C.cfg, XR.storage.getSync('ai.core', {})); const s = XR.storage.getSync('ai.state'); if (s) { C.state.enabled = s.enabled !== false; C.state.level = s.level || 1; } emit(); });
  C.save = () => XR.storage && (XR.storage.set('ai.state', { enabled: C.state.enabled, level: C.state.level }), XR.storage.set('ai.core', C.cfg));
  C.refresh();
})();
