/* XR18 Studio — persistência: configurações, cena automática, histórico, sessão de gravação e backups.
   Camadas: localStorage (espelho rápido, só configurações pequenas) + IndexedDB (principal) + cópia em arquivo no servidor local (se rodando).
   Chaves de API NUNCA passam por aqui: ficam só no servidor local (servidor.js). */
(function () {
  const XR = window.XR, VERSION = 1, MIRROR = 'xr18_kv';
  const St = (XR.storage = { cache: {}, ready: null, serverOk: false, lastSave: 0, msg: '' });
  const ALLOWED = /^(ip|bridge|aiUrl|ui\.|ai\.|profiles|recCfg)/; // chaves permitidas em importação de backup

  try { St.cache = JSON.parse(localStorage.getItem(MIRROR) || '{}') || {}; } catch (e) { St.cache = {}; }
  const mirror = () => { try { localStorage.setItem(MIRROR, JSON.stringify(St.cache)); } catch (e) {} };

  /* ---------- IndexedDB ---------- */
  let db = null;
  const open = () => new Promise(res => {
    if (!window.indexedDB) return res(null);
    const r = indexedDB.open('xr18studio', 1);
    r.onupgradeneeded = () => { const d = r.result; ['kv', 'rec', 'big'].forEach(n => d.objectStoreNames.contains(n) || d.createObjectStore(n)); };
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => { if (!db) return res(undefined); const t = db.transaction(store, mode), s = t.objectStore(store); let out; const rq = fn(s); if (rq) rq.onsuccess = () => (out = rq.result); t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error); });
  const idbGet = (s, k) => tx(s, 'readonly', o => o.get(k)), idbPut = (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)), idbAll = s => tx(s, 'readonly', o => o.getAll()), idbKeys = s => tx(s, 'readonly', o => o.getAllKeys());
  const idbClear = s => tx(s, 'readwrite', o => o.clear());

  /* ---------- configurações ---------- */
  St.getSync = (k, d) => (k in St.cache ? St.cache[k] : d);
  St.get = async (k, d) => { await St.ready; return St.getSync(k, d); };
  let tmr = 0;
  St.set = (k, v) => { St.cache[k] = v; mirror(); if (db) idbPut('kv', k, v).catch(() => {}); clearTimeout(tmr); tmr = setTimeout(St.syncServer, 1500); };
  St.del = k => { delete St.cache[k]; mirror(); if (db) tx('kv', 'readwrite', o => o.delete(k)).catch(() => {}); };

  /* ---------- servidor local (cópia em arquivo, sobrevive a "limpar dados do navegador") ---------- */
  const base = () => (XR.aiCore ? XR.aiCore.baseUrl() : '');
  St.syncServer = async () => {
    const b = base(); if (!b) return;
    try { const r = await fetch(b + '/api/estado', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: St.cache, scene: St.cache.__sceneText || null, at: Date.now() }) }); St.serverOk = r.ok; } catch (e) { St.serverOk = false; }
  };
  St.pullServer = async () => { const b = base(); if (!b) return null; try { const r = await fetch(b + '/api/estado'); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } };

  /* ---------- cena automática ---------- */
  const SCENE_KEY = 'scene';
  let sceneT = 0;
  St.armed = false;
  St.autosaveScene = () => { if (!St.armed) return; clearTimeout(sceneT); sceneT = setTimeout(async () => { try { const txt = XR.writeScn(); await idbPut('big', SCENE_KEY, { text: txt, at: Date.now() }); St.lastSave = Date.now(); } catch (e) { St.msg = 'Falha no salvamento automático: ' + e.message; } }, 2000); };
  St.restoreScene = async () => { const o = await idbGet('big', SCENE_KEY).catch(() => null); if (o && o.text) { XR.store.load(XR.parseScn(o.text), false); return o.at; } return 0; };

  /* ---------- histórico (IA) ---------- */
  St.pushLog = async (name, entry, max = 500) => { const arr = (await St.get('log.' + name, [])).slice(-(max - 1)); arr.push(entry); St.cache['log.' + name] = arr; if (db) idbPut('big', 'log.' + name, arr).catch(() => {}); return arr; };
  St.getLog = async name => { await St.ready; const v = await idbGet('big', 'log.' + name).catch(() => null); return v || St.cache['log.' + name] || []; };

  /* ---------- sessão de gravação (segmentos Int16) ---------- */
  St.recPut = (track, seg, data) => idbPut('rec', `${String(track).padStart(2, '0')}:${String(seg).padStart(6, '0')}`, data);
  St.recLoad = async () => { if (!db) return []; const ks = (await idbKeys('rec')) || [], out = []; ks.sort(); for (const k of ks) out.push({ track: +k.split(':')[0], data: await idbGet('rec', k) }); return out; };
  St.recClear = () => idbClear('rec').then(() => St.del('recMeta')).catch(() => {});
  St.recMeta = m => idbPut('big', 'recMeta', m);
  St.recMetaGet = () => idbGet('big', 'recMeta').catch(() => null);

  /* ---------- backup completo ---------- */
  const today = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  St.buildBackup = async () => ({
    app: 'xr18-studio', version: VERSION, created: new Date().toISOString(),
    settings: Object.fromEntries(Object.entries(St.cache).filter(([k]) => !k.startsWith('__') && !/key|chave|token/i.test(k))),
    scene: XR.writeScn(), logs: { mesa: await St.getLog('mesa'), rec: await St.getLog('rec') },
    note: 'Este arquivo NÃO contém chaves de API (elas ficam só no servidor local).'
  });
  St.exportBackup = async () => {
    const blob = new Blob([JSON.stringify(await St.buildBackup(), null, 1)], { type: 'application/json' });
    const a = XR.el('a'); a.href = URL.createObjectURL(blob); a.download = `xr18-backup-${today()}.json`; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return 'Backup exportado.';
  };
  /** valida sem aplicar; devolve {ok, erro, dados} */
  St.validateBackup = text => {
    if (text.length > 20e6) return { ok: false, erro: 'Arquivo grande demais.' };
    let j; try { j = JSON.parse(text); } catch (e) { return { ok: false, erro: 'O arquivo não é um JSON válido.' }; }
    if (!j || j.app !== 'xr18-studio') return { ok: false, erro: 'Este arquivo não é um backup do XR18 Studio.' };
    if (typeof j.version !== 'number' || j.version > VERSION) return { ok: false, erro: 'Backup de uma versão mais nova do app. Atualize o aplicativo.' };
    if (j.settings && (typeof j.settings !== 'object' || Array.isArray(j.settings))) return { ok: false, erro: 'Configurações inválidas.' };
    if (j.scene !== undefined && (typeof j.scene !== 'string' || !/^\/config\//m.test(j.scene))) return { ok: false, erro: 'Cena inválida no backup.' };
    return { ok: true, dados: j };
  };
  St.importBackup = async text => {
    const v = St.validateBackup(text); if (!v.ok) return v.erro;
    if (typeof confirm === 'function' && !confirm('Restaurar este backup? Suas configurações e a cena atuais serão substituídas (uma cópia de segurança do estado atual é guardada antes).')) return 'Restauração cancelada.';
    await idbPut('big', 'prebackup', await St.buildBackup()).catch(() => {});
    const j = v.dados; let n = 0;
    for (const [k, val] of Object.entries(j.settings || {})) if (ALLOWED.test(k) && !/key|chave|token/i.test(k)) { St.set(k, val); n++; }
    if (j.scene) { XR.store.load(XR.parseScn(j.scene), false); XR.ui.renderContent(); St.autosaveScene(); }
    if (j.logs) for (const name of ['mesa', 'rec']) if (Array.isArray(j.logs[name])) { St.cache['log.' + name] = j.logs[name].slice(-500); await idbPut('big', 'log.' + name, St.cache['log.' + name]).catch(() => {}); }
    return `Backup restaurado (${n} configurações${j.scene ? ' + cena' : ''}). Uma cópia do estado anterior foi guardada.`;
  };
  St.undoImport = async () => { const b = await idbGet('big', 'prebackup').catch(() => null); if (!b) return 'Não há cópia anterior.'; return St.importBackup(JSON.stringify(b)); };
  St.importDialog = () => new Promise(res => { const i = XR.el('input'); i.type = 'file'; i.accept = '.json,application/json'; i.onchange = async () => res(i.files[0] ? await St.importBackup(await i.files[0].text()) : ''); i.click(); });

  /* ---------- inicialização ---------- */
  St.ready = (async () => {
    db = await open();
    if (db) {
      const all = await tx('kv', 'readonly', o => o.getAllKeys()).catch(() => []);
      for (const k of all || []) { const v = await idbGet('kv', k); if (!(k in St.cache)) St.cache[k] = v; }
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    }
    if (!Object.keys(St.cache).length) { // nada local: tenta restaurar a cópia do servidor
      const s = await St.pullServer(); if (s && s.settings) { Object.assign(St.cache, s.settings); mirror(); St.msg = 'Configurações restauradas da cópia do servidor local.'; }
    }
    return true;
  })();
  XR.store.on(k => { if (k !== '*' || true) St.autosaveScene(); });
})();
