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
  const MAX_FILE_BYTES = 512 * 1024;       // 파일 1개당 상한 (텍스트/작은 이미지 기준)

  const DEFAULT_DIRS = [
    "/", "/cmds", "/package", "/tmp",
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
      if(e.type === "file") n += (e.size || 0);
    }
    return n;
  }

  function persist(){
    try{
      const root = JSON.parse(localStorage.getItem(ROOT_KEY) || "{}");
      root.AI_Service = root.AI_Service || {};
      root.AI_Service.Linux_Local = state;
      localStorage.setItem(ROOT_KEY, JSON.stringify(root));
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
      } else {
        state = blankState();
        persist();
      }
    }catch(e){
      state = blankState();
    }
  }
  load();

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
    try{ return new Blob([content]).size; }catch(e){ return (content||"").length; }
  }

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
    if(exists(p)) throw new Error(`이미 존재함: ${p}`);
    ensureParentDirs(p);
    state.fs[p] = { type:"dir", createdAt: nowTs() };
    persist();
    return p;
  }

  function touch(path){
    const p = normPath(joinPath(state.cwd, path));
    if(exists(p)) { state.fs[p].updatedAt = nowTs(); persist(); return p; }
    ensureParentDirs(p);
    state.fs[p] = { type:"file", content:"", mime:"text/plain", size:0, createdAt: nowTs(), updatedAt: nowTs() };
    persist();
    return p;
  }

  function writeFile(path, content, mime){
    const p = normPath(joinPath(state.cwd, path));
    const size = byteSize(content);
    if(size > MAX_FILE_BYTES) throw new Error(`파일이 너무 큼(가상 환경 상한 ${Math.round(MAX_FILE_BYTES/1024)}KB): ${p}`);
    if(!exists(p) && totalBytes() + size > MAX_TOTAL_BYTES) throw new Error("Linux_Local 저장공간이 가득 참");
    ensureParentDirs(p);
    const prevSize = exists(p) && state.fs[p].type==="file" ? (state.fs[p].size||0) : 0;
    if(totalBytes() - prevSize + size > MAX_TOTAL_BYTES) throw new Error("Linux_Local 저장공간이 가득 참");
    state.fs[p] = {
      type:"file", content: content, mime: mime || (state.fs[p]&&state.fs[p].mime) || "text/plain",
      size, createdAt: (exists(p) ? state.fs[p].createdAt : nowTs()), updatedAt: nowTs()
    };
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
    if(isDir(p)){
      const kids = childrenOf(p);
      if(kids.length && !recursive) throw new Error(`비어있지 않은 디렉터리(recursive 필요): ${p}`);
      const prefix = p + "/";
      Object.keys(state.fs).filter(k => k===p || k.startsWith(prefix)).forEach(k => delete state.fs[k]);
    } else {
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
    if(isFile(src)){
      state.fs[dst] = Object.assign({}, state.fs[src], { updatedAt: nowTs() });
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
    if(isFile(src)){
      writeFile(dst, state.fs[src].content, state.fs[src].mime);
    } else {
      const prefix = src + "/";
      const copies = Object.keys(state.fs).filter(k => k===src || k.startsWith(prefix));
      copies.forEach(k => {
        const rel = k.slice(src.length);
        const nk = dst + rel;
        state.fs[nk] = JSON.parse(JSON.stringify(state.fs[k]));
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
    const content = file.isImg ? file.dataUrl : (file.text != null ? file.text : "");
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
    Object.assign(state.fs[k], meta); persist(); return k;
  }
  function mkdirp(p){
    const k = abs(p);
    if(isFile(k)) throw new Error(`파일이 이미 존재함: ${k}`);
    if(isDir(k)) return k;
    ensureParentDirs(k);
    state.fs[k] = { type:"dir", createdAt: nowTs() };
    persist(); return k;
  }
  // 변경 감지용 스냅샷 (에이전트 한 단계 전/후 비교 → "파일 생성됨/편집됨" 표시)
  function snapshot(){
    const o = {};
    for(const k in state.fs){ const e = state.fs[k]; if(e.type === "file" && !k.startsWith("/cmds/") && !k.startsWith("/package/")) o[k] = (e.updatedAt || 0) + ":" + (e.size || 0) + ":" + (e.content && e.content.length || 0); }
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

  global.LinuxFS = {
    ls, pwd, cd, mkdir, touch, writeFile, readFile, rm, mv, cp, find, grep, head, tail,
    pkgInstall, pkgList, pkgIsInstalled,
    convertImage, saveUploaded, usageSummary, resetAll, availableCmds,
    normPath, joinPath, abs, stat, setMeta, mkdirp, dirChildren, seedFiles, snapshot, diffSnapshot, exists, isDir, isFile, baseName, parentOf,
    get cwd(){ return state.cwd; }
  };

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
      case "convert_image": {
        const out = await convertImage(call.path, call.format);
        return "변환 완료: " + out;
      }
      default:
        throw new Error(`알 수 없는 도구: ${tool} (fs_ls, fs_read, fs_write, fs_mkdir, fs_rm, fs_mv, fs_cp, fs_find, fs_grep, fs_head, fs_tail, pkg_install, pkg_list, convert_image 중에서만 사용 가능)`);
    }
  }

  global.ChoiminiToolRunner = {
    isFsTool(name){ return SHELL_TOOLS.has(name) || FS_TOOLS.has(name) || CODE_ONLY_TOOLS.has(name) || name === "convert_image"; },
    run: runToolCall
  };

})(window);
