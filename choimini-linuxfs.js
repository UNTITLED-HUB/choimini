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
     미디어 편집 (브라우저 Canvas · MediaRecorder)
     ----------------------------------------------------------------------------
     기존 도구 이름과 인자(convert_image / edit_image / create_video / edit_video)는 그대로 두고
     선택 인자만 추가했다. 새 인자를 안 쓰면 예전과 같은 결과가 나온다.
       · filters  : {brightness, contrast, saturation, grayscale, sepia, invert, hue, blur, sharpen}
       · layers   : [{type:"text"|"image"|"rect"|"ellipse"|"line"|"gradient", ...}] 위에서부터 순서대로 합성
       · rotate, fit(stretch|contain|cover), background, vignette, quality
       · 동영상: speed, fade_in, fade_out, keep_audio, audio(배경음 파일), transition(fade), ken_burns, durations
     ============================================================================ */
  const BLEND_MODES = { normal:"source-over", "source-over":"source-over", multiply:"multiply", screen:"screen", overlay:"overlay", darken:"darken", lighten:"lighten", "color-dodge":"color-dodge", "color-burn":"color-burn", "hard-light":"hard-light", "soft-light":"soft-light", difference:"difference", exclusion:"exclusion", hue:"hue", saturation:"saturation", color:"color", luminosity:"luminosity" };
  const DEFAULT_FONT = "'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif";
  const MAX_MEDIA_SEC = 60;
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
  function mediaEntry(path, kind){
    const p = abs(path), e = state.fs[p];
    const re = kind === "image" ? /^image\// : kind === "video" ? /^video\// : kind === "audio" ? /^audio\// : /^(image|video|audio)\//;
    if(!e || e.type !== "file") throw new Error("파일을 찾을 수 없어요: " + p);
    if(!re.test(e.mime || "") && !(kind && guessMime(p).startsWith(kind + "/"))) throw new Error(`${kind === "image" ? "이미지" : kind === "video" ? "동영상" : kind === "audio" ? "오디오" : "미디어"} 파일이 아니에요: ${p} (${e.mime || "형식 모름"})`);
    return { path: p, entry: e };
  }
  function guessMime(p){
    const ext = (String(p).match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    return ({ png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", bmp:"image/bmp", svg:"image/svg+xml", webm:"video/webm", mp4:"video/mp4", mov:"video/quicktime", ogv:"video/ogg", mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", m4a:"audio/mp4", aac:"audio/aac", opus:"audio/ogg" })[ext.toLowerCase()] || "";
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
  function roundRectPath(ctx, x, y, w, h, r){
    r = Math.max(0, Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }
  function newCanvas(w, h){ const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function checkSize(w, h, max){
    max = max || 4096;
    if(!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > max || h > max || w * h > 16777216) throw new Error(`크기가 올바르지 않아요 (1~${max}px): ${w}×${h}`);
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
    return { x, y };
  }
  function shadowOf(v){
    if(!v) return null;
    if(v === true) return { color:"rgba(0,0,0,.6)", blur:6, x:2, y:2 };
    return { color: v.color || "rgba(0,0,0,.6)", blur: Number(v.blur != null ? v.blur : 6), x: Number(v.x != null ? v.x : 2), y: Number(v.y != null ? v.y : 2) };
  }
  // 줄바꿈: 공백 기준, 너무 긴 단어(한글 포함)는 글자 단위
  function wrapText(ctx, text, maxW){
    const out = [];
    String(text).split(/\r?\n/).forEach(par => {
      if(!maxW || ctx.measureText(par).width <= maxW){ out.push(par); return; }
      let line = "";
      const words = par.split(/(\s+)/);
      for(const word of words){
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
  // 레이어의 시간창(동영상): start~end 사이에만 보이고 fade 초만큼 서서히 나타나고 사라진다
  function layerAlpha(L, t){
    const base = Number(opt(L, "opacity") != null ? opt(L, "opacity") : 1);
    if(t == null) return base;
    const s = Number(opt(L, "start") || 0), e = opt(L, "end") != null ? Number(opt(L, "end")) : Infinity;
    if(t < s || t > e) return 0;
    const f = Number(opt(L, "fade") || 0);
    let a = 1; if(f > 0){ a = Math.min(1, (t - s) / f); if(Number.isFinite(e)) a = Math.min(a, (e - t) / f); }
    return base * Math.max(0, Math.min(1, a));
  }
  function chromaKey(img, keyColor, tol){
    const c = newCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height), x = c.getContext("2d");
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
  // 레이어 합성 (이미지·동영상 공용). images: path → 미리 읽어 둔 이미지(크로마키 적용본 포함)
  function drawLayers(ctx, W, H, layers, images, t){
    for(const L of layers || []){
      if(!L || typeof L !== "object") continue;
      const alpha = layerAlpha(L, t); if(alpha <= 0) continue;
      const type = String(L.type || (L.text != null ? "text" : L.path ? "image" : "rect")).toLowerCase();
      ctx.save();
      ctx.globalAlpha = alpha;
      const blend = BLEND_MODES[String(opt(L, "blend") || "normal").toLowerCase()];
      if(blend) ctx.globalCompositeOperation = blend;
      const sh = shadowOf(opt(L, "shadow"));
      const rot = Number(opt(L, "rotate") || 0) * Math.PI / 180;
      const withRotate = (x, y, w, h, fn) => { if(rot){ ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rot); fn(-w / 2, -h / 2); } else fn(x, y); };
      if(type === "text"){
        const size = len(opt(L, "size", "font_size"), Math.min(W, H), Math.round(Math.min(W, H) * 0.07));
        const fam = opt(L, "font", "font_family") ? String(opt(L, "font", "font_family")) + "," + DEFAULT_FONT : DEFAULT_FONT;
        const weight = opt(L, "weight", "font_weight") || (opt(L, "bold") ? "bold" : "normal");
        ctx.font = `${opt(L, "italic") ? "italic " : ""}${weight} ${size}px ${fam}`;
        const maxW = opt(L, "max_width") != null ? len(opt(L, "max_width"), W) : W - 2 * len(opt(L, "margin"), Math.min(W, H), Math.round(Math.min(W, H) * 0.04));
        const lines = wrapText(ctx, String(L.text == null ? "" : L.text), maxW);
        const lh = size * Number(opt(L, "line_height") || 1.25);
        const tw = Math.max(1, ...lines.map(l => ctx.measureText(l).width)), th = lh * lines.length;
        const pad = len(opt(L, "padding"), size, opt(L, "background") ? Math.round(size * 0.35) : 0);
        const box = place(L, W, H, tw + pad * 2, th + pad * 2);
        const align = String(opt(L, "align") || (/(^|-)left/.test(String(opt(L, "position") || "")) ? "left" : /right/.test(String(opt(L, "position") || "")) ? "right" : opt(L, "position") ? "center" : "left")).toLowerCase();
        withRotate(box.x, box.y, tw + pad * 2, th + pad * 2, (bx, by) => {
          if(opt(L, "background")){
            ctx.save(); ctx.fillStyle = String(opt(L, "background")); roundRectPath(ctx, bx, by, tw + pad * 2, th + pad * 2, len(opt(L, "radius"), size, Math.round(size * 0.25))); ctx.fill(); ctx.restore();
          }
          ctx.textBaseline = "top"; ctx.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
          const ax = align === "right" ? bx + pad + tw : align === "center" ? bx + pad + tw / 2 : bx + pad;
          const sw = Number(opt(L, "stroke_width") || (opt(L, "stroke", "stroke_color") ? Math.max(2, size / 12) : 0));
          lines.forEach((line, i) => {
            const ly = by + pad + i * lh + (lh - size) / 2;
            if(sw > 0){ ctx.save(); ctx.lineJoin = "round"; ctx.lineWidth = sw; ctx.strokeStyle = String(opt(L, "stroke", "stroke_color") || "#000"); ctx.strokeText(line, ax, ly); ctx.restore(); }
            if(sh){ ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.x; ctx.shadowOffsetY = sh.y; }
            ctx.fillStyle = String(opt(L, "color") || "#ffffff"); ctx.fillText(line, ax, ly);
          });
        });
      }else if(type === "image"){
        const src = images[L._key || L.path];
        if(src){
          const iw = src.naturalWidth || src.videoWidth || src.width, ih = src.naturalHeight || src.videoHeight || src.height;
          let w = opt(L, "width") != null ? len(opt(L, "width"), W) : null, h = opt(L, "height") != null ? len(opt(L, "height"), H) : null;
          const sc = opt(L, "scale") != null ? Number(opt(L, "scale")) : null;
          if(w == null && h == null){ w = iw * (sc || 1); h = ih * (sc || 1); }
          else if(w == null) w = iw * h / ih; else if(h == null) h = ih * w / iw;
          const pos = place(L, W, H, w, h);
          withRotate(pos.x, pos.y, w, h, (x, y) => {
            const shape = String(opt(L, "shape", "mask") || "").toLowerCase();
            if(sh && !shape){ ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.x; ctx.shadowOffsetY = sh.y; }
            if(shape === "circle" || shape === "ellipse"){ ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.clip(); }
            else if(shape === "rounded" || opt(L, "radius") != null){ roundRectPath(ctx, x, y, w, h, len(opt(L, "radius"), Math.min(w, h), Math.min(w, h) * 0.12)); ctx.clip(); }
            const r = fitRect(iw, ih, w, h, String(opt(L, "fit") || "stretch"));
            if(opt(L, "flip_x")){ ctx.translate(x * 2 + w, 0); ctx.scale(-1, 1); }
            ctx.drawImage(src, x + r.x, y + r.y, r.w, r.h);
            const bw = Number(opt(L, "border_width") || (opt(L, "border") ? 4 : 0));
            if(bw > 0){ ctx.lineWidth = bw; ctx.strokeStyle = String(opt(L, "border", "border_color") || "#fff"); if(shape === "circle" || shape === "ellipse"){ ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2 - bw / 2, h / 2 - bw / 2, 0, 0, Math.PI * 2); } else roundRectPath(ctx, x + bw / 2, y + bw / 2, w - bw, h - bw, opt(L, "radius") != null || shape === "rounded" ? len(opt(L, "radius"), Math.min(w, h), Math.min(w, h) * 0.12) : 0); ctx.stroke(); }
          });
        }
      }else if(type === "rect" || type === "ellipse" || type === "circle"){
        const w = len(opt(L, "width"), W, W), h = len(opt(L, "height"), H, type === "circle" ? w : H);
        const pos = place(L, W, H, w, h, 0);
        withRotate(pos.x, pos.y, w, h, (x, y) => {
          if(type === "rect") roundRectPath(ctx, x, y, w, h, len(opt(L, "radius"), Math.min(w, h), 0));
          else { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); }
          if(sh){ ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.x; ctx.shadowOffsetY = sh.y; }
          const fill = opt(L, "color", "fill");
          if(fill !== "none" && (fill != null || !opt(L, "stroke"))){ ctx.fillStyle = String(fill || "rgba(0,0,0,.5)"); ctx.fill(); }
          if(opt(L, "stroke")){ ctx.shadowColor = "transparent"; ctx.lineWidth = Number(opt(L, "stroke_width") || 3); ctx.strokeStyle = String(opt(L, "stroke")); ctx.stroke(); }
        });
      }else if(type === "line" || type === "arrow"){
        const x1 = len(opt(L, "x1"), W, 0), y1 = len(opt(L, "y1"), H, 0), x2 = len(opt(L, "x2"), W, W), y2 = len(opt(L, "y2"), H, H);
        const lw = Number(opt(L, "width", "stroke_width") || 4);
        ctx.strokeStyle = ctx.fillStyle = String(opt(L, "color") || "#ff3b30"); ctx.lineWidth = lw; ctx.lineCap = "round";
        if(opt(L, "dash")) ctx.setLineDash([].concat(opt(L, "dash")).map(Number));
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        if(type === "arrow" || opt(L, "arrow")){
          const a = Math.atan2(y2 - y1, x2 - x1), s = lw * 4;
          ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45)); ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
        }
      }else if(type === "gradient"){
        const w = len(opt(L, "width"), W, W), h = len(opt(L, "height"), H, H), pos = place(L, W, H, w, h, 0);
        const dir = String(opt(L, "direction") || "down").toLowerCase();
        const g = dir === "radial" ? ctx.createRadialGradient(pos.x + w / 2, pos.y + h / 2, 0, pos.x + w / 2, pos.y + h / 2, Math.max(w, h) / 2)
          : ctx.createLinearGradient(dir === "right" ? pos.x : dir === "left" ? pos.x + w : pos.x, dir === "down" ? pos.y : dir === "up" ? pos.y + h : pos.y, dir === "right" ? pos.x + w : dir === "left" ? pos.x : pos.x, dir === "down" ? pos.y + h : dir === "up" ? pos.y : pos.y);
        const stops = Array.isArray(L.colors) && L.colors.length > 1 ? L.colors : [opt(L, "from") || "rgba(0,0,0,0)", opt(L, "to") || "rgba(0,0,0,.7)"];
        stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), String(c)));
        ctx.fillStyle = g; ctx.fillRect(pos.x, pos.y, w, h);
      }
      ctx.restore();
    }
  }
  // 레이어에 쓰인 이미지들을 미리 읽는다 (크로마키 적용본은 별도 키)
  async function preloadLayerImages(layers){
    const map = {};
    for(const L of layers || []){
      if(!L || !L.path || String(L.type || "image").toLowerCase() !== "image") continue;
      const ck = opt(L, "chroma_key", "remove_color");
      const key = L.path + (ck ? "#ck" + JSON.stringify(ck) : "");
      L._key = key;
      if(map[key]) continue;
      const img = await loadImageEntry(L.path);
      map[key] = ck ? chromaKey(img, typeof ck === "object" ? ck.color : ck, typeof ck === "object" ? ck.tolerance : undefined) : img;
    }
    return map;
  }
  function validateLayers(layers){
    if(layers == null) return [];
    if(!Array.isArray(layers)) throw new Error("layers 는 배열이어야 해요");
    if(layers.length > 50) throw new Error("layers 는 최대 50개예요");
    const types = ["text","image","rect","ellipse","circle","line","arrow","gradient"];
    layers.forEach((L, i) => { const t = String(L && (L.type || (L.text != null ? "text" : L.path ? "image" : "rect"))).toLowerCase(); if(!types.includes(t)) throw new Error(`layers[${i}].type 은 ${types.join(", ")} 중 하나예요`); if(t === "image" && !L.path) throw new Error(`layers[${i}] 이미지 레이어에는 path 가 필요해요`); });
    return layers;
  }
  // 픽셀 필터 (모든 브라우저에서 같은 결과). 값: brightness·contrast·saturation 1=원본, grayscale·sepia·invert 0~1, hue 도, blur px, sharpen 0~2
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
    const br = num("brightness", 1), ct = num("contrast", 1), sat = num("saturation", num("saturate", 1)), gs = num("grayscale", 0), sp = num("sepia", 0), inv = num("invert", 0), hue = num("hue", num("hue_rotate", 0)), shp = num("sharpen", 0);
    if(br === 1 && ct === 1 && sat === 1 && !gs && !sp && !inv && !hue && !shp) return;
    const d = ctx.getImageData(0, 0, w, h), a = d.data;
    const cos = Math.cos(hue * Math.PI / 180), sin = Math.sin(hue * Math.PI / 180);
    const hm = hue ? [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
      0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
      0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072] : null;
    for(let i = 0; i < a.length; i += 4){
      let r = a[i], g = a[i+1], b = a[i+2];
      if(hm){ const R = r * hm[0] + g * hm[1] + b * hm[2], G = r * hm[3] + g * hm[4] + b * hm[5], B = r * hm[6] + g * hm[7] + b * hm[8]; r = R; g = G; b = B; }
      if(sat !== 1){ const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
      if(gs){ const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r += (l - r) * gs; g += (l - g) * gs; b += (l - b) * gs; }
      if(sp){ const R = 0.393 * r + 0.769 * g + 0.189 * b, G = 0.349 * r + 0.686 * g + 0.168 * b, B = 0.272 * r + 0.534 * g + 0.131 * b; r += (R - r) * sp; g += (G - g) * sp; b += (B - b) * sp; }
      if(br !== 1){ r *= br; g *= br; b *= br; }
      if(ct !== 1){ r = (r - 128) * ct + 128; g = (g - 128) * ct + 128; b = (b - 128) * ct + 128; }
      if(inv){ r += (255 - 2 * r) * inv; g += (255 - 2 * g) * inv; b += (255 - 2 * b) * inv; }
      a[i] = r; a[i+1] = g; a[i+2] = b; // Uint8ClampedArray 가 0~255 로 자른다
    }
    if(shp > 0){
      const src = new Uint8ClampedArray(a), k = shp;
      for(let y = 1; y < h - 1; y++) for(let x = 1; x < w - 1; x++){
        const i = (y * w + x) * 4;
        for(let c = 0; c < 3; c++){ const v = src[i + c] * (1 + 4 * k) - k * (src[i + c - 4] + src[i + c + 4] + src[i + c - w * 4] + src[i + c + w * 4]); a[i + c] = v; }
      }
    }
    ctx.putImageData(d, 0, 0);
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
  // 동영상 프레임용 CSS 필터 문자열 (픽셀 필터는 실시간으로 너무 느리다)
  function cssFilter(f){
    if(!f || typeof f !== "object") return "none";
    const p = [], v = k => opt(f, k);
    if(v("brightness") != null) p.push(`brightness(${Number(v("brightness"))})`);
    if(v("contrast") != null) p.push(`contrast(${Number(v("contrast"))})`);
    const s = v("saturation") != null ? v("saturation") : v("saturate"); if(s != null) p.push(`saturate(${Number(s)})`);
    if(v("grayscale") != null) p.push(`grayscale(${Number(v("grayscale"))})`);
    if(v("sepia") != null) p.push(`sepia(${Number(v("sepia"))})`);
    if(v("invert") != null) p.push(`invert(${Number(v("invert"))})`);
    const h = v("hue") != null ? v("hue") : v("hue_rotate"); if(h != null) p.push(`hue-rotate(${Number(h)}deg)`);
    if(v("blur") != null) p.push(`blur(${Number(v("blur"))}px)`);
    return p.join(" ") || "none";
  }
  function vignette(ctx, w, h, amount){
    amount = Number(amount); if(!(amount > 0)) return;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount)})`);
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  function outFormat(call, fallback){
    const ext = (String(call.out || "").match(/\.([a-z0-9]+)$/i) || [])[1];
    const f = String(call.format || (ext ? ext : fallback || "png")).toLowerCase().replace(/^jpg$/, "jpeg");
    if(!["png","jpeg","webp"].includes(f)) throw new Error("지원 형식: png, jpeg, webp");
    return f;
  }
  function canvasToFile(canvas, out, format, quality){
    const mime = "image/" + format;
    const q = quality != null ? Math.max(0.1, Math.min(1, Number(quality) > 1 ? Number(quality) / 100 : Number(quality))) : 0.92;
    const data = canvas.toDataURL(mime, q);
    if(!data.startsWith("data:" + mime + ";")) throw new Error("브라우저에서 지원하지 않는 형식이에요: " + format);
    const ext = format === "jpeg" ? "jpg" : format;
    const fixed = /\.[a-z0-9]+$/i.test(out) ? out : out + "." + ext;
    return writeFile(fixed, data, mime);
  }

  async function editImage(call){
    const layers = validateLayers(opt(call, "layers"));
    if(!call.out) throw new Error("결과 파일 경로 out이 필요해요");
    const format = outFormat(call, "png");
    let img = null;
    if(call.path) img = await loadImageEntry(call.path);
    else if(!(call.width && call.height)) throw new Error("path(원본 이미지) 또는 빈 캔버스용 width·height 가 필요해요");
    const iw = img ? img.naturalWidth : Number(call.width), ih = img ? img.naturalHeight : Number(call.height);
    const crop = call.crop || {}, x = Number(crop.x || 0), y = Number(crop.y || 0), sw = Number(crop.width || iw - x), sh = Number(crop.height || ih - y);
    if(![x,y,sw,sh].every(Number.isFinite) || x < 0 || y < 0 || sw <= 0 || sh <= 0 || x + sw > iw + 0.5 || y + sh > ih + 0.5) throw new Error(`자르기 영역이 이미지(${iw}×${ih}) 밖이에요`);
    // 회전: 90/180/270 은 정확히, 그 밖의 각도는 잘리지 않게 캔버스를 넓힌다
    const deg = ((Number(call.rotate || 0) % 360) + 360) % 360, rad = deg * Math.PI / 180;
    const rw = Math.round(Math.abs(sw * Math.cos(rad)) + Math.abs(sh * Math.sin(rad))), rh = Math.round(Math.abs(sw * Math.sin(rad)) + Math.abs(sh * Math.cos(rad)));
    let w = Number(call.width || 0), h = Number(call.height || 0);
    if(!img){ w = iw; h = ih; }
    else if(w && !h) h = Math.round(rh * w / rw);
    else if(h && !w) w = Math.round(rw * h / rh);
    w = w || rw; h = h || rh;
    checkSize(w, h);
    const canvas = newCanvas(w, h), ctx = canvas.getContext("2d");
    const bg = opt(call, "background") || (format === "jpeg" ? "#ffffff" : null);
    if(bg){ ctx.fillStyle = String(bg); ctx.fillRect(0, 0, w, h); }
    if(img){
      const r = fitRect(rw, rh, w, h, String(call.fit || "stretch"));
      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.scale(r.w / rw, r.h / rh);
      ctx.rotate(rad);
      ctx.scale(call.flipX || call.flip_x ? -1 : 1, call.flipY || call.flip_y ? -1 : 1);
      ctx.drawImage(img, x, y, sw, sh, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }
    applyFilters(ctx, w, h, opt(call, "filters", "filter"));
    if(layers.length) drawLayers(ctx, w, h, layers, await preloadLayerImages(layers), null);
    vignette(ctx, w, h, opt(call, "vignette"));
    const out = canvasToFile(canvas, call.out, format, opt(call, "quality"));
    return `${out} (${w}×${h}, ${format}${layers.length ? ", 레이어 " + layers.length + "개" : ""})`;
  }

  /* ---- 동영상 공통: 캔버스 녹화 ---- */
  function recorderSupport(){
    if(typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream || !MediaRecorder.isTypeSupported("video/webm")) throw new Error("이 브라우저는 WebM 동영상 제작을 지원하지 않아요 (Chrome·Edge·Firefox 권장)");
  }
  function pickMime(withAudio){
    const c = withAudio ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"] : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return c.find(m => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }
  // 탭이 숨겨지면 requestAnimationFrame 이 멈춰 녹화가 끝나지 않던 문제 → 숨김 상태에선 타이머로 진행
  function nextFrame(cb){ if(document.hidden) setTimeout(() => cb(performance.now()), 33); else requestAnimationFrame(cb); }
  function makeAudioMix(){
    let ac = null;
    try{ const AC = global.AudioContext || global.webkitAudioContext; if(AC) ac = new AC(); }catch(_){}
    if(!ac || !ac.createMediaStreamDestination) return null;
    const dest = ac.createMediaStreamDestination();
    return {
      ac, dest, used: false,
      add(el, volume){ try{ el.muted = false; el.volume = 1; const src = ac.createMediaElementSource(el), g = ac.createGain(); g.gain.value = volume == null ? 1 : Math.max(0, Math.min(2, Number(volume))); src.connect(g); g.connect(dest); this.used = true; return true; }catch(e){ return false; } },
      async resume(){ try{ if(ac.state === "suspended") await ac.resume(); }catch(_){} },
      close(){ try{ ac.close(); }catch(_){} }
    };
  }
  async function record(canvas, fps, mix, render){
    const vstream = canvas.captureStream(fps);
    const tracks = vstream.getVideoTracks().slice();
    if(mix && mix.used) tracks.push(...mix.dest.stream.getAudioTracks());
    const stream = new MediaStream(tracks), mimeType = pickMime(mix && mix.used), chunks = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = () => reject(new Error("영상 인코딩 실패")); });
    try{
      if(mix) await mix.resume();
      rec.start(250);
      await render();
      await new Promise(r => setTimeout(r, 120)); // 마지막 프레임이 담기도록 잠깐 기다린다
      rec.stop(); await stopped;
    }finally{
      if(rec.state !== "inactive") try{ rec.stop(); }catch(_){}
      stream.getTracks().forEach(t => t.stop()); vstream.getTracks().forEach(t => t.stop());
    }
    const blob = new Blob(chunks, { type: "video/webm" });
    if(!blob.size) throw new Error("녹화된 영상이 비어 있어요 (탭을 띄워 둔 채로 다시 시도해 주세요)");
    return await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("영상 저장 실패")); r.readAsDataURL(blob); });
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
    if(!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 1920 || h > 1080) throw new Error(`영상 크기가 올바르지 않아요 (최대 1920×1080): ${w}×${h}`);
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
  function normRotate(v){ const d = ((Math.round(Number(v || 0) / 90) * 90) % 360 + 360) % 360; return d; }

  // 영상 구간 편집: 자르기·속도·크기·회전·필터·텍스트/이미지 레이어·페이드·소리 유지
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
      if(total > MAX_MEDIA_SEC) throw new Error(`결과 영상은 최대 ${MAX_MEDIA_SEC}초예요 (현재 ${total.toFixed(1)}초)`);
      const rotate = normRotate(call.rotate), { w, h } = videoSize(call, v.videoWidth, v.videoHeight, rotate);
      const filter = cssFilter(opt(call, "filters", "filter"));
      const probe = newCanvas(1, 1).getContext("2d");
      if(filter !== "none" && !("filter" in probe)){ notes.push("이 브라우저는 동영상 필터를 지원하지 않아 필터 없이 만들었어요"); }
      const imgs = await preloadLayerImages(layers);
      if(opt(call, "keep_audio", "audio") || opt(call, "music")){ mix = makeAudioMix(); if(!mix) notes.push("오디오 합성을 지원하지 않아 무음으로 만들었어요"); }
      if(mix && opt(call, "keep_audio") && !mix.add(v, opt(call, "volume"))) notes.push("원본 소리를 가져오지 못했어요");
      const musicPath = opt(call, "music") || (typeof call.audio === "string" ? call.audio : null);
      if(mix && musicPath){ music = await loadMediaEl(musicPath, "audio"); music.loop = true; if(!mix.add(music, opt(call, "music_volume", "audio_volume"))) notes.push("배경음을 넣지 못했어요"); }
      v.playbackRate = speed; try{ v.preservesPitch = true; }catch(_){}
      await seekTo(v, start);
      const canvas = newCanvas(w, h), ctx = canvas.getContext("2d");
      const bg = String(opt(call, "background") || "#000");
      const fin = Number(opt(call, "fade_in") || 0), fout = Number(opt(call, "fade_out") || 0);
      const fps = Math.max(10, Math.min(60, Number(opt(call, "fps") || 30)));
      const data = await record(canvas, fps, mix, async () => {
        try{ await v.play(); }
        catch(e){
          if(v.muted) throw new Error("영상 재생 실패: " + (e && e.message || e));
          v.muted = true; notes.push("브라우저 자동 재생 제한으로 원본 소리 없이 만들었어요");
          await v.play().catch(e2 => { throw new Error("영상 재생 실패: " + (e2 && e2.message || e2)); });
        }
        if(music){ music.currentTime = 0; music.play().catch(() => notes.push("배경음 재생 실패")); }
        await new Promise((resolve, reject) => {
          const guard = setTimeout(() => resolve(), (total + 15) * 1000);
          const step = () => {
            if(v.error){ clearTimeout(guard); reject(new Error("영상 재생 실패")); return; }
            const t = Math.max(0, (v.currentTime - start) / speed);
            ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
            drawSource(ctx, v, v.videoWidth, v.videoHeight, w, h, { rotate, fit: String(call.fit || "stretch"), flipX: call.flipX || call.flip_x, flipY: call.flipY || call.flip_y, filter });
            if(layers.length) drawLayers(ctx, w, h, layers, imgs, t);
            fadeOverlay(ctx, w, h, t, total, fin, fout);
            if(v.currentTime >= end - 0.01 || v.ended){ clearTimeout(guard); resolve(); return; }
            nextFrame(step);
          };
          step();
        });
        v.pause(); if(music) music.pause();
      });
      const out = writeFile(call.out, data, "video/webm");
      return `${out} (${w}×${h}, ${total.toFixed(1)}초${mix && mix.used ? ", 소리 포함" : ", 무음"})` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
    }finally{ v._revoke(); if(music) music._revoke(); if(mix) mix.close(); }
  }

  // 이미지·영상 클립을 이어 붙여 영상 만들기: 장면 전환(fade)·켄 번스 효과·텍스트/이미지 레이어·배경음
  async function createVideo(call){
    const paths = Array.isArray(call.paths) ? call.paths : [];
    if(!paths.length || paths.length > 30) throw new Error("이미지·영상 1~30개가 필요해요 (paths)");
    if(!call.out || !/\.webm$/i.test(call.out)) throw new Error("WebM 출력 경로(out)가 필요해요");
    recorderSupport();
    const layers = validateLayers(opt(call, "layers"));
    const per = Number(opt(call, "seconds_per_image") || 2);
    const durs = Array.isArray(call.durations) ? call.durations.map(Number) : [];
    if(!Number.isFinite(per) || per < 0.2) throw new Error("seconds_per_image 는 0.2초 이상이어야 해요");
    const w = Number(call.width || 720), h = Number(call.height || 720);
    if(!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 1920 || h > 1080) throw new Error("올바른 크기가 필요해요 (최대 1920×1080)");
    const notes = [], clips = [];
    let mix = null, music = null;
    const wantAudio = !!(opt(call, "keep_audio") || opt(call, "music") || typeof call.audio === "string");
    if(wantAudio){ mix = makeAudioMix(); if(!mix) notes.push("오디오 합성을 지원하지 않아 무음으로 만들었어요"); }
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
          clips.push({ kind:"image", el: img, d: Number.isFinite(durs[i]) && durs[i] > 0 ? durs[i] : per, sw: img.naturalWidth, sh: img.naturalHeight });
        }else throw new Error("이미지나 동영상이 아니에요: " + p);
      }
      const total = clips.reduce((s, c) => s + c.d, 0);
      if(total > MAX_MEDIA_SEC) throw new Error(`결과 영상은 최대 ${MAX_MEDIA_SEC}초예요 (현재 ${total.toFixed(1)}초)`);
      const musicPath = opt(call, "music") || (typeof call.audio === "string" ? call.audio : null);
      if(mix && musicPath){ music = await loadMediaEl(musicPath, "audio"); music.loop = true; if(!mix.add(music, opt(call, "music_volume", "audio_volume"))) notes.push("배경음을 넣지 못했어요"); }
      const imgs = await preloadLayerImages(layers);
      const trans = String(opt(call, "transition") || "none").toLowerCase();
      const td = trans === "fade" ? Math.max(0.1, Math.min(2, Number(opt(call, "transition_seconds") || 0.5))) : 0;
      const kb = opt(call, "ken_burns", "zoom"), fit = String(call.fit || "contain"), bg = String(opt(call, "background") || "#000");
      const filter = cssFilter(opt(call, "filters", "filter"));
      const fin = Number(opt(call, "fade_in") || 0), fout = Number(opt(call, "fade_out") || 0);
      const fps = Math.max(10, Math.min(60, Number(opt(call, "fps") || 30)));
      const canvas = newCanvas(w, h), ctx = canvas.getContext("2d");
      const starts = []; clips.reduce((s, c, i) => (starts[i] = s, s + c.d), 0);
      const drawClip = (c, i, t, alpha) => {
        if(alpha <= 0) return;
        const local = t - starts[i], p = Math.max(0, Math.min(1, local / c.d));
        const zoom = kb && c.kind === "image" ? 1 + 0.12 * (i % 2 ? 1 - p : p) : 1;
        const pan = kb && c.kind === "image" ? [(i % 3 - 1) * 0.03 * w * p, 0] : null;
        ctx.save(); ctx.globalAlpha = alpha;
        drawSource(ctx, c.el, c.sw, c.sh, w, h, { fit, zoom, pan, filter });
        ctx.restore();
      };
      const data = await record(canvas, fps, mix, async () => {
        if(music){ music.currentTime = 0; music.play().catch(() => notes.push("배경음 재생 실패")); }
        let cur = -1;
        const began = performance.now();
        await new Promise((resolve, reject) => {
          const frame = async now => {
            try{
              const t = (now - began) / 1000;
              if(t >= total){ resolve(); return; }
              let i = clips.length - 1; while(i > 0 && t < starts[i]) i--;
              const c = clips[i];
              if(i !== cur){
                if(cur >= 0 && clips[cur].kind === "video") clips[cur].el.pause();
                cur = i;
                if(c.kind === "video"){ await seekTo(c.el, 0); await c.el.play().catch(() => {}); }
              }
              ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
              drawClip(c, i, t, 1);
              // 다음 장면이 겹쳐 나타나는 페이드 전환
              if(td && i + 1 < clips.length && t > starts[i + 1] - td && clips[i + 1].kind === "image") drawClip(clips[i + 1], i + 1, t, (t - (starts[i + 1] - td)) / td);
              if(layers.length) drawLayers(ctx, w, h, layers, imgs, t);
              fadeOverlay(ctx, w, h, t, total, fin, fout);
              nextFrame(frame);
            }catch(e){ reject(e); }
          };
          nextFrame(frame);
        });
        clips.forEach(c => { if(c.kind === "video") c.el.pause(); });
        if(music) music.pause();
      });
      const out = writeFile(call.out, data, "video/webm");
      return `${out} (${w}×${h}, ${total.toFixed(1)}초, 장면 ${clips.length}개${mix && mix.used ? ", 소리 포함" : ", 무음"})` + (notes.length ? "\n참고: " + notes.join(" / ") : "");
    }finally{
      clips.forEach(c => { if(c.kind === "video" && c.el._revoke) c.el._revoke(); });
      if(music) music._revoke(); if(mix) mix.close();
    }
  }

  // 이미지·영상·오디오 정보 (크기·길이) — 레이어 위치를 정하기 전에 확인용
  async function mediaInfo(call){
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

  Object.assign(api, { editImage, editVideo, createVideo, mediaInfo });

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
    isFsTool(name){ return SHELL_TOOLS.has(name) || FS_TOOLS.has(name) || CODE_ONLY_TOOLS.has(name) || (["convert_image","edit_image","edit_video","create_video","media_info","pkg_install","pkg_list"].includes(name)); },
    run: (call, mode) => global.LinuxFS.asAI(() => runToolCall(call, mode))
  };

})(window);
