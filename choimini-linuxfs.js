/* ============================================================================
   choimini-linuxfs.js
   ----------------------------------------------------------------------------
   WORK / CODE 모드용 "가상 Linux 로컬 환경"(Linux_Local).
   실제 사용자 OS와는 완전히 분리된, 브라우저 저장공간(localStorage) 안에서만
   동작하는 가상 파일 시스템 + 최소한의 명령어 실행기.

   저장 위치: localStorage["Choimin.Lnc"] 아래
     Choimin.Lnc
       └── AI_Service
             └── Linux_Local
                   ├── cmds     (가상 명령어 메타데이터)
                   ├── package  (설치된 패키지 메타데이터 — 시뮬레이션)
                   └── user     (실제 파일 저장 영역: download/documents/desktop/projects)

   보안/격리 원칙(스펙 23번):
     - 실제 OS 파일 시스템에 절대 접근하지 않음 (전부 localStorage 안의 가상 경로)
     - 임의의 시스템 명령을 실행하지 않음 — 구조화된 fs_* / pkg_* 도구만 제공
     - 브라우저 저장공간 밖으로 나가지 않음
   ============================================================================ */
(function(global){
  "use strict";

  const ROOT_KEY = "Choimin.Lnc";
  const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // localStorage 여유를 고려한 가상 용량 상한(대략치)
  const MAX_FILE_BYTES = 300 * 1024 * 1024; // 파일 1개당 상한 (300MB)
  const BIG_THRESHOLD = 256 * 1024;         // 이보다 큰 파일은 localStorage 대신 IndexedDB(+메모리)에 보관
  const MAX_BIG_TOTAL = 500 * 1024 * 1024;  // 큰 파일 총량 상한
  const BIG = new Map();                    // bigId -> content (메모리)
  const IDB_NAME = "choimini-fs", IDB_STORE = "blobs";
  function idb(){ return new Promise((res, rej) => { try{ const r = indexedDB.open(IDB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }catch(e){ rej(e); } }); }
  function idbPut(id, val){ return idb().then(db => new Promise(res => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(val, id); t.oncomplete = () => res(true); t.onerror = () => res(false); })).catch(() => false); }
  function idbGet(id){ return idb().then(db => new Promise(res => { const q = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); })).catch(() => undefined); }
  function idbDel(id){ return idb().then(db => new Promise(res => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).delete(id); t.oncomplete = () => res(true); t.onerror = () => res(false); })).catch(() => false); }
  function attachBig(e){ if(e && e.bigId){ const id = e.bigId; Object.defineProperty(e, "content", { get(){ return BIG.has(id) ? BIG.get(id) : ""; }, set(v){ BIG.set(id, v); }, enumerable:true, configurable:true }); } return e; }
  function cloneEntry(e){ const c = {}; Object.keys(e).forEach(k => { c[k] = e[k]; }); if(e.bigId) attachBig(c); else if("content" in e) c.content = e.content; return c; }
  function gcBig(){ const used = new Set(); for(const k in state.fs){ const e = state.fs[k]; if(e && e.bigId) used.add(e.bigId); } [...BIG.keys()].forEach(id => { if(!used.has(id)){ BIG.delete(id); idbDel(id); } }); }

  const DEFAULT_DIRS = [
    "/", "/cmds", "/package", "/tmp", "/trash", "/backup",
    "/user", "/user/download", "/user/documents", "/user/desktop", "/user/projects"
  ];

  const BUILTIN_CMDS = ["ls","cd","pwd","cat","cp","mv","rm","mkdir","touch","find","grep","head","tail"];
  const CODE_EXTRA_CMDS = ["sed","awk","sort","uniq","curl","wget","tar","zip","unzip","git","python","node","npm","pip"];

  function nowTs(){ return Date.now(); }

  function normPath(p){
    if(!p) p = "/";
    p = String(p).trim();
    if(!p.startsWith("/")) p = "/" + p;
    // ".." 및 "." 처리 + 중복 슬래시 정리
    const parts = p.split("/").filter(Boolean);
    const out = [];
    for(const part of parts){
      if(part === ".") continue;
      if(part === ".."){ out.pop(); continue; }
      out.push(part);
    }
    return "/" + out.join("/");
  }
  function joinPath(base, p){
    if(!p) return base;
    if(String(p).startsWith("/")) return normPath(p);
    return normPath((base==="/" ? "" : base) + "/" + p);
  }
  function parentOf(p){
    p = normPath(p);
    if(p === "/") return null;
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "/" : p.slice(0, idx);
  }
  function baseName(p){
    p = normPath(p);
    if(p === "/") return "/";
    return p.slice(p.lastIndexOf("/") + 1);
  }

  let state = null; // { fs: {path: entry}, cwd: "/user" }

  function blankState(){
    const fs = {};
    DEFAULT_DIRS.forEach(d => { fs[d] = { type:"dir", createdAt: nowTs() }; });
    return { fs, cwd: "/" };
  }

  function totalBytes(){
    let n = 0;
    for(const k in state.fs){
      const e = state.fs[k];
      if(e.type === "file" && !e.bigId) n += (e.size || 0);
    }
    return n;
  }
  function bigBytes(){ let n = 0; for(const k in state.fs){ const e = state.fs[k]; if(e.type === "file" && e.bigId) n += (e.size || 0); } return n; }

  function persist(){
    try{
      const root = JSON.parse(localStorage.getItem(ROOT_KEY) || "{}");
      root.AI_Service = root.AI_Service || {};
      root.AI_Service.Linux_Local = state;
      localStorage.setItem(ROOT_KEY, JSON.stringify(root, function(k, v){ return (k === "content" && this && this.bigId) ? undefined : v; }));
      try{ gcBig(); }catch(_){}
      return true;
    }catch(e){
      console.error("[LinuxFS] 저장 실패(저장공간 부족 가능):", e);
      return false;
    }
  }

  function load(){
    try{
      const root = JSON.parse(localStorage.getItem(ROOT_KEY) || "{}");
      const saved = root && root.AI_Service && root.AI_Service.Linux_Local;
      if(saved && saved.fs){
        state = saved;
        // 새 기본 디렉터리가 추가된 경우 backfill
        DEFAULT_DIRS.forEach(d => { if(!state.fs[d]) state.fs[d] = { type:"dir", createdAt: nowTs() }; });
        if(!state.cwd || !state.fs[state.cwd]) state.cwd = "/";
        Object.keys(state.fs).forEach(k => { const e = state.fs[k]; if(e && e.bigId){ attachBig(e); idbGet(e.bigId).then(v => { if(v != null) BIG.set(e.bigId, v); }); } });
      } else {
        state = blankState();
        persist();
      }
    }catch(e){
      state = blankState();
    }
  }
  load();
  try{ setTimeout(() => { purgeExpiredSafe(); }, 0); }catch(_){}
  function purgeExpiredSafe(){ try{ purgeExpired(); }catch(_){} }

  function isDir(p){ const e = state.fs[normPath(p)]; return !!e && e.type === "dir"; }
  function isFile(p){ const e = state.fs[normPath(p)]; return !!e && e.type === "file"; }
  function exists(p){ return !!state.fs[normPath(p)]; }

  function ensureParentDirs(p){
    const parts = normPath(p).split("/").filter(Boolean);
    let cur = "";
    for(let i=0;i<parts.length-1;i++){
      cur += "/" + parts[i];
      if(!state.fs[cur]) state.fs[cur] = { type:"dir", createdAt: nowTs() };
    }
  }

  function childrenOf(dir){
    dir = normPath(dir);
    const prefix = dir === "/" ? "/" : dir + "/";
    const out = [];
    for(const p in state.fs){
      if(p === dir) continue;
      if(!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if(rest.includes("/")) continue; // 직계 자식만
      out.push(p);
    }
    return out.sort();
  }

  function byteSize(content){
    if(typeof content === "string"){ const m = /^data:[^,]*;base64,/.exec(content); if(m){ const n = content.length - m[0].length; return Math.floor(n * 3 / 4) - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0); } if(content.length > 2000000) return content.length * 3; }
    try{ return new Blob([content]).size; }catch(e){ return (content||"").length; }
  }

  /* ---------------- 파일 잠금 / 휴지통 / 백업 ----------------
     - 잠금: 사용자가 파일·폴더에 거는 보호 표시(entry.locked). 최미나이(AI 도구 실행 중)가 잠긴 항목을
       수정·삭제·이동하려면 사용자의 동의(onLockRequest)가 필요하다. 폴더를 잠그면 안의 모든 항목이 잠긴다.
     - 휴지통(/trash): 사용자가 지운 항목을 14일 보관 후 자동 삭제.
     - 백업(/backup): 최미나이가 명령어로 지우거나 바꾼(덮어쓴) 파일의 옛 내용을 <프로젝트명>.zip 으로 묶어 15일 보관 후 자동 삭제. */
  // v2.2.0 §9.2: 파일 수정 전 백업 보관 기간을 7일 → 15일로 늘렸다.
  const TRASH_MS = 14 * 24 * 3600 * 1000, BACKUP_MS = 15 * 24 * 3600 * 1000;
  let aiDepth = 0, sysDepth = 0;
  const consent = new Set();
  const OP_LABEL = { edit:"수정", delete:"삭제", move:"이동", create:"생성", copy:"복사" };
  function lockRoot(p){
    let cur = normPath(p);
    for(;;){
      const e = state.fs[cur]; if(e && e.locked) return cur;
      const par = parentOf(cur); if(!par) return null; cur = par;
    }
  }
  function lockedBelow(p){
    p = normPath(p); const prefix = p === "/" ? "/" : p + "/";
    for(const k in state.fs){ if(k.startsWith(prefix) && state.fs[k].locked) return k; }
    return null;
  }
  const SYS_RE = /^\/(trash|backup)(\/|$)/;
  function guard(p, op, deep){
    if(!aiDepth || sysDepth) return;
    p = normPath(p);
    if(SYS_RE.test(p)) throw new Error(`휴지통/백업은 시스템 보호 영역이라 ${OP_LABEL[op] || op}할 수 없음: ${p}`);
    const r = lockRoot(p) || (deep ? lockedBelow(p) : null);
    if(!r || consent.has(r)) return;
    let ok = false;
    try{ ok = typeof api.onLockRequest === "function" ? !!api.onLockRequest({ path:p, lock:r, op, opLabel: OP_LABEL[op] || op }) : false; }catch(_){ ok = false; }
    if(!ok) throw new Error(`🔒 잠긴 파일이라 ${OP_LABEL[op] || op}할 수 없음 (사용자가 허용하지 않았어요): ${r}`);
    consent.add(r);
  }
  function setLock(path, on){
    const k = normPath(path); if(!state.fs[k]) throw new Error(`없음: ${k}`);
    if(SYS_RE.test(k) || /^\/(cmds|package)(\/|$)/.test(k)) throw new Error("시스템 영역은 잠글 수 없어요");
    if(on) state.fs[k].locked = true; else delete state.fs[k].locked;
    persist(); return !!on;
  }
  function moveRaw(src, dst){
    const e = state.fs[src];
    if(e.type === "file"){
      state.fs[dst] = Object.assign(cloneEntry(e), { updatedAt: e.updatedAt || nowTs() });
      delete state.fs[src];
    } else {
      const prefix = src + "/";
      Object.keys(state.fs).filter(k => k === src || k.startsWith(prefix)).forEach(k => {
        const nk = dst + k.slice(src.length);
        state.fs[nk] = state.fs[k]; delete state.fs[k];
      });
    }
  }
  function subtreeKeys(p){ const prefix = p + "/"; return Object.keys(state.fs).filter(k => k === p || k.startsWith(prefix)); }
  function rmRaw(p){ subtreeKeys(p).forEach(k => { delete state.fs[k]; }); }

  /* 휴지통 */
  function inSystem(p){ return /^\/(cmds|package|trash|backup)(\/|$)/.test(p); }
  function userDelete(path){
    const p = normPath(joinPath(state.cwd, path));
    if(DEFAULT_DIRS.includes(p)) throw new Error(`기본 디렉터리는 삭제할 수 없음: ${p}`);
    if(!exists(p)) throw new Error(`없음: ${p}`);
    if(/^\/(cmds|package)(\/|$)/.test(p)) throw new Error("시스템 영역은 삭제할 수 없어요");
    if(SYS_RE.test(p)){ rmRaw(p); persist(); return { permanent:true }; }
    const id = baseName(p) + "~" + Date.now().toString(36);
    const dst = "/trash/" + id;
    moveRaw(p, dst);
    Object.assign(state.fs[dst], { trashedAt: nowTs(), origPath: p, isProject: parentOf(p) === "/user/projects" });
    persist(); return { id, trashed:true };
  }
  function trashList(){
    purgeExpired();
    return childrenOf("/trash").map(k => { const e = state.fs[k], id = baseName(k); return { id, name: id.replace(/~[^~]*$/, ""), type: e.type, origPath: e.origPath || "", trashedAt: e.trashedAt || 0, isProject: !!e.isProject, expiresAt: (e.trashedAt || 0) + TRASH_MS, size: subtreeKeys(k).reduce((n, q) => n + (state.fs[q].type === "file" ? (state.fs[q].size || 0) : 0), 0), files: subtreeKeys(k).filter(q => state.fs[q].type === "file").length }; }).sort((a, b) => b.trashedAt - a.trashedAt);
  }
  function trashRestore(id){
    const src = "/trash/" + id, e = state.fs[src]; if(!e) throw new Error("휴지통에 없음");
    let dst = e.origPath || ("/user/" + id.replace(/~[^~]*$/, ""));
    if(exists(dst)){ const m = /^(.*?)(\.[^./]+)?$/.exec(dst); let n = 1, c; do{ c = m[1] + " (복원" + (n > 1 ? n : "") + ")" + (m[2] || ""); n++; }while(exists(c)); dst = c; }
    ensureParentDirs(dst);
    moveRaw(src, dst); delete state.fs[dst].trashedAt; delete state.fs[dst].origPath; delete state.fs[dst].isProject;
    persist(); return dst;
  }
  function trashPurge(id){ const p = "/trash/" + id; if(!state.fs[p]) return false; rmRaw(p); persist(); return true; }
  function trashEmpty(){ childrenOf("/trash").forEach(rmRaw); persist(); }

  /* 백업 */
  function projectOf(p){
    p = normPath(p); let m = /^\/user\/projects\/([^/]+)\//.exec(p); if(m) return { name: m[1], root: "/user/projects/" + m[1] + "/" };
    m = /^\/user\/([^/]+)\//.exec(p); if(m) return { name: m[1], root: "/user/" + m[1] + "/" };
    return { name: "etc", root: "/" };
  }
  const bkPending = [];
  let bkTimer = null, bkRunning = Promise.resolve();
  function toBytes(c){
    if(c == null) return new Uint8Array(0);
    c = String(c); const m = /^data:[^,]*;base64,/.exec(c);
    if(m){ try{ const b = atob(c.slice(m[0].length)); const u = new Uint8Array(b.length); for(let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }catch(_){} }
    return new TextEncoder().encode(c);
  }
  /** label: "삭제"(지워지기 전) | "변경"(덮어쓰기/수정되기 전의 옛 내용). 최미나이가 한 작업만 백업한다. */
  function captureForBackup(p, label){
    if(!aiDepth || sysDepth || inSystem(p) || /^\/tmp(\/|$)/.test(p)) return;
    subtreeKeys(p).forEach(k => { const e = state.fs[k]; if(e && e.type === "file") bkPending.push({ path:k, content:e.content, mime:e.mime, ts: nowTs(), label: label || "삭제" }); });
    if(bkPending.length && !bkTimer) bkTimer = setTimeout(() => { bkTimer = null; bkRunning = bkRunning.then(flushBackups); }, 30);
  }
  function stamp(t){ const d = new Date(t), z = n => String(n).padStart(2, "0"); return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); }
  async function flushBackups(){
    if(!bkPending.length) return 0;
    const items = bkPending.splice(0, bkPending.length), groups = {};
    items.forEach(it => { const pr = projectOf(it.path); (groups[pr.name] = groups[pr.name] || { root: pr.root, list: [] }).list.push(it); });
    const Apk = global.ChoiminiApk; if(!Apk){ console.warn("[LinuxFS] 백업 불가: ChoiminiApk 없음"); return 0; }
    let n = 0;
    for(const name of Object.keys(groups)){
      try{
        const g = groups[name], zpath = "/backup/" + name.replace(/[\\/]/g, "_") + ".zip";
        const entries = [], used = new Set();
        const old = state.fs[zpath];
        if(old && typeof old.content === "string" && /^data:/.test(old.content)){
          try{ const list = await Apk.readZip(toBytes(old.content)); for(const z of list){ entries.push({ name:z.name, data: await z.read() }); used.add(z.name); } }catch(e){ console.warn("[LinuxFS] 기존 백업 읽기 실패", e); }
        }
        g.list.forEach(it => {
          let nm = it.path.startsWith(g.root) ? it.path.slice(g.root.length) : it.path.replace(/^\//, "");
          if(it.label === "변경" || used.has(nm)){ const m = /^(.*?)(\.[^./]+)?$/.exec(nm); nm = m[1] + " (" + (it.label || "삭제") + " " + stamp(it.ts) + ")" + (m[2] || ""); }
          if(used.has(nm)){ const m = /^(.*?)(\.[^./]+)?$/.exec(nm); let k = 2, cand; do{ cand = m[1] + " #" + (k++) + (m[2] || ""); }while(used.has(cand)); nm = cand; } // 같은 초에 여러 번 바뀐 경우 이름이 겹치지 않게
          used.add(nm); entries.push({ name:nm, data: toBytes(it.content) });
        });
        { // 같은 파일의 "변경" 백업은 최근 5개만 남긴다(저장공간 보호)
          const byBase = {}; entries.forEach((en, i) => { const m = /^(.*) \(변경 (\d{8}-\d{6})\)(?: #\d+)?(\.[^./]+)?$/.exec(en.name); if(m){ (byBase[m[1] + (m[3] || "")] = byBase[m[1] + (m[3] || "")] || []).push({ i, t: m[2] }); } });
          const drop = new Set(); Object.keys(byBase).forEach(b => { const l = byBase[b].sort((a, c) => a.t < c.t ? 1 : -1); l.slice(5).forEach(x => drop.add(x.i)); });
          if(drop.size){ const keep = entries.filter((_, i) => !drop.has(i)); entries.length = 0; keep.forEach(x => entries.push(x)); }
        }
        const { sec1, cd, count } = await Apk.zipParts(entries);
        const e22 = new Uint8Array(22), dv = new DataView(e22.buffer);
        dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, count, true); dv.setUint16(10, count, true); dv.setUint32(12, cd.length, true); dv.setUint32(16, sec1.length, true);
        const all = new Uint8Array(sec1.length + cd.length + 22); all.set(sec1, 0); all.set(cd, sec1.length); all.set(e22, sec1.length + cd.length);
        sysDepth++; try{ writeFile(zpath, "data:application/zip;base64," + Apk.u8ToB64(all), "application/zip"); state.fs[zpath].backupOf = name; state.fs[zpath].fileCount = entries.length; persist(); }finally{ sysDepth--; }
        n += g.list.length;
      }catch(e){
        // §9.2: 백업 실패를 조용히 넘기지 않는다. 사용자가 알아야 복구 여부를 판단할 수 있다.
        console.warn("[LinuxFS] 백업 실패:", name, e);
        try{ if(global.__choiminiBackupFailed) global.__choiminiBackupFailed(name, String(e && e.message || e)); }catch(_){}
      }
    }
    return n;
  }
  function backupList(){
    purgeExpired();
    return childrenOf("/backup").filter(k => state.fs[k].type === "file").map(k => { const e = state.fs[k]; return { path:k, name: baseName(k), project: e.backupOf || baseName(k).replace(/\.zip$/i, ""), size: e.size || 0, updatedAt: e.updatedAt || 0, expiresAt: (e.updatedAt || 0) + BACKUP_MS, fileCount: e.fileCount || 0 }; }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function isTextBytes(u){ try{ new TextDecoder("utf-8", { fatal:true }).decode(u); return !u.includes(0); }catch(_){ return false; } }
  const MIME_BY_EXT = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", pdf:"application/pdf", zip:"application/zip", mp3:"audio/mpeg", mp4:"video/mp4" };
  async function backupRestore(path){
    const e = state.fs[normPath(path)]; if(!e) throw new Error("백업 파일 없음");
    const Apk = global.ChoiminiApk; if(!Apk) throw new Error("zip 모듈이 없어요");
    const proj = e.backupOf || baseName(path).replace(/\.zip$/i, "");
    const base = "/user/projects/" + proj + "/";
    let count = 0;
    for(const z of await Apk.readZip(toBytes(e.content))){
      if(z.name.endsWith("/")) continue;
      const u = await z.read(); let dst = base + z.name;
      if(exists(dst)){ const m = /^(.*?)(\.[^./]+)?$/.exec(dst); dst = m[1] + " (복원)" + (m[2] || ""); }
      const ext = (z.name.split(".").pop() || "").toLowerCase();
      if(isTextBytes(u)) writeFile(dst, new TextDecoder().decode(u), "text/plain");
      else writeFile(dst, "data:" + (MIME_BY_EXT[ext] || "application/octet-stream") + ";base64," + Apk.u8ToB64(u), MIME_BY_EXT[ext] || "application/octet-stream");
      count++;
    }
    return { count, dir: base.slice(0, -1) };
  }
  function backupDelete(path){ const k = normPath(path); if(!/^\/backup\//.test(k) || !state.fs[k]) return false; rmRaw(k); persist(); return true; }

  function purgeExpired(){
    const now = nowTs(); let ch = false;
    childrenOf("/trash").forEach(k => { const e = state.fs[k]; if(e && (e.trashedAt || 0) + TRASH_MS < now){ rmRaw(k); ch = true; } });
    childrenOf("/backup").forEach(k => { const e = state.fs[k]; if(e && (e.updatedAt || e.createdAt || 0) + BACKUP_MS < now){ rmRaw(k); ch = true; } });
    if(ch) persist();
    return ch;
  }
  function asAI(fn){ aiDepth++; let r; try{ r = fn(); }catch(e){ aiDepth--; throw e; } if(r && typeof r.then === "function") return r.finally(() => { aiDepth--; }); aiDepth--; return r; }
  function asUser(fn){ const a = aiDepth; aiDepth = 0; try{ return fn(); }finally{ aiDepth = a; } }

  /* ---------------- 공개 API ---------------- */

  function ls(path){
    const p = normPath(joinPath(state.cwd, path || "."));
    if(!exists(p)) throw new Error(`경로 없음: ${p}`);
    if(isFile(p)) return [{ name: baseName(p), type:"file", size: state.fs[p].size||0 }];
    return childrenOf(p).map(c => ({
      name: baseName(c),
      type: state.fs[c].type,
      size: state.fs[c].type === "file" ? (state.fs[c].size||0) : undefined
    }));
  }

  function pwd(){ return state.cwd; }

  function cd(path){
    const p = normPath(joinPath(state.cwd, path || "/user"));
    if(!isDir(p)) throw new Error(`디렉터리 없음: ${p}`);
    state.cwd = p;
    persist();
    return p;
  }

  function mkdir(path){
    const p = normPath(joinPath(state.cwd, path));
    guard(p, "create");
    if(exists(p)) throw new Error(`이미 존재함: ${p}`);
    ensureParentDirs(p);
    state.fs[p] = { type:"dir", createdAt: nowTs() };
    persist();
    return p;
  }

  function touch(path){
    const p = normPath(joinPath(state.cwd, path));
    guard(p, exists(p) ? "edit" : "create");
    if(exists(p)) { state.fs[p].updatedAt = nowTs(); persist(); return p; }
    ensureParentDirs(p);
    state.fs[p] = { type:"file", content:"", mime:"text/plain", size:0, createdAt: nowTs(), updatedAt: nowTs() };
    persist();
    return p;
  }

  function writeFile(path, content, mime){
    const p = normPath(joinPath(state.cwd, path));
    guard(p, exists(p) ? "edit" : "create");
    const size = byteSize(content);
    if(size > MAX_FILE_BYTES) throw new Error(`파일이 너무 큼(가상 환경 상한 ${Math.round(MAX_FILE_BYTES/1024)}KB): ${p}`);
    const big = size > BIG_THRESHOLD;
    const prevE = exists(p) && state.fs[p].type==="file" ? state.fs[p] : null;
    const prevSize = prevE ? (prevE.size||0) : 0, prevBig = !!(prevE && prevE.bigId);
    if(big){ if(bigBytes() - (prevBig ? prevSize : 0) + size > MAX_BIG_TOTAL) throw new Error("Linux_Local 큰 파일 저장공간이 가득 참 (총 " + Math.round(MAX_BIG_TOTAL/1048576) + "MB)"); }
    else if(totalBytes() - (prevBig ? 0 : prevSize) + size > MAX_TOTAL_BYTES) throw new Error("Linux_Local 저장공간이 가득 참");
    if(prevE && aiDepth && !sysDepth && !inSystem(p) && prevE.content !== content) captureForBackup(p, "변경"); // 덮어쓰기 전 옛 내용 백업
    ensureParentDirs(p);
    if(big){
      const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      BIG.set(id, content); idbPut(id, content);
      state.fs[p] = attachBig({ type:"file", bigId:id, locked: (prevE && prevE.locked) || undefined, mime: mime || (prevE && prevE.mime) || "application/octet-stream", size, createdAt:(prevE ? prevE.createdAt : nowTs()), updatedAt: nowTs() });
      if(!persist()) throw new Error("저장 실패: 브라우저 저장공간 부족");
      return p;
    }
    const wasLocked = !!(prevE && prevE.locked);
    state.fs[p] = {
      type:"file", content: content, mime: mime || (state.fs[p]&&state.fs[p].mime) || "text/plain",
      size, createdAt: (exists(p) ? state.fs[p].createdAt : nowTs()), updatedAt: nowTs()
    };
    if(wasLocked) state.fs[p].locked = true;
    if(!persist()) throw new Error("저장 실패: 브라우저 저장공간 부족");
    return p;
  }

  function readFile(path){
    const p = normPath(joinPath(state.cwd, path));
    if(!isFile(p)) throw new Error(`파일 없음: ${p}`);
    return state.fs[p].content;
  }

  function rm(path, recursive){
    const p = normPath(joinPath(state.cwd, path));
    if(DEFAULT_DIRS.includes(p)) throw new Error(`기본 디렉터리는 삭제할 수 없음: ${p}`);
    if(!exists(p)) throw new Error(`없음: ${p}`);
    guard(p, "delete", true);
    if(isDir(p)){
      const kids = childrenOf(p);
      if(kids.length && !recursive) throw new Error(`비어있지 않은 디렉터리(recursive 필요): ${p}`);
      captureForBackup(p);
      const prefix = p + "/";
      Object.keys(state.fs).filter(k => k===p || k.startsWith(prefix)).forEach(k => delete state.fs[k]);
    } else {
      captureForBackup(p);
      delete state.fs[p];
    }
    persist();
    return p;
  }

  function mv(from, to){
    const src = normPath(joinPath(state.cwd, from));
    let dst = normPath(joinPath(state.cwd, to));
    if(!exists(src)) throw new Error(`없음: ${src}`);
    if(isDir(dst)) dst = joinPath(dst, baseName(src));
    guard(src, "move", true); guard(dst, "edit", true);
    if(isFile(src) && isFile(dst)) captureForBackup(dst, "변경"); // 같은 이름 파일을 덮어쓰면 옛 파일 백업
    if(isFile(src)){
      state.fs[dst] = Object.assign(cloneEntry(state.fs[src]), { updatedAt: nowTs() });
      delete state.fs[src];
    } else {
      const prefix = src + "/";
      const moves = Object.keys(state.fs).filter(k => k===src || k.startsWith(prefix));
      moves.forEach(k => {
        const rel = k.slice(src.length);
        const nk = dst + rel;
        state.fs[nk] = state.fs[k];
        delete state.fs[k];
      });
    }
    persist();
    return dst;
  }

  function cp(from, to){
    const src = normPath(joinPath(state.cwd, from));
    let dst = normPath(joinPath(state.cwd, to));
    if(!exists(src)) throw new Error(`없음: ${src}`);
    if(isDir(dst)) dst = joinPath(dst, baseName(src));
    guard(dst, "copy");
    if(isFile(src)){
      writeFile(dst, state.fs[src].content, state.fs[src].mime);
    } else {
      const prefix = src + "/";
      const copies = Object.keys(state.fs).filter(k => k===src || k.startsWith(prefix));
      copies.forEach(k => {
        const rel = k.slice(src.length);
        const nk = dst + rel;
        state.fs[nk] = cloneEntry(state.fs[k]);
      });
      persist();
    }
    return dst;
  }

  function find(path, namePattern){
    const p = normPath(joinPath(state.cwd, path || "."));
    if(!exists(p)) throw new Error(`없음: ${p}`);
    const re = namePattern ? new RegExp(namePattern.split("*").map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join(".*"), "i") : null;
    const prefix = p === "/" ? "/" : p + "/";
    const out = [];
    if(!re || re.test(baseName(p))) out.push(p);
    Object.keys(state.fs).forEach(k => {
      if(k === p || !k.startsWith(prefix)) return;
      if(!re || re.test(baseName(k))) out.push(k);
    });
    return out.sort();
  }

  function grep(pattern, path){
    const p = normPath(joinPath(state.cwd, path || "."));
    if(!exists(p)) throw new Error(`없음: ${p}`);
    const re = new RegExp(pattern, "i");
    const targets = isFile(p) ? [p] : find(p).filter(k => isFile(k));
    const out = [];
    targets.forEach(t => {
      const content = state.fs[t].content || "";
      String(content).split("\n").forEach((line, i) => {
        if(re.test(line)) out.push(`${t}:${i+1}: ${line}`);
      });
    });
    return out;
  }

  function head(path, n){
    const content = readFile(path);
    return String(content).split("\n").slice(0, n || 10).join("\n");
  }
  function tail(path, n){
    const content = readFile(path);
    const lines = String(content).split("\n");
    return lines.slice(Math.max(0, lines.length - (n || 10))).join("\n");
  }

  /* ---------------- 패키지 매니저 (Termux 스타일, 시뮬레이션) ----------------
     실제로 바이너리를 내려받아 실행하는 것이 아니라, 설치 여부를 Linux_Local/package
     아래 메타데이터로 기록하는 방식. 순수 브라우저 환경 제약(스펙 3번 응답) 안에서
     실제로 동작하는 기능(예: 이미지 변환은 Canvas API로 진짜 변환됨)과,
     아직 실제 엔진이 연결되지 않은 기능(python 실행 등)을 명확히 구분해서 알려줌. */
  const REAL_CAPABILITIES = {
    // 실제로 브라우저 내장 API만으로 지금 바로 동작하는 것들
    "image-convert": true // Canvas API 기반 이미지 포맷 변환
  };
  function pkgPath(name){ return "/package/" + name; }
  function pkgInstall(name){
    if(!name) throw new Error("패키지 이름 필요");
    const p = pkgPath(name);
    if(exists(p)){ return { name, alreadyInstalled: true }; }
    ensureParentDirs(p);
    state.fs[p] = {
      type:"file", mime:"application/json",
      content: JSON.stringify({ name, installedAt: nowTs(), simulated: true }),
      size: 0, createdAt: nowTs(), updatedAt: nowTs()
    };
    persist();
    return { name, alreadyInstalled: false };
  }
  function pkgList(){
    return childrenOf("/package").map(baseName);
  }
  function pkgIsInstalled(name){ return exists(pkgPath(name)); }

  /* ---------------- 이미지 변환 (실제 동작 · Canvas API) ---------------- */
  function convertImage(path, format){
    const p = normPath(joinPath(state.cwd, path));
    if(!isFile(p)) throw new Error(`파일 없음: ${p}`);
    const entry = state.fs[p];
    if(!/^image\//.test(entry.mime||"")) throw new Error(`이미지 파일이 아님: ${p} (${entry.mime})`);
    const fmt = (format||"jpeg").toLowerCase().replace("jpg","jpeg");
    if(!["png","jpeg","webp"].includes(fmt)) throw new Error("지원 형식: png, jpeg, webp");
    const mimeOut = "image/" + fmt;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try{
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          if(fmt === "jpeg"){ ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height); }
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL(mimeOut, 0.92);
          if(!dataUrl.startsWith("data:" + mimeOut + ";")) throw new Error("브라우저가 이 이미지 형식을 지원하지 않아요");
          const outPath = p.replace(/\.[^./]+$/, "") + "." + (fmt==="jpeg"?"jpg":fmt);
          const outP = writeFile(outPath, dataUrl, mimeOut);
          resolve(outP);
        }catch(e){ reject(e); }
      };
      img.onerror = () => reject(new Error("이미지 디코딩 실패"));
      img.src = entry.content;
    });
  }

  /* ---------------- 업로드 파일 저장 헬퍼 ---------------- */
  // handleFiles()에서 pendingFiles로 만든 것과 같은 형태({name,type,isImg,dataUrl,text})를
  // user/download/ 에 그대로 저장한다.
  function saveUploaded(file){
    const name = (file.name || ("file_" + nowTs())).replace(/[/\\]/g, "_");
    const target = "/user/download/" + name;
    const content = file.isImg ? file.dataUrl : (file.binUrl ? file.binUrl : (file.fullText != null ? file.fullText : (file.text != null ? file.text : "")));
    try{
      writeFile(target, content, file.type || (file.isImg ? "image/*" : "text/plain"));
      return target;
    }catch(e){
      console.warn("[LinuxFS] 업로드 파일 저장 실패:", e.message);
      return null;
    }
  }

  function usageSummary(){
    return { usedBytes: totalBytes(), capBytes: MAX_TOTAL_BYTES, fileCount: Object.values(state.fs).filter(e=>e.type==="file").length };
  }

  function resetAll(){
    state = blankState();
    persist();
  }

  /* ---------------- 셸(choimini-shell.js)용 저수준 API ---------------- */
  function abs(p){ return normPath(joinPath(state.cwd, p)); }
  function stat(p){
    const k = abs(p), e = state.fs[k];
    return e ? Object.assign({ path:k, name: baseName(k) }, e) : null;
  }
  function setMeta(p, meta){
    const k = abs(p);
    if(!state.fs[k]) throw new Error(`없음: ${k}`);
    guard(k, "edit");
    Object.assign(state.fs[k], meta); persist(); return k;
  }
  function mkdirp(p){
    const k = abs(p);
    if(isFile(k)) throw new Error(`파일이 이미 존재함: ${k}`);
    if(isDir(k)) return k;
    guard(k, "create");
    ensureParentDirs(k);
    state.fs[k] = { type:"dir", createdAt: nowTs() };
    persist(); return k;
  }
  // 변경 감지용 스냅샷 (에이전트 한 단계 전/후 비교 → "파일 생성됨/편집됨" 표시)
  function snapshot(){
    const o = {};
    for(const k in state.fs){ const e = state.fs[k]; if(e.type === "file" && !k.startsWith("/cmds/") && !k.startsWith("/package/") && !k.startsWith("/trash/") && !k.startsWith("/backup/")) o[k] = (e.updatedAt || 0) + ":" + (e.size || 0) + ":" + (e.content && e.content.length || 0); }
    return o;
  }
  function diffSnapshot(before){
    const after = snapshot(), created = [], edited = [], deleted = [];
    Object.keys(after).forEach(k => { if(!(k in before)) created.push(k); else if(before[k] !== after[k]) edited.push(k); });
    Object.keys(before).forEach(k => { if(!(k in after)) deleted.push(k); });
    return { created, edited, deleted };
  }
  function dirChildren(p){ return childrenOf(abs(p)).map(baseName); }
  // 디렉터리에 (없을 때만) 항목을 한꺼번에 등록하고 저장은 한 번만 한다 (/cmds 동기화용)
  function seedFiles(map){
    let changed = false;
    for(const k in map){
      const p = normPath(k);
      if(state.fs[p]) continue;
      ensureParentDirs(p);
      const content = map[k];
      state.fs[p] = { type:"file", content, mime:"application/json", size: content.length, createdAt: nowTs(), updatedAt: nowTs() };
      changed = true;
    }
    if(changed) persist();
    return changed;
  }

  /* ---------------- 사용 가능한 명령어 (동적) ----------------
     하드코딩 목록이 아니라 choimini-shell.js 의 명령어 레지스트리 + /cmds 폴더의 실제 항목을
     합쳐서 돌려준다. /cmds 에 새 파일이 생기면 별도 업데이트 없이 바로 인식된다. */
  function availableCmds(mode){
    if(global.ChoiminiShell && typeof global.ChoiminiShell.list === "function") return global.ChoiminiShell.list();
    return mode === "code" ? BUILTIN_CMDS.concat(CODE_EXTRA_CMDS) : BUILTIN_CMDS;
  }

  const api = global.LinuxFS = {
    setLock, lockRoot, userDelete, trashList, trashRestore, trashPurge, trashEmpty, backupList, backupRestore, backupDelete, flushBackups, purgeExpired, asAI, asUser,
    clearLockConsent(){ consent.clear(); }, onLockRequest: null, TRASH_MS, BACKUP_MS,
    ls, pwd, cd, mkdir, touch, writeFile, readFile, rm, mv, cp, find, grep, head, tail,
    pkgInstall, pkgList, pkgIsInstalled,
    convertImage, saveUploaded, usageSummary, resetAll, availableCmds,
    normPath, joinPath, abs, stat, setMeta, mkdirp, dirChildren, seedFiles, snapshot, diffSnapshot, exists, isDir, isFile, baseName, parentOf,
    get cwd(){ return state.cwd; }
  };

  /* ============================================================================
     미디어 편집 (브라우저 Canvas · MediaRecorder) — v2.9
     ----------------------------------------------------------------------------
     기존 도구 이름과 인자(convert_image / edit_image / create_video / edit_video)는 그대로 두고
     선택 인자만 추가했다. 새 인자를 안 쓰면 예전과 같은 결과가 나온다.
       · fonts    : Google Fonts 웹폰트를 필요할 때 불러온다 (한글 30여 종 + 영문)
       · filters  : 밝기·대비·채도·흑백·세피아·반전·색조·블러·선명·픽셀화·포스터·색온도·틴트·듀오톤·필름 노이즈
       · preset   : vintage | cinematic | warm | cool | bw | noir | vivid | fade | dreamy | retro
       · layers   : text | image | rect | ellipse | shape | line | arrow | gradient | pattern | border | particles | progress
       · 동영상    : 최대 3840×2160 · 60fps · quality/bitrate, 레이어 애니메이션, 장면 전환 9종
     ============================================================================ */
  const BLEND_MODES = { normal:"source-over", "source-over":"source-over", multiply:"multiply", screen:"screen", overlay:"overlay", darken:"darken", lighten:"lighten", "color-dodge":"color-dodge", "color-burn":"color-burn", "hard-light":"hard-light", "soft-light":"soft-light", difference:"difference", exclusion:"exclusion", hue:"hue", saturation:"saturation", color:"color", luminosity:"luminosity" };
  const DEFAULT_FONT = "'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif";
  const MAX_VIDEO_SEC = 120, MAX_IMG = 8192, MAX_VW = 3840, MAX_VH = 2160;
  // 별명(한글/영문) → Google Fonts 이름
  const FONT_CATALOG = {
    // 한글 고딕·본문
    "noto sans kr":"Noto Sans KR", "본고딕":"Noto Sans KR", "노토산스":"Noto Sans KR",
    "nanum gothic":"Nanum Gothic", "나눔고딕":"Nanum Gothic",
    "gothic a1":"Gothic A1", "고딕a1":"Gothic A1",
    "ibm plex sans kr":"IBM Plex Sans KR", "플렉스":"IBM Plex Sans KR",
    "gowun dodum":"Gowun Dodum", "고운돋움":"Gowun Dodum",
    "sunflower":"Sunflower", "해바라기":"Sunflower",
    "orbit":"Orbit", "오르빗":"Orbit",
    // 한글 명조·세리프
    "noto serif kr":"Noto Serif KR", "본명조":"Noto Serif KR", "노토세리프":"Noto Serif KR",
    "nanum myeongjo":"Nanum Myeongjo", "나눔명조":"Nanum Myeongjo",
    "gowun batang":"Gowun Batang", "고운바탕":"Gowun Batang",
    "hahmlet":"Hahmlet", "함렛":"Hahmlet",
    "song myung":"Song Myung", "송명":"Song Myung",
    "diphylleia":"Diphylleia", "산하엽":"Diphylleia",
    // 한글 제목·굵은 디자인
    "black han sans":"Black Han Sans", "검은고딕":"Black Han Sans", "블랙한산스":"Black Han Sans",
    "do hyeon":"Do Hyeon", "도현":"Do Hyeon", "배민도현":"Do Hyeon",
    "jua":"Jua", "주아":"Jua", "배민주아":"Jua",
    "bagel fat one":"Bagel Fat One", "베이글":"Bagel Fat One",
    "gasoek one":"Gasoek One", "가석":"Gasoek One",
    "gugi":"Gugi", "구기":"Gugi",
    "black and white picture":"Black And White Picture", "흑백사진":"Black And White Picture",
    "moirai one":"Moirai One", "모이라이":"Moirai One",
    "dongle":"Dongle", "동글":"Dongle",
    "stylish":"Stylish", "스타일리시":"Stylish",
    "yeon sung":"Yeon Sung", "연성":"Yeon Sung",
    "cute font":"Cute Font", "귀여운":"Cute Font",
    // 한글 손글씨·붓글씨
    "nanum pen script":"Nanum Pen Script", "나눔손글씨펜":"Nanum Pen Script", "손글씨":"Nanum Pen Script",
    "nanum brush script":"Nanum Brush Script", "나눔손글씨붓":"Nanum Brush Script", "붓글씨":"Nanum Brush Script",
    "gaegu":"Gaegu", "개구":"Gaegu",
    "hi melody":"Hi Melody", "하이멜로디":"Hi Melody",
    "poor story":"Poor Story", "푸어스토리":"Poor Story",
    "gamja flower":"Gamja Flower", "감자꽃":"Gamja Flower",
    "single day":"Single Day", "싱글데이":"Single Day",
    "east sea dokdo":"East Sea Dokdo", "동해독도":"East Sea Dokdo",
    "dokdo":"Dokdo", "독도":"Dokdo",
    "kirang haerang":"Kirang Haerang", "기랑해랑":"Kirang Haerang",
    "nanum gothic coding":"Nanum Gothic Coding", "나눔고딕코딩":"Nanum Gothic Coding",
    // 영문
    "roboto":"Roboto", "montserrat":"Montserrat", "poppins":"Poppins", "inter":"Inter", "oswald":"Oswald",
    "bebas neue":"Bebas Neue", "anton":"Anton", "archivo black":"Archivo Black", "russo one":"Russo One", "righteous":"Righteous",
    "playfair display":"Playfair Display", "abril fatface":"Abril Fatface", "cinzel":"Cinzel", "merriweather":"Merriweather",
    "lobster":"Lobster", "pacifico":"Pacifico", "dancing script":"Dancing Script", "great vibes":"Great Vibes", "caveat":"Caveat",
    "permanent marker":"Permanent Marker", "shadows into light":"Shadows Into Light", "bungee":"Bungee", "fredoka":"Fredoka",
    "comfortaa":"Comfortaa", "orbitron":"Orbitron", "press start 2p":"Press Start 2P", "rubik mono one":"Rubik Mono One",
    "monoton":"Monoton", "creepster":"Creepster", "fira code":"Fira Code"
  };
  const SYSTEM_FONTS = /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|arial|helvetica|times new roman|georgia|courier new|verdana|malgun gothic|apple sd gothic neo|segoe ui)$/i;
  const fontState = {}; // family → Promise<boolean>
  function fontFamilyOf(name){
    const n = String(name || "").trim().replace(/^['"]|['"]$/g, "");
    if(!n) return null;
    const k = n.toLowerCase().replace(/\s+/g, " ");
    return FONT_CATALOG[k] || FONT_CATALOG[k.replace(/\s/g, "")] || n;
  }
  // Google Fonts 에서 필요한 글꼴만 불러온다. 실패하면 기본 글꼴로 대신 그린다.
  function loadFont(family, weight, sample){
    if(!family || SYSTEM_FONTS.test(family)) return Promise.resolve(true);
    const key = family;
    if(!fontState[key]){
      fontState[key] = new Promise(resolve => {
        try{
          if(!document.querySelector(`link[data-chm-font="${CSS.escape(family)}"]`)){
            const l = document.createElement("link"); l.rel = "stylesheet"; l.dataset.chmFont = family;
            l.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family).replace(/%20/g, "+") + ":wght@100;200;300;400;500;600;700;800;900&display=block";
            l.onerror = () => { // 굵기 목록이 없는 글꼴(한 가지 굵기)은 굵기 지정 없이 다시 시도
              const l2 = document.createElement("link"); l2.rel = "stylesheet"; l2.dataset.chmFont = family + "#1";
              l2.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family).replace(/%20/g, "+") + "&display=block";
              l2.onload = () => resolve(true); l2.onerror = () => resolve(false); document.head.appendChild(l2);
            };
            l.onload = () => resolve(true);
            document.head.appendChild(l);
          }else resolve(true);
        }catch(_){ resolve(false); }
        setTimeout(() => resolve(false), 10000);
      });
    }
    return fontState[key].then(async ok => {
      if(!ok) return false;
      try{
        await Promise.race([document.fonts.load(`${weight || 400} 48px "${family}"`, sample || "가A1"), new Promise(r => setTimeout(r, 8000))]);
        return document.fonts.check(`${weight || 400} 48px "${family}"`, sample || "가A1");
      }catch(_){ return false; }
    });
  }
  async function ensureFonts(layers, notes){
    const want = new Map();
    for(const L of layers || []){
      if(!L || String(L.type || (L.text != null ? "text" : "")).toLowerCase() !== "text") continue;
      const fam = fontFamilyOf(opt(L, "font", "font_family"));
      if(!fam) continue;
      const w = String(opt(L, "weight", "font_weight") || (opt(L, "bold") ? "700" : "400")).replace("bold", "700").replace("normal", "400");
      want.set(fam + "|" + w, { fam, w, text: String(L.text || "").slice(0, 60) });
    }
    for(const { fam, w, text } of want.values()){
      const ok = await loadFont(fam, w, text);
      if(!ok) notes.push(`글꼴 '${fam}'을(를) 불러오지 못해 기본 글꼴로 그렸어요`);
    }
  }
  function fontList(){
    const uniq = {}; Object.entries(FONT_CATALOG).forEach(([k, v]) => { if(/[가-힣]/.test(k)) (uniq[v] = uniq[v] || []).push(k); else uniq[v] = uniq[v] || []; });
    return Object.entries(uniq).map(([f, ko]) => f + (ko.length ? " (" + ko.join("/") + ")" : "")).join("\n");
  }

  // snake_case / camelCase 둘 다 받는다 (모델이 섞어 쓴다)
  function opt(o, ...keys){ if(!o) return undefined; for(const k of keys){ if(o[k] != null) return o[k]; const c = k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()); if(o[c] != null) return o[c]; } return undefined; }
  // 120 / "50%" / "center" → 픽셀
  function len(v, total, def){
    if(v == null || v === "") return def;
    if(typeof v === "number") return v;
    const s = String(v).trim();
    if(/^-?\d+(\.\d+)?%$/.test(s)) return parseFloat(s) / 100 * total;
    if(s === "center") return total / 2;
    const n = Number(s.replace(/px$/, ""));
    return Number.isFinite(n) ? n : def;
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));
  function mulberry(seed){ let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function guessMime(p){
    const ext = (String(p).match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    return ({ png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", bmp:"image/bmp", svg:"image/svg+xml", webm:"video/webm", mp4:"video/mp4", mov:"video/quicktime", ogv:"video/ogg", mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", m4a:"audio/mp4", aac:"audio/aac", opus:"audio/ogg" })[ext.toLowerCase()] || "";
  }
  function mediaEntry(path, kind){
    const p = abs(path), e = state.fs[p];
    const re = kind === "image" ? /^image\// : kind === "video" ? /^video\// : kind === "audio" ? /^audio\// : /^(image|video|audio)\//;
    if(!e || e.type !== "file") throw new Error("파일을 찾을 수 없어요: " + p);
    if(!re.test(e.mime || "") && !(kind && guessMime(p).startsWith(kind + "/"))) throw new Error(`${kind === "image" ? "이미지" : kind === "video" ? "동영상" : kind === "audio" ? "오디오" : "미디어"} 파일이 아니에요: ${p} (${e.mime || "형식 모름"})`);
    return { path: p, entry: e };
  }
  function loadImageEntry(path){
    const { entry, path: p } = mediaEntry(path, "image");
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("이미지 디코딩 실패: " + p)); i.src = entry.content; });
  }
  // data: URL 을 blob: URL 로 바꿔 미디어 요소에 넘긴다 (큰 영상도 빠르고 탐색이 안정적)
  async function blobUrl(content){
    try{ const b = await (await fetch(content)).blob(); return { url: URL.createObjectURL(b), revoke(){ try{ URL.revokeObjectURL(this.url); }catch(_){} } }; }
    catch(_){ return { url: content, revoke(){} }; }
  }
  async function loadMediaEl(path, kind){
    const { entry, path: p } = mediaEntry(path, kind);
    const src = await blobUrl(entry.content);
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.muted = true; el.playsInline = true; el.preload = "auto"; el.crossOrigin = "anonymous"; el.src = src.url;
    await new Promise((resolve, reject) => { el.onloadedmetadata = resolve; el.onerror = () => reject(new Error((kind === "audio" ? "오디오" : "동영상") + "를 열 수 없어요: " + p)); });
    await fixDuration(el);
    el._revoke = () => { try{ el.pause(); el.removeAttribute("src"); el.load(); }catch(_){} src.revoke(); };
    return el;
  }
  // MediaRecorder 로 만든 WebM 은 길이 정보가 없어 duration 이 Infinity 로 나온다 → 끝으로 탐색해서 실제 길이를 얻는다
  async function fixDuration(el){
    if(Number.isFinite(el.duration) && el.duration > 0) return;
    await new Promise(resolve => {
      const done = () => { el.removeEventListener("durationchange", check); el.removeEventListener("timeupdate", check); clearTimeout(t); resolve(); };
      const check = () => { if(Number.isFinite(el.duration) && el.duration > 0) done(); };
      const t = setTimeout(done, 4000);
      el.addEventListener("durationchange", check); el.addEventListener("timeupdate", check);
      try{ el.currentTime = 1e7; }catch(_){ done(); }
    });
    await seekTo(el, 0);
    if(!(Number.isFinite(el.duration) && el.duration > 0)) throw new Error("동영상 길이를 알 수 없어요");
  }
  function seekTo(el, t){
    return new Promise((resolve, reject) => {
      if(Math.abs((el.currentTime || 0) - t) < 0.001 && el.readyState >= 2){ resolve(); return; }
      const to = setTimeout(() => { cleanup(); resolve(); }, 5000);
      const ok = () => { cleanup(); resolve(); }, bad = () => { cleanup(); reject(new Error("영상 탐색 실패")); };
      function cleanup(){ clearTimeout(to); el.removeEventListener("seeked", ok); el.removeEventListener("error", bad); }
      el.addEventListener("seeked", ok); el.addEventListener("error", bad);
      el.currentTime = t;
    });
  }
  function newCanvas(w, h){ const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); const x = c.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; return c; }
  function ctx2d(c){ const x = c.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; return x; }
  function checkSize(w, h, maxW, maxH){
    maxW = maxW || MAX_IMG; maxH = maxH || maxW;
    if(!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > maxW || h > maxH || w * h > 40000000) throw new Error(`크기가 올바르지 않아요 (최대 ${maxW}×${maxH}): ${w}×${h}`);
  }
  // 크게 줄일 때는 절반씩 단계적으로 줄여 계단 현상 없이 선명하게
  function prescale(src, sx, sy, sw, sh, tw, th){
    if(!(sw / tw > 2 || sh / th > 2)) return null;
    let cw = sw, ch = sh, cur = src, cx = sx, cy = sy;
    while(cw / 2 >= tw && ch / 2 >= th){
      const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
      const c = newCanvas(nw, nh); ctx2d(c).drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
      cur = c; cx = 0; cy = 0; cw = nw; ch = nh;
    }
    return cur === src ? null : cur;
  }
  function canvasToImage(c){
    return new Promise((resolve, reject) => c.toBlob(b => { if(!b){ reject(new Error("blob")); return; } const i = new Image(), u = URL.createObjectURL(b); i.onload = () => { resolve(i); setTimeout(() => URL.revokeObjectURL(u), 60000); }; i.onerror = reject; i.src = u; }, "image/png"));
  }
  function roundRectPath(ctx, x, y, w, h, r){
    r = Math.max(0, Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }
  // 도형 경로: star, polygon, triangle, diamond, heart, speech(말풍선), burst(폭발), cross, ring, hexagon …
  const SHAPES = ["rect","rounded","ellipse","circle","star","polygon","hexagon","pentagon","octagon","triangle","diamond","heart","speech","thought","burst","cross","ring","arrow-right","arrow-left","ribbon"];
  function shapePath(ctx, kind, x, y, w, h, L){
    kind = String(kind || "rect").toLowerCase();
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const poly = (n, inner, rot) => { ctx.beginPath(); const pts = inner ? n * 2 : n; for(let i = 0; i < pts; i++){ const a = rot + i * Math.PI * 2 / pts, f = inner && i % 2 ? inner : 1; const px = cx + Math.cos(a) * rx * f, py = cy + Math.sin(a) * ry * f; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); };
    switch(kind){
      case "ellipse": case "circle": ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); return;
      case "rounded": roundRectPath(ctx, x, y, w, h, len(opt(L, "radius"), Math.min(w, h), Math.min(w, h) * 0.18)); return;
      case "star": poly(Number(opt(L, "points") || 5), Number(opt(L, "inner") || 0.45), -Math.PI / 2); return;
      case "burst": poly(Number(opt(L, "points") || 16), Number(opt(L, "inner") || 0.72), -Math.PI / 2); return;
      case "polygon": poly(Math.max(3, Number(opt(L, "sides") || 6)), 0, -Math.PI / 2); return;
      case "hexagon": poly(6, 0, -Math.PI / 2); return;
      case "pentagon": poly(5, 0, -Math.PI / 2); return;
      case "octagon": poly(8, 0, -Math.PI / 8 - Math.PI / 2); return;
      case "triangle": ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); return;
      case "diamond": ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(x + w, cy); ctx.lineTo(cx, y + h); ctx.lineTo(x, cy); ctx.closePath(); return;
      case "cross": { const t = Math.min(w, h) * 0.32; ctx.beginPath(); ctx.rect(cx - t / 2, y, t, h); ctx.rect(x, cy - t / 2, w, t); return; }
      case "ring": ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.ellipse(cx, cy, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2, true); return;
      case "heart": {
        ctx.beginPath(); ctx.moveTo(cx, y + h * 0.95);
        ctx.bezierCurveTo(x - w * 0.05, y + h * 0.55, x + w * 0.05, y - h * 0.05, cx, y + h * 0.27);
        ctx.bezierCurveTo(x + w * 0.95, y - h * 0.05, x + w * 1.05, y + h * 0.55, cx, y + h * 0.95); ctx.closePath(); return;
      }
      case "speech": case "thought": {
        const tail = String(opt(L, "tail") || "bottom-left"), bh = h * 0.8, r = Math.min(w, bh) * 0.25;
        if(kind === "thought"){ ctx.beginPath(); ctx.ellipse(cx, y + bh / 2, rx, bh / 2, 0, 0, Math.PI * 2); const tx = /right/.test(tail) ? x + w * 0.78 : x + w * 0.22; ctx.moveTo(tx + h * 0.07, y + bh + h * 0.06); ctx.arc(tx, y + bh + h * 0.06, h * 0.07, 0, Math.PI * 2); ctx.moveTo(tx + (/right/.test(tail) ? 1 : -1) * w * 0.06 + h * 0.04, y + h * 0.96); ctx.arc(tx + (/right/.test(tail) ? 1 : -1) * w * 0.06, y + h * 0.96, h * 0.04, 0, Math.PI * 2); return; }
        roundRectPath(ctx, x, y, w, bh, r);
        const tx = /right/.test(tail) ? x + w * 0.72 : /center|middle/.test(tail) ? cx - w * 0.06 : x + w * 0.16;
        ctx.moveTo(tx, y + bh - 1); ctx.lineTo(tx + (/right/.test(tail) ? w * 0.14 : -w * 0.02), y + h); ctx.lineTo(tx + w * 0.12, y + bh - 1); ctx.closePath(); return;
      }
      case "arrow-right": case "arrow-left": {
        const d = kind === "arrow-left" ? -1 : 1, sx = d > 0 ? x : x + w, hx = sx + d * w * 0.6, ex = sx + d * w;
        ctx.beginPath(); ctx.moveTo(sx, cy - h * 0.2); ctx.lineTo(hx, cy - h * 0.2); ctx.lineTo(hx, y); ctx.lineTo(ex, cy); ctx.lineTo(hx, y + h); ctx.lineTo(hx, cy + h * 0.2); ctx.lineTo(sx, cy + h * 0.2); ctx.closePath(); return;
      }
      case "ribbon": { const n = w * 0.08; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - n, cy); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x + n, cy); ctx.closePath(); return; }
      default: roundRectPath(ctx, x, y, w, h, len(opt(L, "radius"), Math.min(w, h), 0));
    }
  }
  // 칠하기: "#fff" / ["#f00","#00f"] (그라디언트) / {colors:[…], direction:"down|up|left|right|diagonal|radial"}
  function makeFill(ctx, spec, x, y, w, h, defDir){
    if(spec == null) return null;
    let colors = null, dir = defDir || "down";
    if(Array.isArray(spec)) colors = spec;
    else if(typeof spec === "object"){ colors = spec.colors || [spec.from || "rgba(0,0,0,0)", spec.to || "rgba(0,0,0,.7)"]; dir = spec.direction || dir; }
    else return String(spec);
    if(colors.length < 2) return String(colors[0] || "#000");
    dir = String(dir).toLowerCase();
    let g;
    if(dir === "radial") g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
    else{
      const v = { down:[0,0,0,1], up:[0,1,0,0], right:[0,0,1,0], left:[1,0,0,0], diagonal:[0,0,1,1], "diagonal-up":[0,1,1,0] }[dir] || [0,0,0,1];
      g = ctx.createLinearGradient(x + v[0] * w, y + v[1] * h, x + v[2] * w, y + v[3] * h);
    }
    colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), String(c)));
    return g;
  }
  // 대상 상자(dw×dh)에 소스(sw×sh)를 맞춘 그리기 영역
  function fitRect(sw, sh, dw, dh, fit){
    if(fit === "contain" || fit === "cover"){
      const s = fit === "contain" ? Math.min(dw / sw, dh / sh) : Math.max(dw / sw, dh / sh);
      const w = sw * s, h = sh * s; return { x:(dw - w) / 2, y:(dh - h) / 2, w, h };
    }
    return { x:0, y:0, w:dw, h:dh };
  }
  // 위치: x/y(픽셀·%) 가 있으면 그 값(왼쪽 위 기준), 없으면 position(top-left … bottom-right, center) + margin
  function place(L, W, H, w, h, defMargin){
    const m = len(opt(L, "margin"), Math.min(W, H), defMargin != null ? defMargin : Math.round(Math.min(W, H) * 0.04));
    const pos = String(opt(L, "position", "anchor") || "").toLowerCase().replace(/[_\s]+/g, "-");
    let x, y;
    if(pos){
      x = /left/.test(pos) ? m : /right/.test(pos) ? W - w - m : (W - w) / 2;
      y = /top/.test(pos) ? m : /bottom/.test(pos) ? H - h - m : (H - h) / 2;
    }else{ x = 0; y = 0; }
    if(opt(L, "x") != null) x = len(opt(L, "x"), W, x);
    if(opt(L, "y") != null) y = len(opt(L, "y"), H, y);
    if(opt(L, "center_x", "cx") != null) x = len(opt(L, "center_x", "cx"), W, x + w / 2) - w / 2;
    if(opt(L, "center_y", "cy") != null) y = len(opt(L, "center_y", "cy"), H, y + h / 2) - h / 2;
    return { x, y: y + (L._oy || 0) };
  }
  function shadowOf(v){
    if(!v) return null;
    if(v === true) return { color:"rgba(0,0,0,.6)", blur:8, x:3, y:3 };
    return { color: v.color || "rgba(0,0,0,.6)", blur: Number(v.blur != null ? v.blur : 8), x: Number(v.x != null ? v.x : 3), y: Number(v.y != null ? v.y : 3) };
  }
  function setShadow(ctx, sh){ if(sh){ ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.x; ctx.shadowOffsetY = sh.y; } else { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; } }
  // 줄바꿈: 공백 기준, 너무 긴 단어(한글 포함)는 글자 단위
  function wrapText(ctx, text, maxW){
    const out = [];
    String(text).split(/\r?\n/).forEach(par => {
      if(!maxW || ctx.measureText(par).width <= maxW){ out.push(par); return; }
      let line = "";
      for(const word of par.split(/(\s+)/)){
        const test = line + word;
        if(ctx.measureText(test).width <= maxW){ line = test; continue; }
        if(line.trim()) out.push(line.trimEnd());
        line = word.trimStart();
        while(ctx.measureText(line).width > maxW && line.length > 1){
          let k = line.length; while(k > 1 && ctx.measureText(line.slice(0, k)).width > maxW) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      }
      if(line.trim() || !out.length) out.push(line.trimEnd());
    });
    return out;
  }
  /* ---- 레이어 애니메이션 (동영상) ----
     animation_in / animation(들어올 때), animation_out(나갈 때), animation_duration(초), loop(반복)
     in/out: fade, slide-up, slide-down, slide-left, slide-right, zoom-in, zoom-out, pop, bounce, spin, typewriter, blur-in, wipe
     loop: pulse, float, wiggle, blink, spin, shake, sway */
  const ANIMS = ["fade","slide-up","slide-down","slide-left","slide-right","zoom-in","zoom-out","pop","bounce","spin","typewriter","wipe","drop"];
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const easeBack = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  const easeBounce = p => { const n = 7.5625, d = 2.75; if(p < 1 / d) return n * p * p; if(p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75; if(p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375; return n * (p -= 2.625 / d) * p + 0.984375; };
  function animState(L, t, W, H, total){
    const st = { dx:0, dy:0, s:1, a:1, rot:0, reveal:1, wipe:1 };
    const base = Number(opt(L, "opacity") != null ? opt(L, "opacity") : 1);
    if(t == null){ st.a = base; return st; }
    const s0 = Number(opt(L, "start") || 0), e0 = opt(L, "end") != null ? Number(opt(L, "end")) : (total || Infinity);
    if(t < s0 || t > e0 + 1e-6){ st.a = 0; return st; }
    const f = Number(opt(L, "fade") || 0);
    let a = 1; if(f > 0){ a = Math.min(1, (t - s0) / f); if(Number.isFinite(e0)) a = Math.min(a, (e0 - t) / f); }
    const apply = (name, p) => {
      if(!name) return;
      const q = easeOut(p);
      switch(String(name).toLowerCase()){
        case "fade": a *= q; break;
        case "slide-up": st.dy += (1 - q) * H * 0.15; a *= q; break;
        case "slide-down": st.dy -= (1 - q) * H * 0.15; a *= q; break;
        case "slide-left": st.dx += (1 - q) * W * 0.2; a *= q; break;
        case "slide-right": st.dx -= (1 - q) * W * 0.2; a *= q; break;
        case "zoom-in": st.s *= 0.4 + 0.6 * q; a *= q; break;
        case "zoom-out": st.s *= 1.6 - 0.6 * q; a *= q; break;
        case "pop": st.s *= Math.max(0, easeBack(p)); a *= Math.min(1, p * 3); break;
        case "bounce": case "drop": st.dy -= (1 - easeBounce(p)) * H * 0.35; a *= Math.min(1, p * 4); break;
        case "spin": st.rot += (1 - q) * Math.PI * 2; st.s *= Math.max(0.01, q); break;
        case "typewriter": st.reveal = Math.min(st.reveal, p); break;
        case "wipe": st.wipe = Math.min(st.wipe, q); break;
      }
    };
    const dIn = Number(opt(L, "animation_duration") || 0.6);
    const nIn = opt(L, "animation_in", "animation", "animate");
    if(nIn){ const d = String(nIn) === "typewriter" && opt(L, "animation_duration") == null ? Math.max(0.6, String(L.text || "").length * 0.06) : dIn; apply(nIn, clamp01((t - s0) / d)); }
    const nOut = opt(L, "animation_out");
    if(nOut && Number.isFinite(e0)) apply(nOut === "typewriter" ? "fade" : nOut, clamp01((e0 - t) / dIn));
    const loop = opt(L, "loop"), sp = Number(opt(L, "loop_speed") || 1), lt = (t - s0) * sp * Math.PI * 2;
    switch(String(loop || "").toLowerCase()){
      case "pulse": st.s *= 1 + 0.06 * Math.sin(lt); break;
      case "float": st.dy += Math.sin(lt * 0.5) * H * 0.015; break;
      case "wiggle": st.rot += Math.sin(lt * 2) * 0.07; break;
      case "sway": st.rot += Math.sin(lt * 0.5) * 0.12; break;
      case "blink": a *= Math.sin(lt) > -0.3 ? 1 : 0.1; break;
      case "spin": st.rot += lt / 4; break;
      case "shake": st.dx += Math.sin(lt * 9) * W * 0.006; st.dy += Math.cos(lt * 7) * H * 0.004; break;
    }
    st.a = base * clamp01(a);
    return st;
  }
  function chromaKey(img, keyColor, tol){
    const c = newCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height), x = ctx2d(c);
    x.drawImage(img, 0, 0);
    const rgb = parseColor(keyColor || "#00ff00"); tol = Number(tol != null ? tol : 60);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for(let i = 0; i < a.length; i += 4){
      const dist = Math.sqrt((a[i] - rgb[0]) ** 2 + (a[i+1] - rgb[1]) ** 2 + (a[i+2] - rgb[2]) ** 2);
      if(dist < tol) a[i+3] = 0; else if(dist < tol * 1.5) a[i+3] = Math.round(a[i+3] * (dist - tol) / (tol * 0.5));
    }
    x.putImageData(d, 0, 0); return c;
  }
  function parseColor(s){
    const c = newCanvas(1, 1).getContext("2d"); c.fillStyle = "#000"; c.fillStyle = String(s); c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3]];
  }
  // 동영상 필름 노이즈용 타일 (미리 만들어 두고 매 프레임 위치만 바꾼다)
  let grainTiles = null;
  function grainTile(i){
    if(!grainTiles){
      grainTiles = [0, 1, 2].map(k => { const c = newCanvas(256, 256), x = c.getContext("2d"), d = x.createImageData(256, 256), r = mulberry(99 + k); for(let j = 0; j < d.data.length; j += 4){ const v = r() * 255; d.data[j] = d.data[j+1] = d.data[j+2] = v; d.data[j+3] = 255; } x.putImageData(d, 0, 0); return c; });
    }
    return grainTiles[i % 3];
  }
  function drawGrain(ctx, W, H, amount, t){
    amount = Number(amount); if(!(amount > 0)) return;
    ctx.save(); ctx.globalAlpha = Math.min(0.6, amount); ctx.globalCompositeOperation = "overlay";
    const k = t == null ? 0 : Math.max(0, Math.floor(t * 24)), tile = grainTile(k), ox = (k * 73) % 256, oy = (k * 151) % 256;
    ctx.translate(-ox, -oy); ctx.fillStyle = ctx.createPattern(tile, "repeat"); ctx.fillRect(0, 0, W + 256, H + 256); ctx.restore();
  }
  /* ---- 레이어 그리기 (이미지·동영상 공용) ---- */
  function drawLayers(ctx, W, H, layers, images, t, total){
    autoStack(ctx, layers || [], W, H, t, total);
    for(const L of layers || []){
      if(!L || typeof L !== "object") continue;
      const A = animState(L, t, W, H, total);
      if(A.a <= 0 || A.s <= 0) continue;
      const type = layerType(L);
      ctx.save();
      ctx.globalAlpha = A.a;
      const blend = BLEND_MODES[String(opt(L, "blend") || "normal").toLowerCase()];
      if(blend) ctx.globalCompositeOperation = blend;
      const sh = shadowOf(opt(L, "shadow"));
      const rot = Number(opt(L, "rotate") || 0) * Math.PI / 180 + A.rot;
      // 상자 기준 변환: 가운데를 기준으로 이동·회전·확대, 그리고 wipe(왼쪽→오른쪽으로 드러남)
      const xf = (x, y, w, h, fn) => {
        ctx.translate(x + w / 2 + A.dx, y + h / 2 + A.dy);
        if(rot) ctx.rotate(rot);
        if(A.s !== 1) ctx.scale(A.s, A.s);
        if(A.wipe < 1){ ctx.beginPath(); ctx.rect(-w / 2 - 2, -h / 2 - H, (w + 4) * A.wipe, h + 2 * H); ctx.clip(); }
        fn(-w / 2, -h / 2);
      };
      try{
        if(type === "text") drawText(ctx, L, W, H, A, sh, xf, t, total);
        else if(type === "image"){
          const src = images[L._key || L.path];
          if(src){
            const iw = src.naturalWidth || src.videoWidth || src.width, ih = src.naturalHeight || src.videoHeight || src.height;
            let w = opt(L, "width") != null ? len(opt(L, "width"), W) : null, h = opt(L, "height") != null ? len(opt(L, "height"), H) : null;
            const sc = opt(L, "scale") != null ? Number(opt(L, "scale")) : null;
            if(w == null && h == null){ w = iw * (sc || 1); h = ih * (sc || 1); }
            else if(w == null) w = iw * h / ih; else if(h == null) h = ih * w / iw;
            const pos = place(L, W, H, w, h);
            xf(pos.x, pos.y, w, h, (x, y) => {
              let shape = String(opt(L, "shape", "mask") || "").toLowerCase();
              if((!shape || shape === "rect") && opt(L, "radius") != null) shape = "rounded";
              const masked = !!shape && shape !== "rect";
              if(sh && masked){ // 마스크가 있으면 그림자를 모양으로 먼저 그린다
                ctx.save(); setShadow(ctx, sh); ctx.fillStyle = "#000"; shapePath(ctx, shape, x, y, w, h, L); ctx.fill(); ctx.restore();
              }
              ctx.save();
              if(masked){ shapePath(ctx, shape, x, y, w, h, L); ctx.clip(); }
              else if(sh) setShadow(ctx, sh); // 투명 PNG 도 모양대로 그림자가 생긴다
              const r = fitRect(iw, ih, w, h, String(opt(L, "fit") || "stretch"));
              if(opt(L, "flip_x")){ ctx.translate(x * 2 + w, 0); ctx.scale(-1, 1); }
              ctx.drawImage(src, x + r.x, y + r.y, r.w, r.h);
              ctx.restore();
              const bw = Number(opt(L, "border_width") || (opt(L, "border") ? Math.max(3, Math.min(w, h) * 0.03) : 0));
              if(bw > 0){ ctx.lineWidth = bw; ctx.strokeStyle = makeFill(ctx, opt(L, "border", "border_color") || "#fff", x, y, w, h); shapePath(ctx, masked ? shape : "rect", x + bw / 2, y + bw / 2, w - bw, h - bw, L); ctx.stroke(); }
            });
          }
        }else if(type === "shape"){
          const lt = String(L.type || "rect").toLowerCase(), old = lt === "rect" || lt === "ellipse" || lt === "circle";
          const kind = lt === "shape" ? String(opt(L, "shape", "kind") || "star").toLowerCase() : lt === "circle" ? "ellipse" : lt;
          const ww = old ? len(opt(L, "width"), W, W) : len(opt(L, "width", "size"), W, Math.min(W, H) * 0.25);
          const h = old ? len(opt(L, "height"), H, lt === "circle" ? ww : H) : len(opt(L, "height"), H, ww);
          const pos = place(L, W, H, ww, h, old ? 0 : undefined);
          xf(pos.x, pos.y, ww, h, (x, y) => {
            shapePath(ctx, kind === "rect" && opt(L, "radius") != null ? "rounded" : kind, x, y, ww, h, L);
            setShadow(ctx, sh);
            const fill = opt(L, "color", "fill");
            if(fill !== "none" && (fill != null || !opt(L, "stroke"))){ ctx.fillStyle = makeFill(ctx, fill || "rgba(0,0,0,.5)", x, y, ww, h); ctx.fill(kind === "ring" ? "evenodd" : "nonzero"); }
            if(opt(L, "stroke")){ setShadow(ctx, null); ctx.lineWidth = Number(opt(L, "stroke_width") || 3); ctx.lineJoin = "round"; if(opt(L, "dash")) ctx.setLineDash([].concat(opt(L, "dash")).map(Number)); ctx.strokeStyle = makeFill(ctx, opt(L, "stroke"), x, y, ww, h); ctx.stroke(); }
          });
        }else if(type === "line"){
          ctx.translate(A.dx, A.dy);
          const pts = Array.isArray(L.points) && L.points.length > 1 ? L.points.map(p => [len(p[0], W, 0), len(p[1], H, 0)]) : [[len(opt(L, "x1"), W, 0), len(opt(L, "y1"), H, 0)], [len(opt(L, "x2"), W, W), len(opt(L, "y2"), H, H)]];
          const lw = Number(opt(L, "width", "stroke_width") || Math.max(3, Math.min(W, H) * 0.008));
          ctx.strokeStyle = ctx.fillStyle = makeFill(ctx, opt(L, "color") || "#ff3b30", 0, 0, W, H, "right"); ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
          setShadow(ctx, sh);
          if(opt(L, "dash")) ctx.setLineDash([].concat(opt(L, "dash")).map(Number));
          // 동영상에서 선이 그려지는 효과: wipe/typewriter 진행도만큼만 그린다
          const prog = Math.min(A.wipe, A.reveal);
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
          let endPt = pts[0], prevPt = pts[0];
          if(opt(L, "curve") && pts.length === 2){ const [a, b] = pts, mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * Number(opt(L, "curve")), my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * Number(opt(L, "curve")); ctx.quadraticCurveTo(mx, my, b[0], b[1]); endPt = b; prevPt = [mx, my]; }
          else{
            const segs = pts.length - 1, upto = prog * segs;
            for(let i = 1; i < pts.length; i++){
              if(i - 1 >= upto) break;
              const f = Math.min(1, upto - (i - 1)), p = [pts[i-1][0] + (pts[i][0] - pts[i-1][0]) * f, pts[i-1][1] + (pts[i][1] - pts[i-1][1]) * f];
              ctx.lineTo(p[0], p[1]); prevPt = pts[i-1]; endPt = p;
            }
          }
          ctx.stroke();
          if(L.type === "arrow" || opt(L, "arrow")){
            const a = Math.atan2(endPt[1] - prevPt[1], endPt[0] - prevPt[0]), s = lw * 4;
            ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(endPt[0], endPt[1]); ctx.lineTo(endPt[0] - s * Math.cos(a - 0.45), endPt[1] - s * Math.sin(a - 0.45)); ctx.lineTo(endPt[0] - s * Math.cos(a + 0.45), endPt[1] - s * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
          }
        }else if(type === "gradient"){
          const w = len(opt(L, "width"), W, W), h = len(opt(L, "height"), H, H), pos = place(L, W, H, w, h, 0);
          ctx.translate(A.dx, A.dy);
          const colors = Array.isArray(L.colors) && L.colors.length > 1 ? L.colors : [opt(L, "from") || "rgba(0,0,0,0)", opt(L, "to") || "rgba(0,0,0,.7)"];
          ctx.fillStyle = makeFill(ctx, { colors, direction: opt(L, "direction") || "down" }, pos.x, pos.y, w, h);
          ctx.fillRect(pos.x, pos.y, w, h);
        }else if(type === "pattern") drawPattern(ctx, L, W, H, A);
        else if(type === "border") drawBorder(ctx, L, W, H);
        else if(type === "particles") drawParticles(ctx, L, W, H, t);
        else if(type === "progress"){
          const h = len(opt(L, "height"), H, Math.max(4, H * 0.012)), pos = String(opt(L, "position") || "bottom");
          const y = /top/.test(pos) ? 0 : H - h, v = t != null && total ? clamp01(t / total) : clamp01(Number(opt(L, "value") || 0));
          if(opt(L, "background")){ ctx.fillStyle = makeFill(ctx, opt(L, "background"), 0, y, W, h, "right"); ctx.fillRect(0, y, W, h); }
          ctx.fillStyle = makeFill(ctx, opt(L, "color") || "#ff3b30", 0, y, W, h, "right"); ctx.fillRect(0, y, W * v, h);
        }else if(type === "grain") drawGrain(ctx, W, H, opt(L, "amount") || 0.2, t);
      }finally{ ctx.restore(); }
    }
  }
  function layerType(L){
    const t = String(L.type || (L.text != null ? "text" : L.path ? "image" : "rect")).toLowerCase();
    if(t === "rect" || t === "ellipse" || t === "circle" || t === "shape" || t === "emoji_shape") return "shape";
    if(t === "line" || t === "arrow" || t === "path") return "line";
    if(t === "sticker" || t === "emoji") return "text";
    return t;
  }
  // 글자 레이어의 크기 계산 (그리기와 자동 쌓기에서 같이 쓴다). ctx.font 를 설정한다.
  function textLayout(ctx, L, W, H, t, total){
    const size = len(opt(L, "size", "font_size"), Math.min(W, H), Math.round(Math.min(W, H) * (L.type === "emoji" || L.type === "sticker" ? 0.18 : 0.07)));
    const fam = fontFamilyOf(opt(L, "font", "font_family"));
    const famCss = fam ? `"${fam}",${DEFAULT_FONT}` : DEFAULT_FONT;
    const weight = String(opt(L, "weight", "font_weight") || (opt(L, "bold") ? "bold" : "normal"));
    ctx.font = `${opt(L, "italic") ? "italic " : ""}${weight} ${size}px ${famCss}`;
    const ls = opt(L, "letter_spacing");
    if(ls != null && "letterSpacing" in ctx) ctx.letterSpacing = len(ls, size, 0) + "px";
    let raw = String(L.text == null ? "" : L.text);
    if(t != null){ const fmt = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); raw = raw.replace(/\{time\}/g, fmt(t)).replace(/\{remaining\}/g, fmt(Math.max(0, (total || 0) - t))); }
    if(opt(L, "uppercase")) raw = raw.toUpperCase();
    const pos0 = String(opt(L, "position") || "");
    const maxW = opt(L, "max_width") != null ? len(opt(L, "max_width"), W) : W - 2 * len(opt(L, "margin"), Math.min(W, H), Math.round(Math.min(W, H) * 0.04));
    const curve = Number(opt(L, "curve") || 0);
    const lines = curve ? [raw.replace(/\n/g, " ")] : wrapText(ctx, raw, maxW);
    const lh = size * Number(opt(L, "line_height") || 1.25);
    const tw = Math.max(1, ...lines.map(l => ctx.measureText(l).width)), th = lh * lines.length;
    const pad = len(opt(L, "padding"), size, opt(L, "background") ? Math.round(size * 0.35) : 0);
    const bw0 = curve ? Math.abs(curve) * 2 : tw + pad * 2, bh0 = curve ? Math.abs(curve) + size : th + pad * 2;
    return { size, lines, lh, tw, th, pad, bw0, bh0, curve, pos0 };
  }
  // 같은 position 에 놓인 글자들이 서로 겹치면 위아래로 차례대로 쌓는다 (stack:false 로 끌 수 있음)
  function autoStack(ctx, layers, W, H, t, total){
    const groups = {};
    for(const L of layers){
      if(!L || typeof L !== "object") continue;
      L._oy = 0;
      if(layerType(L) !== "text" || opt(L, "stack") === false || !opt(L, "position") || ["x","y","cx","cy","center_x","center_y"].some(k => opt(L, k) != null)) continue;
      if(animState(L, t, W, H, total).a <= 0) continue; // 지금 안 보이는 글자는 자리를 차지하지 않는다
      const pos = String(opt(L, "position")).toLowerCase().replace(/[_\s]+/g, "-");
      (groups[pos] = groups[pos] || []).push(L);
    }
    for(const pos in groups){
      const g = groups[pos]; if(g.length < 2) continue;
      const boxes = g.map(L => { ctx.save(); const m = textLayout(ctx, L, W, H, t, total); ctx.restore(); const b = place(L, W, H, m.bw0, m.bh0); return { L, h: m.bh0, y: b.y }; });
      const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j && a.y < b.y + b.h && b.y < a.y + a.h));
      if(!overlap) continue;
      const gap = Math.min(W, H) * 0.02, sum = boxes.reduce((s, b) => s + b.h, 0) + gap * (boxes.length - 1);
      const m0 = len(opt(g[0], "margin"), Math.min(W, H), Math.round(Math.min(W, H) * 0.04));
      let y = /top/.test(pos) ? m0 : /bottom/.test(pos) ? H - m0 - sum : (H - sum) / 2;
      boxes.forEach(b => { b.L._oy = y - b.y; y += b.h + gap; });
    }
  }
  function drawText(ctx, L, W, H, A, sh, xf, t, total){
    const { size, lines, lh, tw, th, pad, bw0, bh0, curve, pos0 } = textLayout(ctx, L, W, H, t, total);
    const box = place(L, W, H, bw0, bh0);
    const align = String(opt(L, "align") || (/(^|-)left/.test(pos0) ? "left" : /right/.test(pos0) ? "right" : pos0 ? "center" : "left")).toLowerCase();
    const total_chars = lines.reduce((s, l) => s + [...l].length, 0);
    let budget = A.reveal >= 1 ? Infinity : Math.floor(total_chars * A.reveal);
    const fillFor = (x, y, w, h) => makeFill(ctx, opt(L, "color", "fill") || "#ffffff", x, y, w, h, opt(L, "gradient_direction") || "down");
    const glow = opt(L, "glow"), outlines = [];
    const sw = Number(opt(L, "stroke_width") || (opt(L, "stroke", "stroke_color") ? Math.max(2, size / 10) : 0));
    if(sw > 0) outlines.push({ color: opt(L, "stroke", "stroke_color") || "#000", width: sw });
    if(Array.isArray(opt(L, "outlines"))) opt(L, "outlines").forEach(o => outlines.push({ color: o.color || "#000", width: Number(o.width || 4) }));
    outlines.sort((a, b) => b.width - a.width);
    const paintRun = (s, px, py, fill) => { // 외곽선(두꺼운 것부터) → 빛 → 그림자 → 채우기
      for(const o of outlines){ ctx.save(); setShadow(ctx, null); ctx.lineJoin = "round"; ctx.miterLimit = 2; ctx.lineWidth = o.width; ctx.strokeStyle = o.color; ctx.strokeText(s, px, py); ctx.restore(); }
      if(glow){ const g = glow === true ? { color: typeof opt(L, "color") === "string" ? opt(L, "color") : "#fff", blur: size * 0.5 } : { color: glow.color || "#fff", blur: Number(glow.blur || size * 0.5) }; ctx.save(); ctx.shadowColor = g.color; ctx.shadowBlur = g.blur; ctx.fillStyle = fill; ctx.fillText(s, px, py); ctx.fillText(s, px, py); ctx.restore(); }
      ctx.save(); setShadow(ctx, sh); ctx.fillStyle = fill; ctx.fillText(s, px, py); ctx.restore();
    };
    xf(box.x, box.y, bw0, bh0, (bx, by) => {
      if(opt(L, "background") && !curve){
        ctx.save(); setShadow(ctx, opt(L, "box_shadow") ? shadowOf(opt(L, "box_shadow")) : null);
        shapePath(ctx, opt(L, "background_shape") || "rounded", bx, by, tw + pad * 2, th + pad * 2, { radius: opt(L, "radius") != null ? opt(L, "radius") : Math.round(size * 0.3) });
        ctx.fillStyle = makeFill(ctx, opt(L, "background"), bx, by, tw + pad * 2, th + pad * 2); ctx.fill();
        if(opt(L, "background_border")){ ctx.lineWidth = Math.max(2, size / 14); ctx.strokeStyle = String(opt(L, "background_border")); ctx.stroke(); }
        ctx.restore();
      }
      ctx.textBaseline = "alphabetic";
      if(curve){ // 원호를 따라 쓰는 글자 (curve>0: 위로 볼록, <0: 아래로 볼록)
        const r = Math.abs(curve), cx = bx + bw0 / 2, cy = curve > 0 ? by + r + size : by, txt = [...lines[0]];
        const widths = txt.map(ch => ctx.measureText(ch).width), total2 = widths.reduce((a, b) => a + b, 0);
        let ang = -total2 / r / 2;
        ctx.textAlign = "center";
        const fill = fillFor(bx, by, bw0, bh0);
        txt.forEach((ch, i) => {
          if(budget-- <= 0) return;
          const a = ang + widths[i] / r / 2; ang += widths[i] / r;
          ctx.save();
          if(curve > 0){ ctx.translate(cx + Math.sin(a) * r, cy - Math.cos(a) * r); ctx.rotate(a); }
          else{ ctx.translate(cx + Math.sin(a) * r, cy + Math.cos(a) * r); ctx.rotate(-a); }
          paintRun(ch, 0, 0, fill); ctx.restore();
        });
        return;
      }
      ctx.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
      const ax = align === "right" ? bx + pad + tw : align === "center" ? bx + pad + tw / 2 : bx + pad;
      const fill = fillFor(bx + pad, by + pad, tw, th);
      const hl = opt(L, "highlight"), ul = opt(L, "underline");
      lines.forEach((line0, i) => {
        if(budget <= 0) return;
        const chars = [...line0], line = budget === Infinity ? line0 : chars.slice(0, Math.max(0, budget)).join("");
        if(budget !== Infinity) budget -= chars.length;
        const lw = ctx.measureText(line0).width, lx = align === "right" ? ax - lw : align === "center" ? ax - lw / 2 : ax;
        const top = by + pad + i * lh, base = top + (lh - size) / 2 + size * 0.86;
        if(hl){ ctx.save(); setShadow(ctx, null); ctx.fillStyle = makeFill(ctx, hl, lx, top, lw, lh, "right"); ctx.fillRect(lx - size * 0.08, top + lh * 0.5, ctx.measureText(line).width + size * 0.16, lh * 0.42); ctx.restore(); }
        paintRun(line, ax - (align === "center" ? (lw - ctx.measureText(line).width) / 2 : align === "right" ? lw - ctx.measureText(line).width : 0), base, fill);
        if(ul){ ctx.save(); setShadow(ctx, null); ctx.fillStyle = typeof ul === "string" ? ul : (typeof opt(L, "color") === "string" ? opt(L, "color") : "#fff"); ctx.fillRect(lx, base + size * 0.1, ctx.measureText(line).width, Math.max(2, size * 0.07)); ctx.restore(); }
      });
    });
  }
  function drawPattern(ctx, L, W, H, A){
    const kind = String(opt(L, "kind", "pattern") || "dots").toLowerCase(), gap = len(opt(L, "spacing", "size"), Math.min(W, H), Math.max(12, Math.min(W, H) * 0.05));
    const w = len(opt(L, "width"), W, W), h = len(opt(L, "height"), H, H), pos = place(L, W, H, w, h, 0);
    ctx.translate(A.dx, A.dy);
    ctx.beginPath(); ctx.rect(pos.x, pos.y, w, h); ctx.clip();
    ctx.fillStyle = ctx.strokeStyle = String(opt(L, "color") || "rgba(255,255,255,.25)");
    ctx.lineWidth = Number(opt(L, "line_width") || Math.max(1, gap * 0.12));
    if(kind === "dots"){ const r = Number(opt(L, "dot_size") || gap * 0.18); for(let y = pos.y; y < pos.y + h + gap; y += gap) for(let x = pos.x + ((Math.round((y - pos.y) / gap) % 2) ? gap / 2 : 0); x < pos.x + w + gap; x += gap){ ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); } }
    else if(kind === "stripes" || kind === "diagonal"){ ctx.save(); ctx.translate(pos.x + w / 2, pos.y + h / 2); ctx.rotate(kind === "diagonal" ? -Math.PI / 4 : 0); const R = Math.hypot(w, h); for(let x = -R; x < R; x += gap){ ctx.fillRect(x, -R, gap / 2, 2 * R); } ctx.restore(); }
    else if(kind === "grid"){ ctx.beginPath(); for(let x = pos.x; x <= pos.x + w; x += gap){ ctx.moveTo(x, pos.y); ctx.lineTo(x, pos.y + h); } for(let y = pos.y; y <= pos.y + h; y += gap){ ctx.moveTo(pos.x, y); ctx.lineTo(pos.x + w, y); } ctx.stroke(); }
    else if(kind === "checker"){ for(let y = 0; y < h; y += gap) for(let x = 0; x < w; x += gap) if(((x / gap) + (y / gap)) % 2 < 1) ctx.fillRect(pos.x + x, pos.y + y, gap, gap); }
    else if(kind === "waves"){ ctx.beginPath(); for(let y = pos.y; y < pos.y + h + gap; y += gap){ ctx.moveTo(pos.x, y); for(let x = pos.x; x <= pos.x + w; x += 4) ctx.lineTo(x, y + Math.sin((x - pos.x) / gap * Math.PI) * gap * 0.25); } ctx.stroke(); }
    else if(kind === "halftone"){ for(let y = pos.y; y < pos.y + h + gap; y += gap) for(let x = pos.x; x < pos.x + w + gap; x += gap){ const r = gap * 0.45 * ((y - pos.y) / h); if(r > 0.3){ ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); } } }
  }
  function drawBorder(ctx, L, W, H){
    const bw = len(opt(L, "width", "thickness"), Math.min(W, H), Math.max(6, Math.min(W, H) * 0.025)), inset = len(opt(L, "inset", "margin"), Math.min(W, H), 0);
    const r = len(opt(L, "radius"), Math.min(W, H), 0), style = String(opt(L, "style") || "solid").toLowerCase();
    const x = inset + bw / 2, y = inset + bw / 2, w = W - 2 * inset - bw, h = H - 2 * inset - bw;
    ctx.strokeStyle = makeFill(ctx, opt(L, "color") || "#ffffff", 0, 0, W, H, "diagonal"); ctx.lineWidth = bw;
    if(style === "dashed") ctx.setLineDash([bw * 3, bw * 2]); else if(style === "dotted"){ ctx.setLineDash([0.1, bw * 2]); ctx.lineCap = "round"; }
    if(style === "double"){ ctx.lineWidth = bw / 3; roundRectPath(ctx, x - bw / 3, y - bw / 3, w + bw / 1.5, h + bw / 1.5, r); ctx.stroke(); roundRectPath(ctx, x + bw / 3, y + bw / 3, w - bw / 1.5, h - bw / 1.5, Math.max(0, r - bw / 2)); ctx.stroke(); return; }
    if(style === "polaroid"){ ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(bw, bw, W - 2 * bw, H - bw * 4); ctx.fill("evenodd"); return; }
    roundRectPath(ctx, x, y, w, h, r); ctx.stroke();
  }
  function drawParticles(ctx, L, W, H, t){
    const kind = String(opt(L, "kind") || "confetti").toLowerCase(), n = Math.min(600, Number(opt(L, "count") || 60));
    const rnd = mulberry(Number(opt(L, "seed") || 7)), colors = [].concat(opt(L, "colors") || (kind === "snow" || kind === "bubbles" ? ["#ffffff"] : kind === "bokeh" ? ["#ffd27a", "#ff9ec7", "#9ad7ff", "#ffffff"] : kind === "hearts" ? ["#ff4d6d", "#ff8fa3", "#ffccd5"] : kind === "stars" || kind === "sparkle" ? ["#fff7c2", "#ffffff", "#ffe066"] : ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93"]));
    const base = len(opt(L, "size"), Math.min(W, H), Math.min(W, H) * (kind === "bokeh" ? 0.06 : kind === "snow" ? 0.008 : 0.015));
    const T = t == null ? 0 : t, speed = Number(opt(L, "speed") || 1);
    for(let i = 0; i < n; i++){
      const px = rnd(), py = rnd(), s = base * (0.5 + rnd()), c = colors[Math.floor(rnd() * colors.length)], ph = rnd() * Math.PI * 2, rs = rnd();
      let x = px * W, y = py * H;
      if(kind === "confetti" || kind === "snow" || kind === "hearts"){ const v = (kind === "snow" ? 0.06 : 0.18) * (0.5 + rs) * speed; y = ((py + T * v) % 1.05) * H - s; x += Math.sin(T * 1.5 + ph) * W * (kind === "snow" ? 0.02 : 0.01); }
      else if(kind === "bubbles"){ y = (1.05 - ((py + T * 0.08 * (0.5 + rs) * speed) % 1.1)) * H; x += Math.sin(T * 2 + ph) * W * 0.01; }
      else if(kind === "bokeh"){ x += Math.sin(T * 0.4 + ph) * W * 0.02; y += Math.cos(T * 0.3 + ph) * H * 0.02; }
      ctx.save(); ctx.fillStyle = c; ctx.strokeStyle = c;
      const tw = kind === "stars" || kind === "sparkle" ? 0.35 + 0.65 * Math.abs(Math.sin(T * 3 * speed + ph)) : 1;
      ctx.globalAlpha *= tw;
      ctx.translate(x, y);
      if(kind === "confetti"){ ctx.rotate(ph + T * 4 * (rs - 0.5)); ctx.fillRect(-s / 2, -s / 4, s, s / 2); }
      else if(kind === "snow"){ ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill(); }
      else if(kind === "bokeh"){ ctx.globalAlpha *= 0.35; ctx.shadowColor = c; ctx.shadowBlur = s; ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill(); }
      else if(kind === "bubbles"){ ctx.globalAlpha *= 0.6; ctx.lineWidth = Math.max(1, s * 0.12); ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke(); }
      else if(kind === "hearts"){ shapePath(ctx, "heart", -s, -s, s * 2, s * 2, {}); ctx.fill(); }
      else{ // stars / sparkle: 반짝이는 십자 별
        ctx.shadowColor = c; ctx.shadowBlur = s * 2; shapePath(ctx, "star", -s, -s, s * 2, s * 2, { points: 4, inner: 0.3 }); ctx.fill();
      }
      ctx.restore();
    }
  }
  // 레이어에 쓰인 이미지들을 미리 읽는다 (크로마키·필터 적용본은 별도 키)
  async function preloadLayerImages(layers){
    const map = {};
    for(const L of layers || []){
      if(!L || !L.path || layerType(L) !== "image") continue;
      const ck = opt(L, "chroma_key", "remove_color"), lf = opt(L, "filters", "filter"), lp = opt(L, "preset");
      const key = L.path + (ck ? "#ck" + JSON.stringify(ck) : "") + (lf || lp ? "#f" + JSON.stringify([lf, lp]) : "");
      L._key = key;
      if(map[key]) continue;
      const img = await loadImageEntry(L.path);
      let out = ck ? chromaKey(img, typeof ck === "object" ? ck.color : ck, typeof ck === "object" ? ck.tolerance : undefined) : img;
      if(lf || lp){ const c = newCanvas(out.naturalWidth || out.width, out.naturalHeight || out.height), x = ctx2d(c); x.drawImage(out, 0, 0); applyFilters(x, c.width, c.height, mergedFilters(lf, lp)); out = c; }
      if(out !== img){ try{ out = await canvasToImage(out); }catch(_){} }
      map[key] = out;
    }
    return map;
  }
  const LAYER_TYPES = ["text","emoji","sticker","image","rect","ellipse","circle","shape","line","arrow","path","gradient","pattern","border","particles","progress","grain"];
  function validateLayers(layers){
    if(layers == null) return [];
    if(!Array.isArray(layers)) throw new Error("layers 는 배열이어야 해요");
    if(layers.length > 80) throw new Error("layers 는 최대 80개예요");
    layers.forEach((L, i) => {
      const t = String(L && (L.type || (L.text != null ? "text" : L.path ? "image" : "rect"))).toLowerCase();
      if(!LAYER_TYPES.includes(t)) throw new Error(`layers[${i}].type '${t}' 은 지원하지 않아요. 사용 가능: ${LAYER_TYPES.join(", ")}`);
      if(t === "image" && !L.path) throw new Error(`layers[${i}] 이미지 레이어에는 path 가 필요해요`);
      if(t === "shape" && opt(L, "shape", "kind") && !SHAPES.includes(String(opt(L, "shape", "kind")).toLowerCase())) throw new Error(`layers[${i}].shape 는 ${SHAPES.join(", ")} 중 하나예요`);
      for(const k of ["animation_in","animation","animation_out"]) if(L[k] && !ANIMS.includes(String(L[k]).toLowerCase())) throw new Error(`layers[${i}].${k} 는 ${ANIMS.join(", ")} 중 하나예요`);
    });
    return layers;
  }
  /* ---- 필터 ---- */
  const PRESETS = {
    vintage:{ sepia:0.35, contrast:1.05, saturation:0.85, brightness:1.05, vignette:0.35, grain:0.12 },
    retro:{ sepia:0.2, saturation:1.2, contrast:1.1, tint:{ color:"#ff9a3c", amount:0.12 }, grain:0.15, vignette:0.25 },
    cinematic:{ contrast:1.15, saturation:0.9, tint:{ color:"#0f4c5c", amount:0.12 }, vignette:0.3 },
    warm:{ temperature:0.25, saturation:1.08 },
    cool:{ temperature:-0.25, saturation:1.02 },
    bw:{ grayscale:1, contrast:1.1 },
    noir:{ grayscale:1, contrast:1.4, brightness:0.92, vignette:0.5, grain:0.1 },
    vivid:{ saturation:1.35, contrast:1.1 },
    fade:{ contrast:0.85, brightness:1.08, saturation:0.8 },
    dreamy:{ brightness:1.08, saturation:1.1, blur:1, tint:{ color:"#ffb3d9", amount:0.1 } }
  };
  function mergedFilters(f, preset){
    const p = preset ? PRESETS[String(preset).toLowerCase()] : null;
    if(preset && !p) throw new Error("preset 은 " + Object.keys(PRESETS).join(", ") + " 중 하나예요");
    return Object.assign({}, p || {}, f && typeof f === "object" ? f : {});
  }
  // 픽셀 필터 (모든 브라우저에서 같은 결과)
  function applyFilters(ctx, w, h, f){
    if(!f || typeof f !== "object") return;
    const num = (k, d) => { const v = opt(f, k); return v == null ? d : Number(v); };
    const blur = num("blur", 0);
    if(blur > 0){
      const tmp = newCanvas(w, h), tx = tmp.getContext("2d");
      tx.drawImage(ctx.canvas, 0, 0);
      if("filter" in tx && (tx.filter = `blur(${blur}px)`, tx.filter !== "none")){ ctx.save(); ctx.clearRect(0, 0, w, h); ctx.filter = `blur(${blur}px)`; ctx.drawImage(tmp, 0, 0); ctx.restore(); }
      else boxBlur(ctx, w, h, Math.min(25, Math.round(blur)));
    }
    const pix = num("pixelate", 0);
    if(pix > 1){ const sw = Math.max(1, Math.round(w / pix)), sh = Math.max(1, Math.round(h / pix)), tmp = newCanvas(sw, sh); ctx2d(tmp).drawImage(ctx.canvas, 0, 0, sw, sh); ctx.save(); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, w, h); ctx.drawImage(tmp, 0, 0, w, h); ctx.restore(); }
    const br = num("brightness", 1) * num("exposure", 1), ct = num("contrast", 1), sat = num("saturation", num("saturate", 1)), gs = num("grayscale", 0), sp = num("sepia", 0), inv = num("invert", 0), hue = num("hue", num("hue_rotate", 0)), shp = num("sharpen", 0);
    const temp = num("temperature", 0), post = num("posterize", 0), noise = num("noise", 0);
    const tint = opt(f, "tint"), duo = opt(f, "duotone");
    const tintRGB = tint ? parseColor(typeof tint === "object" ? tint.color : tint) : null, tintA = tint ? Number(typeof tint === "object" && tint.amount != null ? tint.amount : 0.25) : 0;
    const duoA = Array.isArray(duo) && duo.length >= 2 ? parseColor(duo[0]) : null, duoB = duoA ? parseColor(duo[1]) : null;
    if(br === 1 && ct === 1 && sat === 1 && !gs && !sp && !inv && !hue && !shp && !temp && !post && !noise && !tintRGB && !duoA){ vignette(ctx, w, h, opt(f, "vignette")); drawGrain(ctx, w, h, opt(f, "grain"), null); return; }
    const d = ctx.getImageData(0, 0, w, h), a = d.data;
    const cos = Math.cos(hue * Math.PI / 180), sin = Math.sin(hue * Math.PI / 180);
    const hm = hue ? [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
      0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
      0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072] : null;
    const rnd = mulberry(5), lv = post > 1 ? 255 / (Math.round(post) - 1) : 0;
    for(let i = 0; i < a.length; i += 4){
      let r = a[i], g = a[i+1], b = a[i+2];
      if(hm){ const R = r * hm[0] + g * hm[1] + b * hm[2], G = r * hm[3] + g * hm[4] + b * hm[5], B = r * hm[6] + g * hm[7] + b * hm[8]; r = R; g = G; b = B; }
      if(sat !== 1){ const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
      if(gs){ const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r += (l - r) * gs; g += (l - g) * gs; b += (l - b) * gs; }
      if(sp){ const R = 0.393 * r + 0.769 * g + 0.189 * b, G = 0.349 * r + 0.686 * g + 0.168 * b, B = 0.272 * r + 0.534 * g + 0.131 * b; r += (R - r) * sp; g += (G - g) * sp; b += (B - b) * sp; }
      if(temp){ r += temp * 40; b -= temp * 40; g += temp * 8; }
      if(tintRGB){ r += (tintRGB[0] - r) * tintA; g += (tintRGB[1] - g) * tintA; b += (tintRGB[2] - b) * tintA; }
      if(duoA){ const l = clamp01((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255); r = duoA[0] + (duoB[0] - duoA[0]) * l; g = duoA[1] + (duoB[1] - duoA[1]) * l; b = duoA[2] + (duoB[2] - duoA[2]) * l; }
      if(br !== 1){ r *= br; g *= br; b *= br; }
      if(ct !== 1){ r = (r - 128) * ct + 128; g = (g - 128) * ct + 128; b = (b - 128) * ct + 128; }
      if(inv){ r += (255 - 2 * r) * inv; g += (255 - 2 * g) * inv; b += (255 - 2 * b) * inv; }
      if(lv){ r = Math.round(r / lv) * lv; g = Math.round(g / lv) * lv; b = Math.round(b / lv) * lv; }
      if(noise){ const n = (rnd() - 0.5) * 255 * noise; r += n; g += n; b += n; }
      a[i] = r; a[i+1] = g; a[i+2] = b; // Uint8ClampedArray 가 0~255 로 자른다
    }
    if(shp > 0){
      const src = new Uint8ClampedArray(a), k = shp;
      for(let y = 1; y < h - 1; y++) for(let x = 1; x < w - 1; x++){
        const i = (y * w + x) * 4;
        for(let c = 0; c < 3; c++){ a[i + c] = src[i + c] * (1 + 4 * k) - k * (src[i + c - 4] + src[i + c + 4] + src[i + c - w * 4] + src[i + c + w * 4]); }
      }
    }
    ctx.putImageData(d, 0, 0);
    vignette(ctx, w, h, opt(f, "vignette"));
    drawGrain(ctx, w, h, opt(f, "grain"), null);
  }
  function boxBlur(ctx, w, h, r){
    if(r < 1) return;
    const d = ctx.getImageData(0, 0, w, h), a = d.data, tmp = new Float32Array(a.length);
    for(let pass = 0; pass < 2; pass++){
      for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
        const s = [0,0,0,0]; let n = 0;
        for(let k = -r; k <= r; k++){ const xx = pass ? x : Math.min(w - 1, Math.max(0, x + k)), yy = pass ? Math.min(h - 1, Math.max(0, y + k)) : y; const j = (yy * w + xx) * 4; s[0] += a[j]; s[1] += a[j+1]; s[2] += a[j+2]; s[3] += a[j+3]; n++; }
        const i = (y * w + x) * 4; tmp[i] = s[0] / n; tmp[i+1] = s[1] / n; tmp[i+2] = s[2] / n; tmp[i+3] = s[3] / n;
      }
      a.set(tmp);
    }
    ctx.putImageData(d, 0, 0);
  }
  // 동영상 프레임용: CSS 필터 문자열 + 색 덧칠(색온도·틴트) + 비네트·노이즈 (픽셀 연산은 실시간으로 너무 느리다)
  function cssFilter(f){
    if(!f || typeof f !== "object") return "none";
    const p = [], v = k => opt(f, k);
    const br = (v("brightness") != null ? Number(v("brightness")) : 1) * (v("exposure") != null ? Number(v("exposure")) : 1);
    if(br !== 1) p.push(`brightness(${br})`);
    if(v("contrast") != null) p.push(`contrast(${Number(v("contrast"))})`);
    const s = v("saturation") != null ? v("saturation") : v("saturate"); if(s != null) p.push(`saturate(${Number(s)})`);
    if(v("grayscale") != null) p.push(`grayscale(${Number(v("grayscale"))})`);
    if(v("sepia") != null) p.push(`sepia(${Number(v("sepia"))})`);
    if(v("invert") != null) p.push(`invert(${Number(v("invert"))})`);
    const h = v("hue") != null ? v("hue") : v("hue_rotate"); if(h != null) p.push(`hue-rotate(${Number(h)}deg)`);
    if(v("blur") != null) p.push(`blur(${Number(v("blur"))}px)`);
    return p.join(" ") || "none";
  }
  function frameOverlays(ctx, w, h, f, t, noColor){
    if(!f) return;
    if(!noColor) colorOverlay(ctx, w, h, f);
    vignette(ctx, w, h, opt(f, "vignette"));
    drawGrain(ctx, w, h, opt(f, "grain"), t);
  }
  function colorOverlay(ctx, w, h, f){
    const temp = Number(opt(f, "temperature") || 0), tint = opt(f, "tint");
    if(temp){ ctx.save(); ctx.globalCompositeOperation = "soft-light"; ctx.globalAlpha = Math.min(0.8, Math.abs(temp) * 1.6); ctx.fillStyle = temp > 0 ? "#ff9a2e" : "#2e7bff"; ctx.fillRect(0, 0, w, h); ctx.restore(); }
    if(tint){ ctx.save(); ctx.globalCompositeOperation = "color"; ctx.globalAlpha = Number(typeof tint === "object" && tint.amount != null ? tint.amount : 0.25); ctx.fillStyle = typeof tint === "object" ? tint.color : tint; ctx.fillRect(0, 0, w, h); ctx.restore(); }
  }
  // 비네트는 한 번 그려 두고 재사용한다 (영상에서 매 프레임 방사형 그라디언트를 그리면 느리다)
  let vignetteCache = null;
  function vignette(ctx, w, h, amount){
    amount = Number(amount); if(!(amount > 0)) return;
    const key = w + "x" + h + ":" + amount;
    if(!vignetteCache || vignetteCache.key !== key){
      const c = newCanvas(w, h), x = c.getContext("2d");
      const g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount)})`);
      x.fillStyle = g; x.fillRect(0, 0, w, h); vignetteCache = { key, c };
    }
    ctx.drawImage(vignetteCache.c, 0, 0);
  }
  // 시네마 비율 검은 띠: letterbox:true(2.35:1) 또는 숫자 비율
  function letterbox(ctx, w, h, v){
    if(!v) return;
    const ratio = v === true ? 2.35 : Number(v); if(!(ratio > 0)) return;
    const ih = Math.min(h, w / ratio), bar = (h - ih) / 2; if(bar < 1) return;
    ctx.save(); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, bar); ctx.fillRect(0, h - bar, w, bar); ctx.restore();
  }
  function outFormat(call, fallback){
    const ext = (String(call.out || "").match(/\.([a-z0-9]+)$/i) || [])[1];
    const f = String(call.format || (ext ? ext : fallback || "png")).toLowerCase().replace(/^jpg$/, "jpeg");
    if(!["png","jpeg","webp"].includes(f)) throw new Error("지원 형식: png, jpeg, webp");
    return f;
  }
  function canvasToFile(canvas, out, format, quality){
    const mime = "image/" + format;
    const q = quality != null ? Math.max(0.1, Math.min(1, Number(quality) > 1 ? Number(quality) / 100 : Number(quality))) : 0.95;
    const data = canvas.toDataURL(mime, q);
    if(!data.startsWith("data:" + mime + ";")) throw new Error("브라우저에서 지원하지 않는 형식이에요: " + format);
    const ext = format === "jpeg" ? "jpg" : format;
    const fixed = /\.[a-z0-9]+$/i.test(out) ? out : out + "." + ext;
    return writeFile(fixed, data, mime);
  }

  async function editImage(call){
    const layers = validateLayers(opt(call, "layers"));
    if(!call.out) throw new Error("결과 파일 경로 out이 필요해요");
    const format = outFormat(call, "png"), notes = [];
    let img = null;
    if(call.path) img = await loadImageEntry(call.path);
    else if(!(call.width && call.height)) throw new Error("path(원본 이미지) 또는 빈 캔버스용 width·height 가 필요해요");
    const iw = img ? img.naturalWidth : Number(call.width), ih = img ? img.naturalHeight : Number(call.height);
    const crop = call.crop || {}, x = Number(crop.x || 0), y = Number(crop.y || 0), sw = Number(crop.width || iw - x), sh = Number(crop.height || ih - y);
    if(![x,y,sw,sh].every(Number.isFinite) || x < 0 || y < 0 || sw <= 0 || sh <= 0 || x + sw > iw + 0.5 || y + sh > ih + 0.5) throw new Error(`자르기 영역이 이미지(${iw}×${ih}) 밖이에요`);
    // 회전: 90/180/270 은 정확히, 그 밖의 각도는 잘리지 않게 캔버스를 넓힌다
    const deg = ((Number(call.rotate || 0) % 360) + 360) % 360, rad = deg * Math.PI / 180;
    const rw = Math.round(Math.abs(sw * Math.cos(rad)) + Math.abs(sh * Math.sin(rad))), rh = Math.round(Math.abs(sw * Math.sin(rad)) + Math.abs(sh * Math.cos(rad)));
    const scale = Number(opt(call, "scale") || 1);
    let w = Number(call.width || 0), h = Number(call.height || 0);
    if(!img){ w = iw; h = ih; }
    else if(w && !h) h = Math.round(rh * w / rw);
    else if(h && !w) w = Math.round(rw * h / rh);
    w = Math.round((w || rw) * (img ? scale : 1)); h = Math.round((h || rh) * (img ? scale : 1));
    checkSize(w, h);
    await ensureFonts(layers, notes);
    const canvas = newCanvas(w, h), ctx = ctx2d(canvas);
    const bg = opt(call, "background") || (format === "jpeg" ? "#ffffff" : null);
    if(bg){ ctx.fillStyle = makeFill(ctx, bg, 0, 0, w, h); ctx.fillRect(0, 0, w, h); }
    if(img){
      const r = fitRect(rw, rh, w, h, String(call.fit || "stretch"));
      // 크게 줄이는 경우 단계적으로 미리 줄여서 선명도를 지킨다
      const ratio = Math.min(r.w / rw, r.h / rh), pre = prescale(img, x, y, sw, sh, Math.max(1, Math.round(sw * ratio)), Math.max(1, Math.round(sh * ratio)));
      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.scale(r.w / rw, r.h / rh);
      ctx.rotate(rad);
      ctx.scale(call.flipX || call.flip_x ? -1 : 1, call.flipY || call.flip_y ? -1 : 1);
      if(pre) ctx.drawImage(pre, 0, 0, pre.width, pre.height, -sw / 2, -sh / 2, sw, sh);
      else ctx.drawImage(img, x, y, sw, sh, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }
    const f = mergedFilters(opt(call, "filters", "filter"), opt(call, "preset"));
    if(Object.keys(f).length) applyFilters(ctx, w, h, f);
    if(layers.length) drawLayers(ctx, w, h, layers, await preloadLayerImages(layers), null);
    vignette(ctx, w, h, opt(call, "vignette"));
    letterbox(ctx, w, h, opt(call, "letterbox"));
    const out = canvasToFile(canvas, call.out, format, opt(call, "quality"));
    return `${out} (${w}×${h}, ${format}${layers.length ? ", 레이어 " + layers.length + "개" : ""})` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
  }

  /* ---- 동영상 공통: 캔버스 녹화 ---- */
  function recorderSupport(){
    if(typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream || !MediaRecorder.isTypeSupported("video/webm")) throw new Error("이 브라우저는 WebM 동영상 제작을 지원하지 않아요 (Chrome·Edge·Firefox 권장)");
  }
  function pickMime(withAudio, codec){
    const v = String(codec || "").toLowerCase();
    const order = v === "vp8" ? ["vp8"] : v === "av1" ? ["av01", "vp9", "vp8"] : ["vp9", "vp8"];
    const c = order.map(x => "video/webm;codecs=" + x + (withAudio ? ",opus" : "")).concat(["video/webm"]);
    return c.find(m => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }
  // 화질: quality(standard|high|max) 또는 bitrate(Mbps)
  function bitrateFor(call, w, h, fps){
    const mb = Number(opt(call, "bitrate", "video_bitrate"));
    if(mb > 0) return Math.round(Math.min(80, Math.max(0.3, mb)) * 1e6);
    const q = String(opt(call, "quality") || "high").toLowerCase(), k = q === "max" ? 0.32 : q === "standard" || q === "low" ? 0.08 : 0.16;
    return Math.round(Math.min(60e6, Math.max(1.5e6, w * h * fps * k)));
  }
  // 탭이 숨겨지면 requestAnimationFrame 이 멈춰 녹화가 끝나지 않던 문제 → 숨김 상태에선 타이머로 진행
  function nextFrame(cb){ if(document.hidden) setTimeout(() => cb(performance.now()), 16); else requestAnimationFrame(cb); }
  function makeAudioMix(){
    let ac = null;
    try{ const AC = global.AudioContext || global.webkitAudioContext; if(AC) ac = new AC(); }catch(_){}
    if(!ac || !ac.createMediaStreamDestination) return null;
    const dest = ac.createMediaStreamDestination();
    return {
      ac, dest, used: false,
      add(el, volume){ try{ el.muted = false; el.volume = 1; const src = ac.createMediaElementSource(el), g = ac.createGain(); g.gain.value = volume == null ? 1 : Math.max(0, Math.min(2, Number(volume))); src.connect(g); g.connect(dest); this.used = true; el._gain = g; return true; }catch(e){ return false; } },
      async resume(){ try{ if(ac.state === "suspended") await ac.resume(); }catch(_){} },
      close(){ try{ ac.close(); }catch(_){} }
    };
  }
  // fps 에 맞춰 그린 프레임만 정확히 보낸다 (captureStream(0) + requestFrame)
  async function record(canvas, fps, mix, bitrate, codec, render){
    let vstream = canvas.captureStream(0), track = vstream.getVideoTracks()[0];
    if(!track || typeof track.requestFrame !== "function"){ vstream.getTracks().forEach(t => t.stop()); vstream = canvas.captureStream(fps); track = null; }
    const tracks = vstream.getVideoTracks().slice();
    if(mix && mix.used) tracks.push(...mix.dest.stream.getAudioTracks());
    const stream = new MediaStream(tracks), mimeType = pickMime(mix && mix.used, codec), chunks = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
    rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = () => reject(new Error("영상 인코딩 실패")); });
    let frames = 0, last = -1e9;
    const interval = 1000 / fps;
    // 그릴 차례인지: 목표 fps 보다 빨리 그리지 않는다
    const due = now => now - last >= interval - 2;
    const emit = now => { last = now; frames++; if(track) track.requestFrame(); };
    try{
      if(mix) await mix.resume();
      rec.start(500);
      await render(due, emit);
      if(track) track.requestFrame();
      await new Promise(r => setTimeout(r, 150)); // 마지막 프레임이 담기도록 잠깐 기다린다
      rec.stop(); await stopped;
    }finally{
      if(rec.state !== "inactive") try{ rec.stop(); }catch(_){}
      stream.getTracks().forEach(t => t.stop()); vstream.getTracks().forEach(t => t.stop());
    }
    const blob = new Blob(chunks, { type: "video/webm" });
    if(!blob.size) throw new Error("녹화된 영상이 비어 있어요 (탭을 띄워 둔 채로 다시 시도해 주세요)");
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("영상 저장 실패")); r.readAsDataURL(blob); });
    return { data, frames, codec: mimeType.replace("video/webm;codecs=", "") };
  }
  function fadeOverlay(ctx, w, h, t, total, fin, fout, color){
    let a = 0;
    if(fin > 0 && t < fin) a = Math.max(a, 1 - t / fin);
    if(fout > 0 && t > total - fout) a = Math.max(a, 1 - (total - t) / fout);
    if(a <= 0) return;
    ctx.save(); ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = color || "#000"; ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  function videoSize(call, sw, sh, rotate){
    const swap = rotate === 90 || rotate === 270;
    const bw = swap ? sh : sw, bh = swap ? sw : sh;
    let w = Number(call.width || 0), h = Number(call.height || 0);
    if(w && !h) h = Math.round(bh * w / bw / 2) * 2; else if(h && !w) w = Math.round(bw * h / bh / 2) * 2;
    w = w || bw; h = h || bh;
    if(!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > MAX_VW || h > MAX_VW || w * h > MAX_VW * MAX_VH) throw new Error(`영상 크기가 올바르지 않아요 (최대 ${MAX_VW}×${MAX_VH}): ${w}×${h}`);
    return { w, h };
  }
  function drawSource(ctx, src, sw, sh, w, h, o){
    const rot = o.rotate || 0, swap = rot === 90 || rot === 270;
    const r = fitRect(swap ? sh : sw, swap ? sw : sh, w, h, o.fit || "contain");
    ctx.save();
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    if(o.zoom && o.zoom !== 1) ctx.scale(o.zoom, o.zoom);
    if(o.pan) ctx.translate(o.pan[0], o.pan[1]);
    ctx.rotate(rot * Math.PI / 180);
    ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
    const dw = swap ? r.h : r.w, dh = swap ? r.w : r.h;
    if(o.filter && o.filter !== "none" && "filter" in ctx) ctx.filter = o.filter;
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  function normRotate(v){ return ((Math.round(Number(v || 0) / 90) * 90) % 360 + 360) % 360; }
  function videoFps(call){ const f = Number(opt(call, "fps") || 30); if(!(f >= 1 && f <= 60)) throw new Error("fps 는 1~60 이에요"); return f; }

  // 영상 구간 편집: 자르기·속도·크기·회전·필터·텍스트/이미지 레이어(애니메이션)·페이드·소리 유지·배경음
  async function editVideo(call){
    if(!call.out || !/\.webm$/i.test(call.out)) throw new Error("출력 경로는 .webm이어야 해요");
    recorderSupport();
    const layers = validateLayers(opt(call, "layers"));
    const v = await loadMediaEl(call.path, "video");
    let mix = null, music = null;
    const notes = [];
    try{
      const start = Number(call.start || 0), end = call.end == null ? v.duration : Math.min(Number(call.end), v.duration);
      const speed = Number(opt(call, "speed") || 1);
      if(!(speed >= 0.25 && speed <= 4)) throw new Error("speed 는 0.25~4 사이예요");
      if(!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error(`편집 구간을 확인하세요 (영상 길이 ${v.duration.toFixed(2)}초)`);
      const total = (end - start) / speed;
      if(total > MAX_VIDEO_SEC) throw new Error(`결과 영상은 최대 ${MAX_VIDEO_SEC}초예요 (현재 ${total.toFixed(1)}초)`);
      const rotate = normRotate(call.rotate), { w, h } = videoSize(call, v.videoWidth, v.videoHeight, rotate);
      const fps = videoFps(call), bitrate = bitrateFor(call, w, h, fps);
      const fset = mergedFilters(opt(call, "filters", "filter"), opt(call, "preset"));
      const filter = cssFilter(fset);
      const probe = newCanvas(1, 1).getContext("2d");
      if(filter !== "none" && !("filter" in probe)) notes.push("이 브라우저는 동영상 필터를 지원하지 않아 일부 필터 없이 만들었어요");
      await ensureFonts(layers, notes);
      const imgs = await preloadLayerImages(layers);
      const musicPath = opt(call, "music") || (typeof call.audio === "string" ? call.audio : null);
      if(opt(call, "keep_audio") || musicPath){ mix = makeAudioMix(); if(!mix) notes.push("오디오 합성을 지원하지 않아 무음으로 만들었어요"); }
      if(mix && opt(call, "keep_audio") && !mix.add(v, opt(call, "volume"))) notes.push("원본 소리를 가져오지 못했어요");
      if(mix && musicPath){ music = await loadMediaEl(musicPath, "audio"); music.loop = true; if(!mix.add(music, opt(call, "music_volume", "audio_volume"))) notes.push("배경음을 넣지 못했어요"); }
      v.playbackRate = speed; try{ v.preservesPitch = true; }catch(_){}
      await seekTo(v, start);
      const canvas = newCanvas(w, h), ctx = ctx2d(canvas);
      const bg = opt(call, "background") || "#000";
      const fin = Number(opt(call, "fade_in") || 0), fout = Number(opt(call, "fade_out") || 0);
      const mfade = Number(opt(call, "music_fade") || 1);
      const res = await record(canvas, fps, mix, bitrate, opt(call, "codec"), async (due, emit) => {
        try{ await v.play(); }
        catch(e){
          if(v.muted) throw new Error("영상 재생 실패: " + (e && e.message || e));
          v.muted = true; notes.push("브라우저 자동 재생 제한으로 원본 소리 없이 만들었어요");
          await v.play().catch(e2 => { throw new Error("영상 재생 실패: " + (e2 && e2.message || e2)); });
        }
        if(music){ music.currentTime = 0; music.play().catch(() => notes.push("배경음 재생 실패")); }
        await new Promise((resolve, reject) => {
          const guard = setTimeout(() => resolve(), (total + 20) * 1000);
          const step = now => {
            if(v.error){ clearTimeout(guard); reject(new Error("영상 재생 실패")); return; }
            const t = Math.max(0, (v.currentTime - start) / speed);
            if(due(now)){
              ctx.fillStyle = makeFill(ctx, bg, 0, 0, w, h); ctx.fillRect(0, 0, w, h);
              drawSource(ctx, v, v.videoWidth, v.videoHeight, w, h, { rotate, fit: String(call.fit || "stretch"), flipX: call.flipX || call.flip_x, flipY: call.flipY || call.flip_y, filter });
              frameOverlays(ctx, w, h, fset, t);
              if(layers.length) drawLayers(ctx, w, h, layers, imgs, t, total);
              letterbox(ctx, w, h, opt(call, "letterbox"));
              fadeOverlay(ctx, w, h, t, total, fin, fout);
              if(music && music._gain && mfade > 0) music._gain.gain.value = Number(opt(call, "music_volume") ?? 1) * clamp01(Math.min(t / mfade, (total - t) / mfade));
              emit(now);
            }
            if(v.currentTime >= end - 0.01 || v.ended){ clearTimeout(guard); resolve(); return; }
            nextFrame(step);
          };
          nextFrame(step);
        });
        v.pause(); if(music) music.pause();
      });
      const out = writeFile(call.out, res.data, "video/webm");
      return `${out} (${w}×${h}, ${total.toFixed(1)}초, ${fps}fps, ${(bitrate / 1e6).toFixed(1)}Mbps ${res.codec}${mix && mix.used ? ", 소리 포함" : ", 무음"})` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
    }finally{ v._revoke(); if(music) music._revoke(); if(mix) mix.close(); }
  }

  /* ---- 고화질 오프라인 인코딩 (WebCodecs) ----
     사진만으로 만드는 영상은 실시간 녹화(MediaRecorder) 대신 프레임을 하나씩 정확한 시각에 그려 인코딩한다.
     → 인코더가 느려도 프레임이 빠지지 않고(60fps 그대로), 탭이 숨겨져도 멈추지 않는다. WebM 컨테이너는 직접 만든다. */
  function ebml(id, ...parts){
    const idb = []; for(let v = id; v > 0; v = Math.floor(v / 256)) idb.unshift(v & 255);
    const body = concatBytes(parts.map(p => p instanceof Uint8Array ? p : typeof p === "string" ? new TextEncoder().encode(p) : new Uint8Array(p)));
    const size = [0x01]; for(let i = 6; i >= 0; i--) size.push(Math.floor(body.length / Math.pow(256, i)) & 255);
    return concatBytes([new Uint8Array(idb), new Uint8Array(size), body]);
  }
  function concatBytes(arr){ let n = 0; arr.forEach(a => n += a.length); const out = new Uint8Array(n); let o = 0; arr.forEach(a => { out.set(a, o); o += a.length; }); return out; }
  function ebUint(n, fixed){ const b = []; if(fixed){ for(let i = fixed - 1; i >= 0; i--) b.push(Math.floor(n / Math.pow(256, i)) & 255); return new Uint8Array(b); } do{ b.unshift(n & 255); n = Math.floor(n / 256); }while(n > 0); return new Uint8Array(b); }
  function ebFloat(x){ const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; }
  function muxWebM(frames, codecId, w, h, durationMs){
    const info = ebml(0x1549A966, ebml(0x2AD7B1, ebUint(1000000)), ebml(0x4D80, "Choimini"), ebml(0x5741, "Choimini"), ebml(0x4489, ebFloat(durationMs)));
    const tracks = ebml(0x1654AE6B, ebml(0xAE, ebml(0xD7, ebUint(1)), ebml(0x73C5, ebUint(1)), ebml(0x9C, ebUint(0)), ebml(0x86, codecId), ebml(0x83, ebUint(1)), ebml(0xE0, ebml(0xB0, ebUint(w)), ebml(0xBA, ebUint(h)))));
    const clusters = [], cueList = [];
    let cur = null;
    const flush = () => { if(cur){ clusters.push({ t: cur.t, bytes: ebml(0x1F43B675, ebml(0xE7, ebUint(cur.t)), ...cur.blocks) }); cur = null; } };
    for(const f of frames){
      const ms = Math.round(f.t / 1000);
      if(!cur || f.key || ms - cur.t > 30000){ flush(); cur = { t: ms, blocks: [] }; }
      const rel = ms - cur.t, hdr = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, f.key ? 0x80 : 0]);
      cur.blocks.push(ebml(0xA3, hdr, f.data));
    }
    flush();
    // SeekHead 은 고정 크기로 만들어 위치 계산을 단순하게 한다
    const seek = (id, pos) => ebml(0x4DBB, ebml(0x53AB, ebUint(id)), ebml(0x53AC, ebUint(pos, 8)));
    const seekLen = ebml(0x114D9B74, seek(0x1549A966, 0), seek(0x1654AE6B, 0), seek(0x1C53BB6B, 0)).length;
    let pos = seekLen + info.length + tracks.length;
    clusters.forEach(c => { cueList.push(ebml(0xBB, ebml(0xB3, ebUint(c.t)), ebml(0xB7, ebml(0xF7, ebUint(1)), ebml(0xF1, ebUint(pos))))); pos += c.bytes.length; });
    const cues = ebml(0x1C53BB6B, ...cueList);
    const seekHead = ebml(0x114D9B74, seek(0x1549A966, seekLen), seek(0x1654AE6B, seekLen + info.length), seek(0x1C53BB6B, pos));
    const head = ebml(0x1A45DFA3, ebml(0x4286, ebUint(1)), ebml(0x42F7, ebUint(1)), ebml(0x42F2, ebUint(4)), ebml(0x42F3, ebUint(8)), ebml(0x4282, "webm"), ebml(0x4287, ebUint(4)), ebml(0x4285, ebUint(2)));
    return new Blob([head, ebml(0x18538067, seekHead, info, tracks, ...clusters.map(c => c.bytes), cues)], { type: "video/webm" });
  }
  async function pickEncoder(w, h, fps, bitrate, pref){
    if(typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
    const lvl = w * h <= 1280 * 720 ? "31" : w * h <= 1920 * 1080 ? "41" : "51";
    const p = String(pref || "").toLowerCase();
    const list = (p === "vp8" ? [] : p === "av1" ? [["av01.0." + (w * h > 1920 * 1080 ? "12" : "08") + "M.08", "V_AV1", "av1"]] : []).concat(p === "vp8" ? [] : [["vp09.00." + lvl + ".08", "V_VP9", "vp9"]]).concat([["vp8", "V_VP8", "vp8"]]);
    for(const [codec, id, name] of list){
      for(const hw of ["prefer-hardware", "no-preference"]){
        const config = { codec, width: w, height: h, bitrate, framerate: fps, bitrateMode: "variable", latencyMode: "quality", hardwareAcceleration: hw };
        try{ const s = await VideoEncoder.isConfigSupported(config); if(s && s.supported) return { config: s.config || config, id, name }; }catch(_){}
      }
    }
    return null;
  }
  async function encodeOffline(canvas, w, h, fps, total, bitrate, codecPref, draw){
    const pick = await pickEncoder(w, h, fps, bitrate, codecPref);
    if(!pick) return null;
    const frames = []; let err = null;
    const enc = new VideoEncoder({ output: ch => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); frames.push({ t: ch.timestamp, key: ch.type === "key", data: b }); }, error: e => { err = e; } });
    enc.configure(pick.config);
    const n = Math.max(1, Math.round(total * fps)), gop = Math.max(1, Math.round(fps * 2));
    try{
      for(let i = 0; i < n; i++){
        if(err) throw err;
        draw(i / fps);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % gop === 0 }); vf.close();
        while(enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
        if(i % 20 === 19) await new Promise(r => setTimeout(r, 0)); // 화면이 멈추지 않게 가끔 양보
      }
      await enc.flush();
      if(err) throw err;
    }finally{ try{ enc.close(); }catch(_){} }
    frames.sort((a, b) => a.t - b.t);
    const blob = muxWebM(frames, pick.id, w, h, n * 1000 / fps);
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("영상 저장 실패")); r.readAsDataURL(blob); });
    return { data, frames: frames.length, codec: pick.name, hw: /hardware/.test(pick.config.hardwareAcceleration || "") };
  }

  /* ---- 장면 전환 ---- */
  const TRANSITIONS = ["none","fade","slide-left","slide-right","slide-up","slide-down","zoom","wipe-left","wipe-right","circle","blur","flash"];
  // create_video: 이미지·영상 클립을 이어 붙이고 전환·켄 번스·레이어 애니메이션·배경음
  async function createVideo(call){
    const paths = Array.isArray(call.paths) ? call.paths : [];
    if(!paths.length || paths.length > 60) throw new Error("이미지·영상 1~60개가 필요해요 (paths)");
    if(!call.out || !/\.webm$/i.test(call.out)) throw new Error("WebM 출력 경로(out)가 필요해요");
    recorderSupport();
    const layers = validateLayers(opt(call, "layers"));
    const per = Number(opt(call, "seconds_per_image") || 2);
    const durs = Array.isArray(call.durations) ? call.durations.map(Number) : [];
    if(!Number.isFinite(per) || per < 0.2) throw new Error("seconds_per_image 는 0.2초 이상이어야 해요");
    const w = Number(call.width || 720), h = Number(call.height || 720);
    if(!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > MAX_VW || h > MAX_VW || w * h > MAX_VW * MAX_VH) throw new Error(`올바른 크기가 필요해요 (최대 ${MAX_VW}×${MAX_VH})`);
    const fps = videoFps(call), bitrate = bitrateFor(call, w, h, fps);
    const trans = String(opt(call, "transition") || "none").toLowerCase();
    const transList = Array.isArray(opt(call, "transitions")) ? opt(call, "transitions").map(x => String(x).toLowerCase()) : null;
    [trans].concat(transList || []).forEach(t => { if(!TRANSITIONS.includes(t)) throw new Error("transition 은 " + TRANSITIONS.join(", ") + " 중 하나예요"); });
    const notes = [], clips = [];
    const fset = mergedFilters(opt(call, "filters", "filter"), opt(call, "preset"));
    // 사진 장면은 색 보정을 미리 한 번만 적용해 둔다 (매 프레임 필터는 느려서 프레임이 빠진다). 비네트·노이즈는 화면 전체에 프레임마다.
    const pixelSet = Object.assign({}, fset); delete pixelSet.vignette; delete pixelSet.grain;
    const hasPixel = Object.keys(pixelSet).length > 0;
    let mix = null, music = null;
    const musicPath = opt(call, "music") || (typeof call.audio === "string" ? call.audio : null);
    if(opt(call, "keep_audio") || musicPath){ mix = makeAudioMix(); if(!mix) notes.push("오디오 합성을 지원하지 않아 무음으로 만들었어요"); }
    try{
      for(let i = 0; i < paths.length; i++){
        const p = abs(paths[i]), e = state.fs[p];
        if(!e || e.type !== "file") throw new Error("파일이 없어요: " + p);
        const mime = e.mime && e.mime !== "application/octet-stream" ? e.mime : guessMime(p);
        if(/^video\//.test(mime)){
          const el = await loadMediaEl(p, "video");
          const d = Number.isFinite(durs[i]) && durs[i] > 0 ? Math.min(durs[i], el.duration) : el.duration;
          if(mix && opt(call, "keep_audio")) mix.add(el, opt(call, "volume"));
          clips.push({ kind:"video", el, d, sw: el.videoWidth, sh: el.videoHeight });
        }else if(/^image\//.test(mime)){
          const img = await loadImageEntry(p);
          // 큰 사진은 영상 크기에 맞게 미리 고품질로 줄여 둔다 (매 프레임 축소 품질 저하 방지)
          const s = Math.max(w / img.naturalWidth, h / img.naturalHeight) * 1.25;
          let pre = s < 0.5 ? prescale(img, 0, 0, img.naturalWidth, img.naturalHeight, Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s)) : null;
          if(hasPixel){
            const src = pre || img, cw = Math.min(src.naturalWidth || src.width, Math.ceil(img.naturalWidth * Math.min(1, s))), chh = Math.min(src.naturalHeight || src.height, Math.ceil(img.naturalHeight * Math.min(1, s)));
            const c = newCanvas(cw, chh), x = ctx2d(c); x.drawImage(src, 0, 0, cw, chh); applyFilters(x, cw, chh, pixelSet); pre = c;
          }
          // 미리 처리한 캔버스는 다시 이미지로 바꿔 둔다 (매 프레임 그리기가 더 빠르다)
          let el = img; if(pre){ try{ el = await canvasToImage(pre); }catch(_){ el = pre; } }
          clips.push({ kind:"image", el, d: Number.isFinite(durs[i]) && durs[i] > 0 ? durs[i] : per, sw: img.naturalWidth, sh: img.naturalHeight });
        }else throw new Error("이미지나 동영상이 아니에요: " + p);
      }
      const total = clips.reduce((s, c) => s + c.d, 0);
      if(total > MAX_VIDEO_SEC) throw new Error(`결과 영상은 최대 ${MAX_VIDEO_SEC}초예요 (현재 ${total.toFixed(1)}초)`);
      if(mix && musicPath){ music = await loadMediaEl(musicPath, "audio"); music.loop = true; if(!mix.add(music, opt(call, "music_volume", "audio_volume"))) notes.push("배경음을 넣지 못했어요"); }
      await ensureFonts(layers, notes);
      const imgs = await preloadLayerImages(layers);
      const td = trans !== "none" || transList ? Math.max(0.1, Math.min(2, Number(opt(call, "transition_seconds") || 0.6))) : 0;
      const kb = opt(call, "ken_burns", "zoom"), fit = String(call.fit || "contain"), bg = opt(call, "background") || "#000";
      const filter = cssFilter(fset);
      const fin = Number(opt(call, "fade_in") || 0), fout = Number(opt(call, "fade_out") || 0);
      const mfade = Number(opt(call, "music_fade") || 1);
      const canvas = newCanvas(w, h), ctx = ctx2d(canvas);
      const starts = []; clips.reduce((s, c, i) => (starts[i] = s, s + c.d), 0);
      // 켄 번스: true(자동 번갈아) | "in" | "out" | "left" | "right" | "up" | "down"
      const kbFor = (i, p) => {
        if(!kb) return { zoom:1, pan:null };
        const mode = kb === true ? ["in","out","left","right"][i % 4] : String(kb).toLowerCase(), q = p;
        if(mode === "out") return { zoom: 1.15 - 0.15 * q, pan:null };
        if(mode === "left") return { zoom: 1.12, pan:[(0.5 - q) * w * 0.08, 0] };
        if(mode === "right") return { zoom: 1.12, pan:[(q - 0.5) * w * 0.08, 0] };
        if(mode === "up") return { zoom: 1.12, pan:[0, (0.5 - q) * h * 0.08] };
        if(mode === "down") return { zoom: 1.12, pan:[0, (q - 0.5) * h * 0.08] };
        return { zoom: 1 + 0.15 * q, pan:null };
      };
      const drawClip = (c, i, t) => {
        const p = clamp01((t - starts[i]) / c.d), k = c.kind === "image" ? kbFor(i, p) : { zoom:1, pan:null };
        if(c.kind === "image"){ drawSource(ctx, c.el, c.el.width || c.sw, c.el.height || c.sh, w, h, { fit, zoom: k.zoom, pan: k.pan, rotate:0 }); return; }
        drawSource(ctx, c.el, c.sw, c.sh, w, h, { fit, rotate:0, filter });
        if(hasPixel) colorOverlay(ctx, w, h, fset);
      };
      const drawFrame = (t, i) => {
        ctx.fillStyle = makeFill(ctx, bg, 0, 0, w, h); ctx.fillRect(0, 0, w, h);
        const c = clips[i], nxt = clips[i + 1], tr = (transList && transList[i]) || trans;
        const tStart = nxt ? starts[i + 1] - td : Infinity;
        if(nxt && td && tr !== "none" && t > tStart && nxt.kind === "image"){
          const q = easeOut(clamp01((t - tStart) / td));
          ctx.save();
          if(tr === "fade" || tr === "blur"){ drawClip(c, i, t); ctx.globalAlpha = q; if(tr === "blur" && "filter" in ctx) ctx.filter = `blur(${(1 - q) * 12}px)`; drawClip(nxt, i + 1, t); }
          else if(/^slide/.test(tr)){
            const dx = tr === "slide-left" ? -w : tr === "slide-right" ? w : 0, dy = tr === "slide-up" ? -h : tr === "slide-down" ? h : 0;
            ctx.save(); ctx.translate(dx * q, dy * q); drawClip(c, i, t); ctx.restore();
            ctx.translate(-dx * (1 - q), -dy * (1 - q)); drawClip(nxt, i + 1, t);
          }else if(tr === "zoom"){ ctx.save(); ctx.globalAlpha = 1 - q; ctx.translate(w / 2, h / 2); ctx.scale(1 + q * 0.6, 1 + q * 0.6); ctx.translate(-w / 2, -h / 2); drawClip(c, i, t); ctx.restore(); ctx.globalAlpha = q; drawClip(nxt, i + 1, t); }
          else if(tr === "wipe-left" || tr === "wipe-right"){ drawClip(c, i, t); ctx.beginPath(); if(tr === "wipe-left") ctx.rect(w * (1 - q), 0, w * q, h); else ctx.rect(0, 0, w * q, h); ctx.clip(); drawClip(nxt, i + 1, t); }
          else if(tr === "circle"){ drawClip(c, i, t); ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.hypot(w, h) / 2 * q, 0, Math.PI * 2); ctx.clip(); drawClip(nxt, i + 1, t); }
          else if(tr === "flash"){ (q < 0.5 ? drawClip(c, i, t) : drawClip(nxt, i + 1, t)); ctx.globalAlpha = 1 - Math.abs(q - 0.5) * 2; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); }
          ctx.restore();
        }else drawClip(c, i, t);
        frameOverlays(ctx, w, h, fset, t, true);
        if(layers.length) drawLayers(ctx, w, h, layers, imgs, t, total);
        letterbox(ctx, w, h, opt(call, "letterbox"));
        fadeOverlay(ctx, w, h, t, total, fin, fout);
      };
      const clipAt = t => { let i = clips.length - 1; while(i > 0 && t < starts[i]) i--; return i; };
      // 사진만 있고 소리가 없으면 프레임 단위 오프라인 인코딩(빠짐없는 고화질). 아니면 실시간 녹화.
      if(!(mix && mix.used) && clips.every(c => c.kind === "image") && opt(call, "realtime") !== true){
        const off = await encodeOffline(canvas, w, h, fps, total, bitrate, opt(call, "codec"), t => drawFrame(Math.min(t, total - 1e-6), clipAt(t)));
        if(off){
          const out = writeFile(call.out, off.data, "video/webm");
          return `${out} (${w}×${h}, ${total.toFixed(1)}초, 장면 ${clips.length}개, ${fps}fps · ${off.frames}프레임, ${(bitrate / 1e6).toFixed(1)}Mbps ${off.codec}${off.hw ? " 하드웨어" : ""} 인코딩, 무음)` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
        }
      }
      const res = await record(canvas, fps, mix, bitrate, opt(call, "codec"), async (due, emit) => {
        if(music){ music.currentTime = 0; music.play().catch(() => notes.push("배경음 재생 실패")); }
        let cur = -1;
        const began = performance.now();
        await new Promise((resolve, reject) => {
          const frame = async now => {
            try{
              const t = Math.max(0, (now - began) / 1000); // rAF 시각은 시작 시각보다 조금 이를 수 있다
              if(t >= total){ resolve(); return; }
              let i = clips.length - 1; while(i > 0 && t < starts[i]) i--;
              const c = clips[i];
              if(i !== cur){
                if(cur >= 0 && clips[cur].kind === "video") clips[cur].el.pause();
                cur = i;
                if(c.kind === "video"){ await seekTo(c.el, 0); await c.el.play().catch(() => {}); }
              }
              if(due(now)){
                drawFrame(t, i);
                if(music && music._gain && mfade > 0) music._gain.gain.value = Number(opt(call, "music_volume") ?? 1) * clamp01(Math.min(t / mfade, (total - t) / mfade));
                emit(now);
              }
              nextFrame(frame);
            }catch(e){ reject(e); }
          };
          nextFrame(frame);
        });
        clips.forEach(c => { if(c.kind === "video") c.el.pause(); });
        if(music) music.pause();
      });
      const out = writeFile(call.out, res.data, "video/webm");
      return `${out} (${w}×${h}, ${total.toFixed(1)}초, 장면 ${clips.length}개, ${fps}fps, ${(bitrate / 1e6).toFixed(1)}Mbps ${res.codec}${mix && mix.used ? ", 소리 포함" : ", 무음"})` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
    }finally{
      clips.forEach(c => { if(c.kind === "video" && c.el._revoke) c.el._revoke(); });
      if(music) music._revoke(); if(mix) mix.close();
    }
  }

  // 이미지·영상·오디오 정보 (크기·길이) — 레이어 위치를 정하기 전에 확인용. path 없이 {fonts:true} 면 글꼴 목록
  async function mediaInfo(call){
    if(!call.path && (call.fonts || call.list === "fonts")) return "사용 가능한 글꼴(font 에 이름 또는 괄호 안 별명):\n" + fontList() + "\n그 밖의 Google Fonts 이름도 시도해요.";
    if(!call.path && (call.list === "shapes" || call.shapes)) return "shape: " + SHAPES.join(", ") + "\nlayer type: " + LAYER_TYPES.join(", ") + "\nanimation: " + ANIMS.join(", ") + "\ntransition: " + TRANSITIONS.join(", ") + "\npreset: " + Object.keys(PRESETS).join(", ");
    const p = abs(call.path), e = state.fs[p];
    if(!e || e.type !== "file") throw new Error("파일을 찾을 수 없어요: " + p);
    const mime = e.mime && e.mime !== "application/octet-stream" ? e.mime : guessMime(p);
    if(/^image\//.test(mime)){ const i = await loadImageEntry(p); return `${p}: 이미지 ${i.naturalWidth}×${i.naturalHeight}, ${mime}, ${e.size || 0}B`; }
    if(/^(video|audio)\//.test(mime)){
      const kind = /^video/.test(mime) ? "video" : "audio";
      const el = await loadMediaEl(p, kind);
      try{ return `${p}: ${kind === "video" ? `동영상 ${el.videoWidth}×${el.videoHeight}, ` : "오디오 "}${el.duration.toFixed(2)}초, ${mime}, ${e.size || 0}B`; }
      finally{ el._revoke(); }
    }
    throw new Error("미디어 파일이 아니에요: " + p + " (" + mime + ")");
  }

  Object.assign(api, { editImage, editVideo, createVideo, mediaInfo, loadFont, fontFamilyOf });

  /* ============================================================================
     ChoiminiToolRunner
     ----------------------------------------------------------------------------
     AI 응답 속 ```tool\n{ "tool": "...", ... }\n``` 블록(index.html의 parseToolCalls가
     이미 파싱함)을 받아 위 LinuxFS API로 실행하고, 사람이 읽을 출력 문자열을 반환한다.
     Desktop 앱(DesktopBridge)이 없는 순수 브라우저 WORK/CODE 모드 전용 실행기.
     ============================================================================ */
  const FS_TOOLS = new Set(["fs_ls","fs_pwd","fs_cd","fs_mkdir","fs_touch","fs_write","fs_read","fs_rm","fs_mv","fs_cp","fs_find","fs_grep","fs_head","fs_tail"]);
  const CODE_ONLY_TOOLS = new Set([]); // WORK 에서도 pkg/pip/npm 을 쓸 수 있으므로 모드 제한 없음
  const SHELL_TOOLS = new Set(["runcmd"]);

  async function runToolCall(call, mode){
    const tool = call && call.tool;
    if(!tool) throw new Error("tool 필드 없음");
    if(CODE_ONLY_TOOLS.has(tool) && mode !== "code"){
      throw new Error(`'${tool}'은 CODE 모드에서만 사용 가능함 (현재: ${mode})`);
    }
    switch(tool){
      case "runcmd": {
        if(!global.ChoiminiShell) throw new Error("셸 모듈(choimini-shell.js)이 로드되지 않음");
        const cmd = call.command != null ? call.command : call.cmd;
        if(cmd == null || !String(cmd).trim()) throw new Error("command 필드 없음");
        const r = await global.ChoiminiShell.run(String(cmd));
        return (r.output || "(출력 없음)") + (r.code ? `\n[종료 코드 ${r.code}]` : "");
      }
      case "fs_ls": {
        const items = ls(call.path);
        if(!items.length) return "(비어있음)";
        return items.map(i => `${i.type==="dir"?"📁":"📄"} ${i.name}${i.type==="file"?` (${i.size}B)`:""}`).join("\n");
      }
      case "fs_pwd": return pwd();
      case "fs_cd": return "현재 위치: " + cd(call.path);
      case "fs_mkdir": return "생성됨: " + mkdir(call.path);
      case "fs_touch": return "생성됨: " + touch(call.path);
      case "fs_write": return "저장됨: " + writeFile(call.path, call.content ?? "", call.mime);
      case "fs_read": {
        const c = readFile(call.path);
        const s = String(c);
        return s.length > 8000 ? s.slice(0,8000) + "\n...(생략됨)" : s;
      }
      case "fs_rm": return "삭제됨: " + rm(call.path, !!call.recursive);
      case "fs_mv": return "이동됨: " + mv(call.from, call.to);
      case "fs_cp": return "복사됨: " + cp(call.from, call.to);
      case "fs_find": { const r = find(call.path, call.pattern); return r.length ? r.join("\n") : "(일치 없음)"; }
      case "fs_grep": { const r = grep(call.pattern, call.path); return r.length ? r.join("\n") : "(일치 없음)"; }
      case "fs_head": return head(call.path, call.n);
      case "fs_tail": return tail(call.path, call.n);
      case "pkg_install": {
        const r = pkgInstall(call.name);
        return r.alreadyInstalled ? `이미 설치됨: ${r.name}` : `설치 완료(시뮬레이션): ${r.name}`;
      }
      case "pkg_list": { const l = pkgList(); return l.length ? l.join(", ") : "(설치된 패키지 없음)"; }
      case "create_video": return "영상 생성 완료 (WebM): " + await createVideo(call);
      case "edit_video": return "영상 편집 완료 (WebM): " + await editVideo(call);
      case "media_info": return await mediaInfo(call);
      case "font_list": return await mediaInfo({ fonts:true });
      case "edit_image": return "편집 완료: " + await editImage(call);
      case "convert_image": {
        const out = await convertImage(call.path, call.format);
        return "변환 완료: " + out;
      }
      default:
        throw new Error(`알 수 없는 도구: ${tool} (fs_ls, fs_read, fs_write, fs_mkdir, fs_rm, fs_mv, fs_cp, fs_find, fs_grep, fs_head, fs_tail, pkg_install, pkg_list, convert_image, edit_image, create_video, edit_video, media_info 중에서만 사용 가능)`);
    }
  }

  global.ChoiminiToolRunner = {
    isFsTool(name){ return SHELL_TOOLS.has(name) || FS_TOOLS.has(name) || CODE_ONLY_TOOLS.has(name) || (["convert_image","edit_image","edit_video","create_video","media_info","font_list","pkg_install","pkg_list"].includes(name)); },
    run: (call, mode) => global.LinuxFS.asAI(() => runToolCall(call, mode))
  };

})(window);
