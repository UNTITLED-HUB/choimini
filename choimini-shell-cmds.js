/* ============================================================================
   choimini-shell-cmds.js  —  WORK / CODE 셸 명령어 구현
   ----------------------------------------------------------------------------
   choimini-shell.js 의 레지스트리에 명령어를 등록한다. 모두 브라우저 안 가상 Linux_Local 위에서만
   동작하며 실제 OS 는 건드리지 않는다.
   ⚠ 정직한 한계: 이건 "진짜 리눅스"가 아니라 JS 로 구현한 호환 명령어들이다.
     - 셸 제어문(if/for/while/함수)은 지원하지 않는다. (&&, ||, ;, |, 리다이렉션, $(...) 는 지원)
     - python 은 Pyodide(WebAssembly), node 는 격리된 iframe 안 JS 로 실행된다 (모듈/패키지 제약 있음).
     - 새 명령어는 /cmds/<이름> 에 스크립트(또는 {"alias":"..."} JSON)를 만들면 즉시 인식된다.
   ============================================================================ */
(function(global){
  "use strict";
  const S = global.ChoiminiShell, FS = global.LinuxFS;
  if(!S || !FS) return;
  const def = S.def;
  const enc = new TextEncoder();

  /* ======================= 공통 헬퍼 ======================= */
  function E(io, name, msg){ io.err += `${name}: ${msg}\n`; return 1; }
  const NOFILE = "No such file or directory";

  function opts(args, valFlags, longVal){
    valFlags = valFlags || ""; longVal = longVal || [];
    const f = {}, v = {}, rest = []; let done = false;
    for(let i = 0; i < args.length; i++){
      const a = args[i];
      if(done || a === "-" || a[0] !== "-" || a.length === 1){ rest.push(a); continue; }
      if(a === "--"){ done = true; continue; }
      if(a.startsWith("--")){
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        const put = (k, val) => { if(k in v){ v[k] = [].concat(v[k], val); } else v[k] = val; };
        if(m[2] != null) put(m[1], m[2]); else if(longVal.includes(m[1])) put(m[1], args[++i]); else f[m[1]] = true;
        continue;
      }
      if(/^-\d+$/.test(a)){ v.num = +a.slice(1); continue; }
      for(let j = 1; j < a.length; j++){
        const c = a[j];
        if(valFlags.includes(c)){ const r = a.slice(j + 1), val = r !== "" ? r : args[++i]; v[c] = c in v ? [].concat(v[c], val) : val; break; }
        f[c] = true;
      }
    }
    return { f, v, rest };
  }

  function isBinContent(c){ return typeof c === "string" && /^data:[^,]*;base64,/.test(c) && !/^data:text\//.test(c); }
  function statOf(p){ try{ return FS.stat(p); }catch(e){ return null; } }
  function getText(io, name, p){
    const st = statOf(p);
    if(!st){ E(io, name, `${p}: ${NOFILE}`); return null; }
    if(st.type === "dir"){ E(io, name, `${p}: Is a directory`); return null; }
    return String(st.content == null ? "" : st.content);
  }
  function b64ToBytes(b64){ const bin = atob(b64); const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function bytesToB64(u){ let s = ""; for(let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function getBytes(p){
    const st = statOf(p);
    if(!st || st.type !== "file") throw new Error(`${p}: ${NOFILE}`);
    const c = String(st.content == null ? "" : st.content);
    const m = /^data:[^,]*;base64,(.*)$/s.exec(c);
    return m ? b64ToBytes(m[1]) : enc.encode(c);
  }
  function putBytes(p, u8, mime){
    let text = null;
    try{ const t = new TextDecoder("utf-8", { fatal:true }).decode(u8); if(t.indexOf("\u0000") < 0) text = t; }catch(e){}
    if(text != null) return FS.writeFile(p, text, mime && /^text|json|xml|javascript/.test(mime) ? mime : "text/plain");
    const m = mime || "application/octet-stream";
    return FS.writeFile(p, `data:${m};base64,${bytesToB64(u8)}`, m);
  }
  async function streamBytes(u8, Kind, mode){
    if(typeof global[Kind] !== "function") throw new Error("이 브라우저는 gzip 을 지원하지 않음 (" + Kind + ")");
    const cs = new global[Kind](mode);
    const w = cs.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  const gzip = u => streamBytes(u, "CompressionStream", "gzip");
  const gunzip = u => streamBytes(u, "DecompressionStream", "gzip");
  const lines = s => { const a = String(s).split("\n"); if(a.length && a[a.length - 1] === "") a.pop(); return a; };
  const nl = a => a.length ? a.join("\n") + "\n" : "";
  const joinP = (a, b) => (a === "/" ? "" : a) + "/" + b;
  function walk(p){ // p 아래 모든 경로(자기 자신 포함), 상대 정렬
    try{ return FS.find(p); }catch(e){ return []; }
  }
  function need(io, name, args, n){ if(args.length < n){ io.err += `${name}: missing operand\n`; return false; } return true; }
  function toRe(pat, o){
    let s = pat;
    if(!o.E){ // BRE → JS
      s = s.replace(/\\([(){}|+?])/g, "\u0001$1").replace(/[(){}|+?]/g, "\\$&").replace(/\u0001([(){}|+?])/g, "$1");
    }
    if(o.F) s = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if(o.w) s = "\\b(?:" + s + ")\\b";
    if(o.x) s = "^(?:" + s + ")$";
    return new RegExp(s, o.i ? "i" : "");
  }

  /* ======================= 파일/디렉터리 ======================= */
  def("pwd", "현재 디렉터리 출력", (a, io) => { io.out += FS.pwd() + "\n"; });
  def("cd", "디렉터리 이동", (a, io) => { try{ FS.cd(a[0] === "-" ? "/user" : (a[0] || "/user")); }catch(e){ return E(io, "cd", `${a[0]}: ${NOFILE}`); } });

  function fmtTime(ts){ const d = new Date(ts || Date.now()); const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]; return `${m} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
  function human(n){ if(n < 1024) return String(n); const u = ["K","M","G"]; let i = -1; do{ n /= 1024; i++; }while(n >= 1024 && i < 2); return n.toFixed(n < 10 ? 1 : 0) + u[i]; }
  function lsOne(io, p, o, showName){
    const st = statOf(p);
    if(!st){ io.err += `ls: cannot access '${p}': ${NOFILE}\n`; return 2; }
    const fmt = (s, name) => {
      const label = name + (o.F && s.type === "dir" ? "/" : "");
      if(!o.l) return label;
      const mode = s.mode || (s.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--");
      const size = s.type === "dir" ? 4096 : (s.size || 0);
      return `${mode} 1 user user ${String(o.h ? human(size) : size).padStart(6)} ${fmtTime(s.updatedAt || s.createdAt)} ${label}`;
    };
    if(st.type === "file"){ io.out += fmt(st, p) + "\n"; return 0; }
    if(showName) io.out += p + ":\n";
    let names = FS.dirChildren(p);
    if(!o.a) names = names.filter(n => !n.startsWith("."));
    const rows = names.map(n => fmt(statOf(joinP(st.path, n)), n));
    io.out += rows.join("\n") + (rows.length ? "\n" : "");
    if(o.R){ names.forEach(n => { const c = joinP(st.path, n); const cs = statOf(c); if(cs && cs.type === "dir"){ io.out += "\n"; lsOne(io, c, o, true); } }); }
    return 0;
  }
  def("ls", "디렉터리 목록 (-l -a -R -h -F)", (a, io) => {
    const { f, rest } = opts(a); const targets = rest.length ? rest : ["."]; let code = 0;
    targets.forEach((t, i) => { if(i && FS.isDir(t)) io.out += "\n"; code = Math.max(code, lsOne(io, t, f, targets.length > 1 || !!f.R)); });
    return code;
  });

  def("cat", "파일 내용 출력 (-n)", (a, io) => {
    const { f, rest } = opts(a); let code = 0, txt = "";
    if(!rest.length) txt = io.stdin;
    for(const p of rest){
      if(p === "-"){ txt += io.stdin; continue; }
      const st = statOf(p);
      if(st && st.type === "file" && isBinContent(st.content)){ txt += `(binary file: ${p}, ${st.size || 0} bytes)\n`; continue; }
      const t = getText(io, "cat", p); if(t == null){ code = 1; continue; } txt += t;
    }
    if(f.n){ let i = 0; txt = lines(txt).map(l => String(++i).padStart(6) + "\t" + l).join("\n") + "\n"; }
    io.out += txt; return code;
  });
  const tac = (a, io) => { const t = a.length ? getText(io, "tac", a[0]) : io.stdin; if(t == null) return 1; io.out += nl(lines(t).reverse()); };
  def("tac", "줄 순서 뒤집기", tac);
  def("rev", "각 줄 문자 뒤집기", (a, io) => { const t = a.length ? getText(io, "rev", a[0]) : io.stdin; if(t == null) return 1; io.out += nl(lines(t).map(l => Array.from(l).reverse().join(""))); });
  def("nl", "줄 번호 붙이기", (a, io) => { const t = a.length ? getText(io, "nl", a[0]) : io.stdin; if(t == null) return 1; let i = 0; io.out += nl(lines(t).map(l => String(++i).padStart(6) + "\t" + l)); });

  function headTail(name, isHead){
    def(name, isHead ? "앞부분 출력 (-n N / -N)" : "뒷부분 출력 (-n N / -N)", (a, io) => {
      const { v, rest } = opts(a, "nc"); const n = v.n != null ? parseInt(v.n, 10) : (v.num != null ? v.num : 10); let code = 0;
      const targets = rest.length ? rest : [null];
      targets.forEach((p, idx) => {
        const t = p == null ? io.stdin : getText(io, name, p); if(t == null){ code = 1; return; }
        if(targets.length > 1) io.out += (idx ? "\n" : "") + `==> ${p} <==\n`;
        if(v.c != null){ io.out += isHead ? t.slice(0, +v.c) : t.slice(-(+v.c)); return; }
        const l = lines(t); io.out += nl(isHead ? l.slice(0, n) : l.slice(Math.max(0, l.length - n)));
      });
      return code;
    });
  }
  headTail("head", true); headTail("tail", false);

  def("touch", "빈 파일 생성/시간 갱신", (a, io) => { let c = 0; a.filter(x => x[0] !== "-").forEach(p => { try{ FS.touch(p); }catch(e){ c = E(io, "touch", e.message); } }); return c; });
  def("mkdir", "디렉터리 생성 (-p)", (a, io) => {
    const { f, rest } = opts(a); if(!need(io, "mkdir", rest, 1)) return 1; let c = 0;
    rest.forEach(p => { try{ if(f.p) FS.mkdirp(p); else FS.mkdir(p); }catch(e){ c = E(io, "mkdir", `cannot create directory '${p}': ${/이미/.test(e.message) ? "File exists" : e.message}`); } }); return c;
  });
  def("rmdir", "빈 디렉터리 삭제", (a, io) => {
    let c = 0; a.filter(x => x[0] !== "-").forEach(p => {
      if(!FS.isDir(p)) { c = E(io, "rmdir", `failed to remove '${p}': ${NOFILE}`); return; }
      if(FS.dirChildren(p).length){ c = E(io, "rmdir", `failed to remove '${p}': Directory not empty`); return; }
      try{ FS.rm(p, false); }catch(e){ c = E(io, "rmdir", e.message); } }); return c;
  });
  def("rm", "삭제 (-r -f)", (a, io) => {
    const { f, rest } = opts(a); if(!rest.length && !f.f) return E(io, "rm", "missing operand"); let c = 0;
    rest.forEach(p => {
      const st = statOf(p);
      if(!st){ if(!f.f) c = E(io, "rm", `cannot remove '${p}': ${NOFILE}`); return; }
      if(st.type === "dir" && !(f.r || f.R || f.recursive)){ c = E(io, "rm", `cannot remove '${p}': Is a directory`); return; }
      try{ FS.rm(p, true); }catch(e){ if(!f.f) c = E(io, "rm", e.message); } });
    return c;
  });
  def(["cp"], "복사 (-r)", (a, io) => {
    const { f, rest } = opts(a); if(rest.length < 2) return E(io, "cp", "missing destination file operand"); const dst = rest[rest.length - 1]; let c = 0;
    rest.slice(0, -1).forEach(s => { const st = statOf(s); if(!st){ c = E(io, "cp", `cannot stat '${s}': ${NOFILE}`); return; }
      if(st.type === "dir" && !(f.r || f.R || f.a)){ c = E(io, "cp", `-r not specified; omitting directory '${s}'`); return; }
      try{ FS.cp(s, dst); }catch(e){ c = E(io, "cp", e.message); } }); return c;
  });
  def("mv", "이동/이름 변경", (a, io) => {
    const { rest } = opts(a); if(rest.length < 2) return E(io, "mv", "missing destination file operand"); const dst = rest[rest.length - 1]; let c = 0;
    rest.slice(0, -1).forEach(s => { try{ FS.mv(s, dst); }catch(e){ c = E(io, "mv", `cannot move '${s}': ${e.message}`); } }); return c;
  });
  def("ln", "링크 (가상 FS 에서는 복사본 생성)", (a, io) => {
    const { rest } = opts(a); if(rest.length < 2) return E(io, "ln", "missing file operand");
    try{ FS.cp(rest[0], rest[1]); io.err += "ln: (가상 파일시스템이라 링크 대신 복사본을 만들었어요)\n"; }catch(e){ return E(io, "ln", e.message); }
  });
  def("chmod", "권한 표시 변경 (가상 FS 에서는 메타데이터만 기록)", (a, io) => {
    const { rest } = opts(a); if(rest.length < 2) return E(io, "chmod", "missing operand"); const m = rest[0];
    let mode = null; if(/^[0-7]{3,4}$/.test(m)){ const d = m.slice(-3).split("").map(Number); mode = d.map(x => (x & 4 ? "r" : "-") + (x & 2 ? "w" : "-") + (x & 1 ? "x" : "-")).join(""); }
    let c = 0; rest.slice(1).forEach(p => { try{ const st = statOf(p); if(!st) throw new Error(`cannot access '${p}': ${NOFILE}`);
      let md = mode; if(md == null){ const cur = (st.mode || (st.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--")).slice(1); md = cur; if(/x/.test(m) && /\+/.test(m)) md = md.replace(/^(.)(.)(.)(.)(.)(.)(.)(.)(.)$/, "$1$2x$4$5x$7$8x"); if(/-x/.test(m)) md = md.replace(/x/g, "-"); }
      FS.setMeta(p, { mode: (st.type === "dir" ? "d" : "-") + md }); }catch(e){ c = E(io, "chmod", e.message); } }); return c;
  });

  def("find", "파일 검색 (-name -iname -type -maxdepth -mindepth -empty -print)", (a, io) => {
    let i = 0; const paths = []; while(i < a.length && a[i][0] !== "-" && a[i] !== "!" && a[i] !== "("){ paths.push(a[i++]); } if(!paths.length) paths.push(".");
    const c = { name:null, iname:null, type:null, maxd:Infinity, mind:0, empty:false, exec:null, neg:false };
    for(; i < a.length; i++){
      const x = a[i];
      if(x === "-name") c.name = a[++i]; else if(x === "-iname") c.iname = a[++i]; else if(x === "-type") c.type = a[++i];
      else if(x === "-maxdepth") c.maxd = +a[++i]; else if(x === "-mindepth") c.mind = +a[++i]; else if(x === "-empty") c.empty = true;
      else if(x === "-exec"){ const e = []; i++; while(i < a.length && a[i] !== ";" && a[i] !== "+") e.push(a[i++]); c.exec = e; }
      else if(x === "-print" || x === "-print0") {} else if(x === "-delete") c.del = true;
      else return E(io, "find", `지원하지 않는 옵션: ${x}`);
    }
    const nameRe = c.name ? globToRe2(c.name, false) : c.iname ? globToRe2(c.iname, true) : null;
    const hits = [];
    for(const root of paths){
      const st = statOf(root); if(!st){ io.err += `find: '${root}': ${NOFILE}\n`; continue; }
      const rootAbs = st.path;
      for(const p of walk(root)){
        const s = statOf(p); const rel = p === rootAbs ? "" : p.slice(rootAbs === "/" ? 1 : rootAbs.length + 1);
        const depth = rel ? rel.split("/").length : 0;
        if(depth > c.maxd || depth < c.mind) continue;
        if(c.type === "f" && s.type !== "file") continue; if(c.type === "d" && s.type !== "dir") continue;
        if(nameRe && !nameRe.test(s.name)) continue;
        if(c.empty && !(s.type === "file" ? !(s.size) : FS.dirChildren(p).length === 0)) continue;
        // 출력 경로는 사용자가 준 형태 유지
        const shown = root === "." ? (rel ? "./" + rel : ".") : (rel ? (root.endsWith("/") ? root : root + "/") + rel : root);
        hits.push({ shown, abs:p });
      }
    }
    return (async () => {
      if(c.del){ hits.sort((x, y) => y.abs.length - x.abs.length).forEach(h => { try{ FS.rm(h.abs, true); }catch(e){} }); return 0; }
      if(c.exec){ for(const h of hits){ const cmd = c.exec.map(t => t === "{}" ? S.quote(h.shown) : S.quote(t)).join(" "); const r = await S.runLine(cmd, 1, null); io.out += r.out; io.err += r.err; } return 0; }
      io.out += nl(hits.map(h => h.shown)); return hits.length || paths.length ? 0 : 1;
    })();
  });
  function globToRe2(g, ci){ return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", ci ? "i" : ""); }

  def("grep", "텍스트 검색 (-i -n -v -c -r -E -F -l -w -o -h -e -q)", (a, io) => {
    const { f, v, rest } = opts(a, "e"); const pats = []; if(v.e != null) pats.push(...[].concat(v.e));
    if(!pats.length){ if(!rest.length) return E(io, "grep", "pattern 필요"); pats.push(rest.shift()); }
    let re; try{ re = toRe(pats.length > 1 ? pats.join("|") : pats[0], { E:f.E || pats.length > 1, F:f.F, i:f.i, w:f.w, x:f.x }); }catch(e){ return E(io, "grep", "잘못된 정규식: " + e.message); }
    const rec = f.r || f.R; const files = [];
    if(!rest.length){ files.push(null); }
    else rest.forEach(p => { const st = statOf(p); if(!st){ io.err += `grep: ${p}: ${NOFILE}\n`; return; }
      if(st.type === "dir"){ if(!rec){ io.err += `grep: ${p}: Is a directory\n`; return; } walk(p).forEach(x => { if(statOf(x).type === "file") files.push(x); }); } else files.push(p); });
    let matched = false; const multi = files.length > 1 || rec;
    for(const p of files){
      let t = p == null ? io.stdin : String(statOf(p).content || ""); if(p != null && isBinContent(t)) continue;
      let cnt = 0; const ls_ = lines(t);
      ls_.forEach((l, idx) => {
        const hit = re.test(l) !== !!f.v; if(!hit) return; cnt++; matched = true;
        if(f.c || f.l || f.q) return;
        const pre = (multi && !f.h && p != null ? p + ":" : "") + (f.n ? (idx + 1) + ":" : "");
        if(f.o && !f.v){ const g = new RegExp(re.source, re.flags + "g"); let m; while((m = g.exec(l)) && m[0] !== ""){ io.out += pre + m[0] + "\n"; } } else io.out += pre + l + "\n";
      });
      if(f.c) io.out += (multi && !f.h && p != null ? p + ":" : "") + cnt + "\n"; if(f.l && cnt) io.out += p + "\n";
    }
    return matched ? 0 : 1;
  });

  /* ======================= 텍스트 처리 ======================= */
  def("echo", "문자열 출력 (-n -e)", (a, io) => {
    const { f, rest } = opts(a.length && /^-[neE]+$/.test(a[0]) ? a : ["--", ...a]); let s = rest.join(" ");
    if(f.e) s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    io.out += s + (f.n ? "" : "\n");
  });
  def("printf", "서식 출력", (a, io) => {
    if(!a.length) return E(io, "printf", "usage: printf format [arguments]"); const fmt = a[0]; let args = a.slice(1), ai = 0;
    const one = () => fmt.replace(/%([-0-9.]*)([sdfxXoc%])|\\([nt\\"'r])/g, (m, w, t, esc) => {
      if(esc) return { n:"\n", t:"\t", "\\":"\\", '"':'"', "'":"'", r:"\r" }[esc];
      if(t === "%") return "%"; const val = args[ai++]; const width = parseInt(w, 10) || 0; let s;
      if(t === "s") s = val == null ? "" : String(val); else if(t === "c") s = val == null ? "" : String(val)[0];
      else if(t === "d") s = String(parseInt(val, 10) || 0); else if(t === "f") s = (parseFloat(val) || 0).toFixed(/\.(\d+)/.test(w) ? +/\.(\d+)/.exec(w)[1] : 6);
      else if(t === "x") s = (parseInt(val, 10) || 0).toString(16); else if(t === "X") s = (parseInt(val, 10) || 0).toString(16).toUpperCase(); else s = (parseInt(val, 10) || 0).toString(8);
      return w.startsWith("-") ? s.padEnd(width) : (w.startsWith("0") && t !== "s" ? s.padStart(width, "0") : s.padStart(width));
    });
    let guard = 0; do{ io.out += one(); }while(ai < args.length && ++guard < 1000 && /%[-0-9.]*[sdfxXoc]/.test(fmt));
  });
  def("wc", "줄/단어/바이트 수 (-l -w -c -m)", (a, io) => {
    const { f, rest } = opts(a); const all = !f.l && !f.w && !f.c && !f.m; let tl = 0, tw = 0, tc = 0, code = 0;
    const one = (t, name) => { const l = (t.match(/\n/g) || []).length, w = (t.trim() ? t.trim().split(/\s+/).length : 0), c = enc.encode(t).length; tl += l; tw += w; tc += c;
      const cols = []; if(all || f.l) cols.push(l); if(all || f.w) cols.push(w); if(all || f.c) cols.push(c); if(f.m) cols.push(Array.from(t).length);
      io.out += cols.map(x => String(x).padStart(7)).join("") + (name ? " " + name : "") + "\n"; };
    if(!rest.length) one(io.stdin, ""); else rest.forEach(p => { const t = getText(io, "wc", p); if(t == null) code = 1; else one(t, p); });
    if(rest.length > 1){ const cols = []; if(all || f.l) cols.push(tl); if(all || f.w) cols.push(tw); if(all || f.c) cols.push(tc); io.out += cols.map(x => String(x).padStart(7)).join("") + " total\n"; }
    return code;
  });
  def("sort", "정렬 (-r -n -u -f -k -t)", (a, io) => {
    const { f, v, rest } = opts(a, "kto"); let t = ""; for(const p of (rest.length ? rest : [null])){ const x = p == null ? io.stdin : getText(io, "sort", p); if(x == null) return 1; t += x; }
    const sep = v.t != null ? v.t : null; const k = v.k ? parseInt(v.k, 10) - 1 : null;
    const key = l => { let s = l; if(k != null){ const parts = sep != null ? l.split(sep) : l.trim().split(/\s+/); s = parts[k] != null ? parts[k] : ""; } return f.f ? s.toLowerCase() : s; };
    let arr = lines(t).map(l => ({ l, k:key(l) }));
    arr.sort((x, y) => f.n ? ((parseFloat(x.k) || 0) - (parseFloat(y.k) || 0)) || (x.l < y.l ? -1 : x.l > y.l ? 1 : 0) : (x.k < y.k ? -1 : x.k > y.k ? 1 : (x.l < y.l ? -1 : x.l > y.l ? 1 : 0)));
    if(f.r) arr.reverse(); let out = arr.map(x => x.l); if(f.u) out = out.filter((l, i) => i === 0 || (f.n ? (parseFloat(arr[i].k) !== parseFloat(arr[i-1].k)) : (arr[i].k !== arr[i-1].k)));
    const text = nl(out); if(v.o){ FS.writeFile(v.o, text); } else io.out += text;
  });
  def("uniq", "인접 중복 제거 (-c -d -u -i)", (a, io) => {
    const { f, rest } = opts(a); const t = rest.length ? getText(io, "uniq", rest[0]) : io.stdin; if(t == null) return 1; const l = lines(t); const groups = [];
    l.forEach(x => { const g = groups[groups.length - 1]; const k = f.i ? x.toLowerCase() : x; if(g && g.k === k) g.n++; else groups.push({ k, l:x, n:1 }); });
    io.out += nl(groups.filter(g => f.d ? g.n > 1 : f.u ? g.n === 1 : true).map(g => f.c ? String(g.n).padStart(7) + " " + g.l : g.l));
  });
  def("cut", "필드/문자 자르기 (-d -f -c)", (a, io) => {
    const { v, f, rest } = opts(a, "dfc"); const t = rest.length ? getText(io, "cut", rest[0]) : io.stdin; if(t == null) return 1;
    const spec = v.f || v.c; if(!spec) return E(io, "cut", "you must specify a list of bytes, characters, or fields");
    const idx = new Set(); spec.split(",").forEach(r => { const m = /^(\d*)-(\d*)$/.exec(r); if(m){ const s = m[1] ? +m[1] : 1, e = m[2] ? +m[2] : 9999; for(let i = s; i <= e; i++) idx.add(i); } else idx.add(+r); });
    const d = v.d != null ? v.d : "\t";
    io.out += nl(lines(t).map(l => v.c ? Array.from(l).filter((_, i) => idx.has(i + 1)).join("") : (l.indexOf(d) < 0 ? l : l.split(d).filter((_, i) => idx.has(i + 1)).join(d))));
  });
  function expandSet(s){
    const cls = { "[:upper:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZ", "[:lower:]":"abcdefghijklmnopqrstuvwxyz", "[:digit:]":"0123456789", "[:space:]":" \t\n\r\f\v", "[:alpha:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "[:alnum:]":"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "[:punct:]":"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" };
    Object.keys(cls).forEach(k => { s = s.split(k).join(cls[k]); });
    s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t"); let out = "";
    for(let i = 0; i < s.length; i++){ if(s[i + 1] === "-" && i + 2 < s.length){ for(let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out += String.fromCharCode(c); i += 2; } else out += s[i]; }
    return out;
  }
  def("tr", "문자 치환/삭제 (-d -s)", (a, io) => {
    const { f, rest } = opts(a); if(!rest.length) return E(io, "tr", "missing operand"); const s1 = expandSet(rest[0]); let t = io.stdin;
    if(f.d) t = Array.from(t).filter(c => s1.indexOf(c) < 0).join("");
    else { const s2 = rest[1] != null ? expandSet(rest[1]) : ""; t = Array.from(t).map(c => { const i = s1.indexOf(c); return i < 0 ? c : (s2.length ? s2[Math.min(i, s2.length - 1)] : c); }).join(""); }
    if(f.s){ const set = expandSet(rest[f.d ? 0 : 1] != null ? rest[f.d ? 0 : 1] : rest[0]); t = t.replace(new RegExp("([" + set.replace(/[\]\\^-]/g, "\\$&") + "])\\1+", "g"), "$1"); }
    io.out += t;
  });
  def("tee", "표준입력을 파일에도 저장 (-a)", (a, io) => { const { f, rest } = opts(a); io.out += io.stdin; rest.forEach(p => { try{ let prev = ""; if(f.a && FS.isFile(p)) prev = String(FS.readFile(p)); FS.writeFile(p, prev + io.stdin); }catch(e){ E(io, "tee", e.message); } }); });

  def("diff", "파일 비교 (-u)", (a, io) => {
    const { rest } = opts(a); if(rest.length < 2) return E(io, "diff", "missing operand");
    const A = getText(io, "diff", rest[0]), B = getText(io, "diff", rest[1]); if(A == null || B == null) return 2;
    const x = lines(A), y = lines(B), n = x.length, m = y.length; const L = Array.from({ length:n + 1 }, () => new Int32Array(m + 1));
    for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i+1][j+1] + 1 : Math.max(L[i+1][j], L[i][j+1]);
    let i = 0, j = 0, out = []; while(i < n && j < m){ if(x[i] === y[j]){ i++; j++; } else if(L[i+1][j] >= L[i][j+1]) out.push(`< ${x[i++]}   (줄 ${i})`); else out.push(`> ${y[j++]}   (줄 ${j})`); }
    while(i < n) out.push(`< ${x[i++]}   (줄 ${i})`); while(j < m) out.push(`> ${y[j++]}   (줄 ${j})`);
    io.out += nl(out); return out.length ? 1 : 0;
  });
  def("cmp", "바이트 비교", (a, io) => {
    const { rest } = opts(a); if(rest.length < 2) return E(io, "cmp", "missing operand");
    let A, B; try{ A = getBytes(rest[0]); B = getBytes(rest[1]); }catch(e){ return E(io, "cmp", e.message); }
    const len = Math.min(A.length, B.length); for(let i = 0; i < len; i++) if(A[i] !== B[i]){ io.out += `${rest[0]} ${rest[1]} differ: byte ${i + 1}\n`; return 1; }
    if(A.length !== B.length){ io.out += `cmp: EOF on ${A.length < B.length ? rest[0] : rest[1]}\n`; return 1; }
  });

  /* ---- sed (부분 구현) : s///[gi], d, p, y///, 주소(N, $, /re/, N,M), -n -i -E -e ---- */
  function parseSed(script, ere){
    const cmds = []; let i = 0; const s = script;
    const reOf = src => toRe(src, { E:ere });
    const readDelim = d => { let out = ""; while(i < s.length && s[i] !== d){ if(s[i] === "\\" && s[i+1] === d){ out += d; i += 2; continue; } if(s[i] === "\\"){ out += s[i] + s[i+1]; i += 2; continue; } out += s[i++]; } i++; return out; };
    while(i < s.length){
      while(i < s.length && /[\s;]/.test(s[i])) i++; if(i >= s.length) break;
      const c = { a1:null, a2:null, neg:false };
      const addr = () => { if(s[i] === "$"){ i++; return { last:true }; } if(/\d/.test(s[i])){ let n = ""; while(/\d/.test(s[i] || "")) n += s[i++]; return { n:+n }; } if(s[i] === "/"){ i++; return { re: reOf(readDelim("/")) }; } return null; };
      c.a1 = addr(); if(c.a1 && s[i] === ","){ i++; c.a2 = addr(); }
      while(s[i] === " ") i++; if(s[i] === "!"){ c.neg = true; i++; }
      const op = s[i++];
      if(op === "s"){ const d = s[i++]; const pat = readDelim(d); let rep = readDelim(d); let fl = ""; while(/[gipI\d]/.test(s[i] || "")) fl += s[i++];
        c.op = "s"; c.re = new RegExp(toRe(pat, { E:ere, i:/[iI]/.test(fl) }).source, (fl.includes("g") ? "g" : "") + (/[iI]/.test(fl) ? "i" : "")); c.rep = rep; c.p = fl.includes("p"); }
      else if(op === "y"){ const d = s[i++]; const a1 = readDelim(d), a2 = readDelim(d); c.op = "y"; c.from = a1; c.to = a2; }
      else if(op === "d" || op === "p" || op === "q"){ c.op = op; }
      else throw new Error(`지원하지 않는 sed 명령: ${op}`);
      cmds.push(c);
    }
    return cmds;
  }
  function sedApply(text, cmds, quiet){
    const ls_ = lines(text), out = []; const active = cmds.map(() => false);
    ls_.forEach((line, idx) => {
      const ln = idx + 1, last = idx === ls_.length - 1; let cur = line, del = false, printed = false;
      const m1 = a => a.last ? last : a.n != null ? ln === a.n : a.re.test(cur);
      for(let k = 0; k < cmds.length && !del; k++){
        const c = cmds[k]; let hit = true;
        if(c.a1 && !c.a2) hit = m1(c.a1);
        else if(c.a1 && c.a2){ if(!active[k]){ if(m1(c.a1)){ active[k] = true; hit = true; if(c.a2.n != null && ln >= c.a2.n) active[k] = false; } else hit = false; } else { hit = true; if(m1(c.a2)) active[k] = false; } }
        if(c.neg) hit = !hit; if(!hit) continue;
        if(c.op === "s"){ const before = cur; cur = cur.replace(c.re, (...m) => { const groups = m.slice(0, -2); return c.rep.replace(/\\(\d)|&|\\n|\\&/g, t => t === "&" ? groups[0] : t === "\\n" ? "\n" : t === "\\&" ? "&" : (groups[+t[1]] || "")); }); if(c.p && cur !== before){ out.push(cur); printed = true; } }
        else if(c.op === "y"){ cur = Array.from(cur).map(ch => { const i = c.from.indexOf(ch); return i < 0 ? ch : (c.to[i] != null ? c.to[i] : ch); }).join(""); }
        else if(c.op === "d") del = true; else if(c.op === "p"){ out.push(cur); printed = true; }
      }
      if(!del && !quiet) out.push(cur);
    });
    return nl(out);
  }
  def("sed", "스트림 편집 (s///gi, d, p, y, 주소, -n -i -E -e)", (a, io) => {
    const { f, v, rest } = opts(a, "e"); let script = v.e; const files = rest.slice(); if(script == null){ if(!files.length) return E(io, "sed", "no script specified"); script = files.shift(); }
    let cmds; try{ cmds = parseSed(script, f.E || f.r); }catch(e){ return E(io, "sed", e.message); }
    if(!files.length){ io.out += sedApply(io.stdin, cmds, f.n); return 0; }
    let code = 0; files.forEach(p => { const t = getText(io, "sed", p); if(t == null){ code = 1; return; } const r = sedApply(t, cmds, f.n); if(f.i){ try{ FS.writeFile(p, r); }catch(e){ code = E(io, "sed", e.message); } } else io.out += r; }); return code;
  });

  /* ---- awk (부분 구현) : 패턴 {동작}, BEGIN/END, $N NF NR, 변수, 산술, print/printf, -F ---- */
  function awkExpr(src, env){
    let i = 0; const s = src;
    const ws = () => { while(i < s.length && /\s/.test(s[i])) i++; };
    const primary = () => { ws(); const c = s[i];
      if(c === "("){ i++; const v = or(); ws(); i++; return v; }
      if(c === '"'){ i++; let o = ""; while(i < s.length && s[i] !== '"'){ if(s[i] === "\\"){ const n = s[++i]; o += n === "n" ? "\n" : n === "t" ? "\t" : n; i++; } else o += s[i++]; } i++; return o; }
      if(c === "$"){ i++; const idx = primary(); return env.field(Math.floor(+idx)); }
      if(c === "!"){ i++; return primary() ? 0 : 1; }
      if(c === "-"){ i++; return -toN(primary()); }
      const m = /^(\d+\.?\d*(?:[eE][-+]?\d+)?)/.exec(s.slice(i)); if(m){ i += m[0].length; return parseFloat(m[1]); }
      const id = /^[A-Za-z_]\w*/.exec(s.slice(i)); if(id){ i += id[0].length; const n = id[0]; ws();
        if(s[i] === "(" ){ i++; const args = []; ws(); while(i < s.length && s[i] !== ")"){ args.push(or()); ws(); if(s[i] === ",") i++; ws(); } i++; return awkFn(n, args, env); }
        return env.get(n); }
      throw new Error("awk 구문 오류: " + s.slice(i, i + 12)); };
    const toN = v => typeof v === "number" ? v : (parseFloat(v) || 0);
    const mul = () => { let l = primary(); for(;;){ ws(); const c = s[i]; if(c === "*" || c === "/" || c === "%"){ i++; const r = toN(primary()); l = c === "*" ? toN(l) * r : c === "/" ? toN(l) / r : toN(l) % r; } else return l; } };
    const add = () => { let l = mul(); for(;;){ ws(); const c = s[i]; if((c === "+" || c === "-") && s[i+1] !== c && s[i+1] !== "="){ i++; const r = toN(mul()); l = c === "+" ? toN(l) + r : toN(l) - r; } else return l; } };
    const cat = () => { let l = add(); for(;;){ ws(); const c = s[i]; if(c !== undefined && /["$(\w]/.test(c) && !/^(&&|\|\|)/.test(s.slice(i)) && !/^(in)\b/.test(s.slice(i)) && c !== ")"){ const r = add(); l = String(l) + String(r); } else return l; } };
    const cmp = () => { let l = cat(); ws(); const m = /^(==|!=|<=|>=|~|!~|<|>)/.exec(s.slice(i)); if(!m) return l; i += m[0].length; let r = m[0] === "~" || m[0] === "!~" ? regexOperand() : cat();
      if(m[0] === "~") return new RegExp(r).test(String(l)) ? 1 : 0; if(m[0] === "!~") return new RegExp(r).test(String(l)) ? 0 : 1;
      const num = !isNaN(parseFloat(l)) && !isNaN(parseFloat(r)) && typeof l !== "boolean"; const a1 = num ? toN(l) : String(l), b1 = num ? toN(r) : String(r);
      return (m[0] === "==" ? a1 === b1 : m[0] === "!=" ? a1 !== b1 : m[0] === "<" ? a1 < b1 : m[0] === ">" ? a1 > b1 : m[0] === "<=" ? a1 <= b1 : a1 >= b1) ? 1 : 0; };
    const regexOperand = () => { ws(); if(s[i] === "/"){ i++; let o = ""; while(i < s.length && s[i] !== "/"){ if(s[i] === "\\" && s[i+1] === "/"){ o += "/"; i += 2; } else o += s[i++]; } i++; return o; } return String(cat()); };
    const and = () => { let l = cmp(); for(;;){ ws(); if(s.slice(i, i + 2) === "&&"){ i += 2; const r = cmp(); l = (l && r) ? 1 : 0; } else return l; } };
    const or = () => { let l = and(); for(;;){ ws(); if(s.slice(i, i + 2) === "||"){ i += 2; const r = and(); l = (l || r) ? 1 : 0; } else return l; } };
    const v = or(); ws(); if(i < s.length) throw new Error("awk 구문 오류: " + s.slice(i, i + 12)); return v;
  }
  function awkFn(n, args, env){
    const S_ = x => String(x != null ? x : ""); const N_ = x => parseFloat(x) || 0;
    switch(n){ case "length": return S_(args.length ? args[0] : env.field(0)).length; case "toupper": return S_(args[0]).toUpperCase(); case "tolower": return S_(args[0]).toLowerCase();
      case "int": return Math.trunc(N_(args[0])); case "sqrt": return Math.sqrt(N_(args[0])); case "substr": { const st = Math.max(1, Math.floor(N_(args[1]))); return args.length > 2 ? S_(args[0]).substr(st - 1, Math.floor(N_(args[2]))) : S_(args[0]).substr(st - 1); }
      case "index": return S_(args[0]).indexOf(S_(args[1])) + 1; case "sprintf": return S_(args[0]); default: throw new Error("awk: 지원하지 않는 함수 " + n); }
  }
  function splitStmts(body){ const out = []; let cur = "", q = false, d = 0; for(let i = 0; i < body.length; i++){ const c = body[i]; if(c === '"' && body[i-1] !== "\\") q = !q; if(!q){ if(c === "(") d++; if(c === ")") d--; if((c === ";" || c === "\n") && d === 0){ if(cur.trim()) out.push(cur.trim()); cur = ""; continue; } } cur += c; } if(cur.trim()) out.push(cur.trim()); return out; }
  function splitArgs(str){ const out = []; let cur = "", q = false, d = 0; for(let i = 0; i < str.length; i++){ const c = str[i]; if(c === '"' && str[i-1] !== "\\") q = !q; if(!q){ if(c === "(") d++; if(c === ")") d--; if(c === "," && d === 0){ out.push(cur); cur = ""; continue; } } cur += c; } out.push(cur); return out.map(x => x.trim()).filter(x => x !== ""); }
  function parseAwk(prog){
    const rules = []; let i = 0; const s = prog;
    while(i < s.length){
      while(i < s.length && /[\s;]/.test(s[i])) i++; if(i >= s.length) break;
      let pat = ""; let kind = "main";
      if(s.startsWith("BEGIN", i) && /^BEGIN\s*\{/.test(s.slice(i))){ kind = "begin"; i = s.indexOf("{", i); }
      else if(s.startsWith("END", i) && /^END\s*\{/.test(s.slice(i))){ kind = "end"; i = s.indexOf("{", i); }
      else { let q = false, d = 0, st = i; while(i < s.length && !(s[i] === "{" && !q && d === 0)){ if(s[i] === '"' ) q = !q; if(s[i] === "/" && !q){ i++; while(i < s.length && s[i] !== "/"){ if(s[i] === "\\") i++; i++; } } i++; } pat = s.slice(st, i).trim(); if(i >= s.length){ rules.push({ kind, pat, body:"print" }); break; } }
      let d = 0, st = i; for(; i < s.length; i++){ if(s[i] === '"'){ i++; while(i < s.length && s[i] !== '"'){ if(s[i] === "\\") i++; i++; } continue; } if(s[i] === "{") d++; if(s[i] === "}"){ d--; if(d === 0){ i++; break; } } }
      rules.push({ kind, pat, body: s.slice(st + 1, i - 1) });
    }
    return rules;
  }
  function awkRun(prog, text, opt){
    const rules = parseAwk(prog); const vars = { FS: opt.FS != null ? opt.FS : " ", OFS:" ", NR:0, NF:0 }; let fields = [""], out = "";
    Object.assign(vars, opt.vars || {});
    const env = { field: n => n === 0 ? fields[0] : (fields[n] != null ? fields[n] : ""), get: n => n === "NF" ? fields.length - 1 : (vars[n] != null ? vars[n] : ""), };
    const setLine = line => { fields = [line]; const fs = vars.FS; const parts = fs === " " ? line.trim().split(/\s+/).filter(x => x !== "") : (fs.length === 1 ? line.split(fs) : line.split(new RegExp(fs))); if(fs === " " && !line.trim()) parts.length = 0; parts.forEach(p => fields.push(p)); };
    const fmt = (args) => { const f = String(awkExpr(args[0], env)); let k = 1; return f.replace(/%([-0-9.]*)([sdfxc%])|\\n|\\t/g, (m, w, t) => { if(m === "\\n") return "\n"; if(m === "\\t") return "\t"; if(t === "%") return "%"; const val = args[k] != null ? awkExpr(args[k++], env) : ""; const width = parseInt(w, 10) || 0; let r = t === "d" ? String(Math.trunc(parseFloat(val) || 0)) : t === "f" ? (parseFloat(val) || 0).toFixed(/\.(\d+)/.test(w) ? +/\.(\d+)/.exec(w)[1] : 6) : t === "x" ? (Math.trunc(+val) || 0).toString(16) : String(val); return w.startsWith("-") ? r.padEnd(width) : r.padStart(width); }); };
    const exec = body => splitStmts(body).forEach(st => {
      let m;
      if((m = /^printf\s+(.*)$/s.exec(st))){ out += fmt(splitArgs(m[1])); return; }
      if((m = /^print(?:\s+(.*))?$/s.exec(st))){ const parts = m[1] ? splitArgs(m[1]) : ["$0"]; out += parts.map(p => { const val = awkExpr(p, env); return typeof val === "number" && !Number.isInteger(val) ? String(+val.toFixed(6)) : String(val); }).join(vars.OFS) + "\n"; return; }
      if((m = /^(\w+)\s*(\+|-|\*|\/)?=\s*(.*)$/s.exec(st))){ const val = awkExpr(m[3], env); const cur = vars[m[1]] != null ? vars[m[1]] : 0; const nv = m[2] ? (m[2] === "+" ? +cur + +val : m[2] === "-" ? +cur - +val : m[2] === "*" ? +cur * +val : +cur / +val) : val; vars[m[1]] = nv; return; }
      if((m = /^(\w+)(\+\+|--)$/.exec(st))){ vars[m[1]] = (+vars[m[1]] || 0) + (m[2] === "++" ? 1 : -1); return; }
      if((m = /^(\w+)\[.*$/.exec(st))) throw new Error("awk: 배열은 지원하지 않아요 (sort | uniq -c 등을 조합해 보세요)");
      throw new Error("awk: 지원하지 않는 문장 → " + st);
    });
    const matches = pat => { if(!pat) return true; let m; if((m = /^\/(.*)\/$/s.exec(pat))) return new RegExp(m[1]).test(fields[0]); return !!awkExpr(pat, env); };
    rules.filter(r => r.kind === "begin").forEach(r => exec(r.body));
    lines(text).forEach(l => { vars.NR++; setLine(l); rules.filter(r => r.kind === "main").forEach(r => { if(matches(r.pat)) exec(r.body); }); });
    rules.filter(r => r.kind === "end").forEach(r => exec(r.body));
    return out;
  }
  def("awk", "패턴 처리 (부분 구현: print/printf, $N, NF, NR, BEGIN/END, 산술, -F, -v)", (a, io) => {
    const { v, rest } = opts(a, "Fv"); if(!rest.length) return E(io, "awk", "프로그램 필요"); const prog = rest.shift(); const vars = {}; if(v.v){ const m = /^(\w+)=(.*)$/.exec(v.v); if(m) vars[m[1]] = m[2]; }
    try{ if(!rest.length) io.out += awkRun(prog, io.stdin, { FS:v.F, vars }); else rest.forEach(p => { const t = getText(io, "awk", p); if(t != null) io.out += awkRun(prog, t, { FS:v.F, vars }); }); }catch(e){ return E(io, "awk", e.message); }
  });
  def(["xargs"], "표준입력을 인자로 명령 실행 (-n -I)", async (a, io, ctx) => {
    const { v, rest } = opts(a, "nI"); const cmd = rest.length ? rest : ["echo"]; const items = io.stdin.split(/\s+/).filter(Boolean); if(!items.length && !v.I){ return 0; }
    const runs = [];
    if(v.I){ lines(io.stdin).forEach(l => runs.push(cmd.map(t => t.split(v.I).join(l)))); }
    else { const n = v.n ? +v.n : items.length; for(let i = 0; i < items.length; i += n) runs.push(cmd.concat(items.slice(i, i + n))); }
    for(const r of runs){ const res = await S.runLine(r.map(S.quote).join(" "), (ctx.depth || 0) + 1, null); io.out += res.out; io.err += res.err; }
  });
  def("basename", "경로의 파일명", (a, io) => { let b = (a[0] || "").replace(/\/+$/, "").split("/").pop(); if(a[1] && b.endsWith(a[1])) b = b.slice(0, -a[1].length); io.out += b + "\n"; });
  def("dirname", "경로의 디렉터리", (a, io) => { const p = (a[0] || "").replace(/\/+$/, ""); const i = p.lastIndexOf("/"); io.out += (i < 0 ? "." : i === 0 ? "/" : p.slice(0, i)) + "\n"; });
  def(["realpath", "readlink"], "절대 경로", (a, io) => { const { rest } = opts(a); rest.forEach(p => { io.out += FS.abs(p) + "\n"; }); });
  def("seq", "숫자 나열", (a, io) => { const n = a.map(Number); let s = 1, st = 1, e; if(n.length === 1) e = n[0]; else if(n.length === 2){ s = n[0]; e = n[1]; } else { s = n[0]; st = n[1]; e = n[2]; } const o = []; for(let x = s; st > 0 ? x <= e : x >= e; x += st){ o.push(x); if(o.length > 100000) break; } io.out += nl(o); });
  def("yes", "문자열 반복 (최대 100줄)", (a, io) => { io.out += nl(Array(100).fill(a.join(" ") || "y")); });

  /* ======================= 파일 정보 ======================= */
  function mimeGuess(name, content){ const e = (name.split(".").pop() || "").toLowerCase(); const m = { png:"PNG image", jpg:"JPEG image", jpeg:"JPEG image", gif:"GIF image", webp:"WebP image", svg:"SVG image", pdf:"PDF document", zip:"Zip archive", gz:"gzip compressed data", tar:"POSIX tar archive", json:"JSON text", js:"JavaScript source", py:"Python script", html:"HTML document", css:"CSS source", md:"Markdown text", csv:"CSV text", txt:"ASCII text", sh:"shell script" }; return m[e] || (isBinContent(content) ? "data" : "UTF-8 Unicode text"); }
  def("file", "파일 종류", (a, io) => { let c = 0; a.filter(x => x[0] !== "-").forEach(p => { const st = statOf(p); if(!st){ io.out += `${p}: cannot open (${NOFILE})\n`; c = 1; return; } io.out += `${p}: ${st.type === "dir" ? "directory" : mimeGuess(p, st.content)}\n`; }); return c; });
  def("stat", "파일 상태", (a, io) => { let c = 0; a.filter(x => x[0] !== "-").forEach(p => { const st = statOf(p); if(!st){ c = E(io, "stat", `cannot statx '${p}': ${NOFILE}`); return; }
    io.out += `  File: ${p}\n  Size: ${st.type === "dir" ? 4096 : (st.size || 0)}\tType: ${st.type === "dir" ? "directory" : "regular file"}\nAccess: (${st.mode || (st.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--")})\nModify: ${new Date(st.updatedAt || st.createdAt || Date.now()).toISOString()}\n`; }); return c; });
  function sizeOf(p){ return walk(p).reduce((n, x) => { const s = statOf(x); return n + (s && s.type === "file" ? (s.size || 0) : 0); }, 0); }
  def("du", "사용량 (-s -h)", (a, io) => { const { f, rest } = opts(a); (rest.length ? rest : ["."]).forEach(p => { if(!statOf(p)){ io.err += `du: cannot access '${p}': ${NOFILE}\n`; return; }
    const fmt = n => f.h ? human(n) : String(Math.ceil(n / 1024)); if(f.s) io.out += fmt(sizeOf(p)) + "\t" + p + "\n"; else { walk(p).filter(x => statOf(x).type === "dir").forEach(d => { io.out += fmt(sizeOf(d)) + "\t" + d + "\n"; }); } }); });
  def("df", "가상 저장공간 사용량 (-h)", (a, io) => { const u = FS.usageSummary(); const { f } = opts(a); const fmt = n => f.h ? human(n) : String(Math.ceil(n / 1024));
    io.out += `Filesystem      Size  Used Avail Use% Mounted on\nLinux_Local  ${fmt(u.capBytes).padStart(7)} ${fmt(u.usedBytes).padStart(5)} ${fmt(u.capBytes - u.usedBytes).padStart(5)} ${String(Math.round(u.usedBytes / u.capBytes * 100)).padStart(3)}% /\n`; });

  /* ======================= 압축 (진짜 tar / gzip / zip) ======================= */
  function tarHeader(name, size, isDir){
    const h = new Uint8Array(512); const put = (s, o, l) => { const b = enc.encode(s); h.set(b.subarray(0, l), o); };
    put(name, 0, 100); put(isDir ? "0000755" : "0000644", 100, 8); put("0000000", 108, 8); put("0000000", 116, 8); put(size.toString(8).padStart(11, "0"), 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, 12);
    put("        ", 148, 8); put(isDir ? "5" : "0", 156, 1); put("ustar", 257, 6); put("00", 263, 2);
    let sum = 0; for(let i = 0; i < 512; i++) sum += h[i]; put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8); return h;
  }
  function makeTar(entries){ const parts = []; let total = 0; entries.forEach(e => { const h = tarHeader(e.name + (e.dir && !e.name.endsWith("/") ? "/" : ""), e.dir ? 0 : e.data.length, e.dir); parts.push(h); total += 512; if(!e.dir){ parts.push(e.data); total += e.data.length; const pad = (512 - e.data.length % 512) % 512; if(pad){ parts.push(new Uint8Array(pad)); total += pad; } } }); parts.push(new Uint8Array(1024)); total += 1024; const out = new Uint8Array(total); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; }); return out; }
  function readTar(u8){ const dec = new TextDecoder(); const out = []; let o = 0; while(o + 512 <= u8.length){ const h = u8.subarray(o, o + 512); if(h.every(b => b === 0)) break; const name = dec.decode(h.subarray(0, 100)).replace(/\0.*$/, ""); const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8); const type = String.fromCharCode(h[156] || 48); o += 512; if(type === "5" || name.endsWith("/")) out.push({ name:name.replace(/\/$/, ""), dir:true }); else if(type === "0" || type === "\0") out.push({ name, dir:false, data:u8.slice(o, o + size) }); o += Math.ceil(size / 512) * 512; } return out; }
  function collect(paths){ const ents = []; const seen = new Set(); paths.forEach(p => { const st = statOf(p); if(!st) throw new Error(`${p}: ${NOFILE}`); const root = st.path; walk(p).forEach(x => { const s = statOf(x); const rel = (p.replace(/^\.\//, "").replace(/\/+$/, "") || ".") + (x === root ? "" : x.slice(root === "/" ? 1 : root.length)); const nm = rel.replace(/^\/+/, ""); if(seen.has(nm)) return; seen.add(nm); ents.push(s.type === "dir" ? { name:nm, dir:true } : { name:nm, dir:false, data:getBytes(x) }); }); }); return ents; }
  function ensureOutDir(dir){ if(dir && dir !== "." ) FS.mkdirp(dir); }
  function extractEntries(ents, dest, io, verbose){ ensureOutDir(dest); ents.forEach(e => { const target = (dest && dest !== "." ? dest.replace(/\/$/, "") + "/" : "") + e.name.replace(/^\/+/, "").replace(/\.\.\//g, ""); if(e.dir) FS.mkdirp(target); else { FS.mkdirp(FS.parentOf(FS.abs(target)) || "/"); putBytes(target, e.data); } if(verbose) io.out += e.name + "\n"; }); }
  def("tar", "tar 묶기/풀기 (-c -x -t -f -z -v -C) — 실제 ustar 형식", async (a, io) => {
    let args = a.slice(); if(args[0] && args[0][0] !== "-" && /^[cxtzvfC]+$/.test(args[0])) args[0] = "-" + args[0];
    const { f, v, rest } = opts(args, "fC"); const file = v.f; if(!file) return E(io, "tar", "-f <파일> 이 필요해요"); const dir = v.C || null;
    try{
      if(f.c){ if(!rest.length) return E(io, "tar", "묶을 파일/디렉터리를 지정하세요"); const saveCwd = FS.pwd(); if(dir) FS.cd(dir); let tar; try{ tar = makeTar(collect(rest)); }finally{ FS.cd(saveCwd); } if(f.z || /\.(tgz|gz)$/.test(file)) tar = await gzip(tar); putBytes(file, tar, "application/x-tar"); if(f.v) collect(rest).forEach(e => { io.out += e.name + "\n"; }); return 0; }
      let bytes = getBytes(file); if(f.z || (bytes[0] === 0x1f && bytes[1] === 0x8b)) bytes = await gunzip(bytes); const ents = readTar(bytes);
      if(f.t){ io.out += nl(ents.map(e => e.name + (e.dir ? "/" : ""))); return 0; }
      if(f.x){ const wanted = rest.length ? ents.filter(e => rest.some(r => e.name === r || e.name.startsWith(r + "/"))) : ents; extractEntries(wanted, dir || ".", io, f.v); return 0; }
      return E(io, "tar", "-c, -x, -t 중 하나가 필요해요");
    }catch(e){ return E(io, "tar", e.message); }
  });
  def("gzip", "gzip 압축 (-k 원본 유지, -d 해제, -c 표준출력)", async (a, io) => {
    const { f, rest } = opts(a); if(!rest.length) return E(io, "gzip", "파일 필요"); let c = 0;
    for(const p of rest){ try{ if(f.d){ const out = await gunzip(getBytes(p)); const t = p.replace(/\.gz$/, ""); if(f.c) io.out += new TextDecoder().decode(out); else { putBytes(t, out); if(!f.k) FS.rm(p, false); } } else { const out = await gzip(getBytes(p)); if(f.c) io.out += "(binary)"; else { putBytes(p + ".gz", out, "application/gzip"); if(!f.k) FS.rm(p, false); } } }catch(e){ c = E(io, "gzip", `${p}: ${e.message}`); } }
    return c;
  });
  def("gunzip", "gzip 해제 (-k 원본 유지, -c 표준출력)", (a, io, ctx) => S.registry.gzip.fn(["-d", ...a], io, ctx));
  async function loadJSZip(){
    if(global.JSZip) return global.JSZip;
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; s.onload = res; s.onerror = () => rej(new Error("zip 라이브러리를 불러오지 못했어요 (네트워크 확인)")); document.head.appendChild(s); });
    return global.JSZip;
  }
  def("zip", "zip 압축 (-r) — 실제 zip 형식", async (a, io) => {
    const { f, rest } = opts(a); if(rest.length < 2) return E(io, "zip", "usage: zip [-r] out.zip files..."); try{
      const JSZip = await loadJSZip(); const z = new JSZip(); const out = rest[0].endsWith(".zip") ? rest[0] : rest[0] + ".zip";
      collect(rest.slice(1)).forEach(e => { if(e.dir) z.folder(e.name); else z.file(e.name, e.data); io.out += `  adding: ${e.name}${e.dir ? "/" : ""}\n`; });
      putBytes(out, await z.generateAsync({ type:"uint8array" }), "application/zip"); }catch(e){ return E(io, "zip", e.message); }
  });
  def("unzip", "zip 해제 (-d 대상, -l 목록)", async (a, io) => {
    const { f, v, rest } = opts(a, "d"); if(!rest.length) return E(io, "unzip", "usage: unzip [-l] [-d dir] file.zip"); try{
      const JSZip = await loadJSZip(); const z = await JSZip.loadAsync(getBytes(rest[0])); const ents = [];
      for(const name of Object.keys(z.files)){ const zf = z.files[name]; ents.push(zf.dir ? { name:name.replace(/\/$/, ""), dir:true } : { name, dir:false, data: await zf.async("uint8array") }); }
      if(f.l){ io.out += nl(ents.map(e => "  " + (e.dir ? 0 : e.data.length).toString().padStart(9) + "  " + e.name + (e.dir ? "/" : ""))); return 0; }
      extractEntries(ents, v.d || ".", io, true); }catch(e){ return E(io, "unzip", e.message); }
  });

  /* ======================= 네트워크 (브라우저 fetch — CORS 제약) ======================= */
  async function fetchBytes(url, init){
    let r; try{ r = await fetch(url, Object.assign({ redirect:"follow" }, init || {})); }catch(e){ throw new Error(`요청 실패: ${e.message} (브라우저 CORS 정책 때문에 일부 사이트는 접근할 수 없어요. CORS 를 허용하는 URL 을 사용해 주세요)`); }
    return { r, bytes: new Uint8Array(await r.arrayBuffer()) };
  }
  def("curl", "HTTP 요청 (-o -O -s -L -I -X -H -d) — 브라우저 fetch 기반", async (a, io) => {
    const { f, v, rest } = opts(a, "oXHdA", ["output", "request", "header", "data"]); const url = rest[0]; if(!url) return E(io, "curl", "URL 필요");
    const init = { method: v.X || (v.d != null ? "POST" : (f.I ? "HEAD" : "GET")), headers:{} }; [].concat(v.H || []).forEach(h => { const i = h.indexOf(":"); if(i > 0) init.headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }); if(v.d != null) init.body = v.d;
    try{ const { r, bytes } = await fetchBytes(url, init);
      if(f.I){ io.out += `HTTP ${r.status} ${r.statusText}\n`; r.headers.forEach((val, k) => { io.out += `${k}: ${val}\n`; }); return 0; }
      const target = v.o || v.output || (f.O ? decodeURIComponent((new URL(url).pathname.split("/").pop()) || "index.html") : null);
      if(!r.ok && !f.f) io.err += f.s ? "" : `curl: HTTP ${r.status}\n`;
      if(target){ putBytes(target, bytes, (r.headers.get("content-type") || "").split(";")[0]); if(!f.s) io.err += `saved: ${target} (${bytes.length} bytes)\n`; }
      else { try{ io.out += new TextDecoder("utf-8", { fatal:true }).decode(bytes); }catch(e){ io.out += `(binary data ${bytes.length} bytes — -o 파일명 으로 저장하세요)\n`; } }
    }catch(e){ return E(io, "curl", e.message); }
  });
  def("wget", "파일 다운로드 (-O 파일명, -q)", async (a, io) => {
    const { f, v, rest } = opts(a, "OP"); const url = rest[0]; if(!url) return E(io, "wget", "URL 필요");
    try{ const { r, bytes } = await fetchBytes(url); if(!r.ok) return E(io, "wget", `HTTP ${r.status} ${r.statusText}`);
      let name = v.O || decodeURIComponent((new URL(url).pathname.split("/").pop()) || "index.html"); if(v.P) name = v.P.replace(/\/$/, "") + "/" + name;
      if(name === "-"){ io.out += new TextDecoder().decode(bytes); return 0; }
      putBytes(name, bytes, (r.headers.get("content-type") || "").split(";")[0]); if(!f.q) io.out += `'${name}' saved [${bytes.length}]\n`;
    }catch(e){ return E(io, "wget", e.message); }
  });

  /* ======================= 해시 / 인코딩 ======================= */
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  function md5(bytes){
    const K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0), Sh = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    const n = bytes.length, padded = new Uint8Array(((n + 8 >> 6) + 1) << 6); padded.set(bytes); padded[n] = 0x80; const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 8, (n * 8) >>> 0, true); dv.setUint32(padded.length - 4, Math.floor(n * 8 / 4294967296), true);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for(let o = 0; o < padded.length; o += 64){ const M = Array.from({ length:16 }, (_, i) => dv.getInt32(o + i * 4, true)); let A = a0, B = b0, C = c0, D = d0;
      for(let i = 0; i < 64; i++){ let F, g; if(i < 16){ F = (B & C) | (~B & D); g = i; } else if(i < 32){ F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if(i < 48){ F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B; const s = Sh[(i >> 4) * 4 + (i % 4)]; B = (B + ((F << s) | (F >>> (32 - s)))) | 0; }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0; }
    const out = new DataView(new ArrayBuffer(16)); [a0, b0, c0, d0].forEach((x, i) => out.setInt32(i * 4, x, true)); return hex(out.buffer);
  }
  function hashCmd(name, algo){
    def(name, `${name} 체크섬`, async (a, io) => { const rest = a.filter(x => x[0] !== "-"); let c = 0; const srcs = rest.length ? rest : [null];
      for(const p of srcs){ let bytes; try{ bytes = p == null ? enc.encode(io.stdin) : getBytes(p); }catch(e){ c = E(io, name, e.message); continue; }
        const h = algo === "md5" ? md5(bytes) : hex(await crypto.subtle.digest(algo, bytes)); io.out += `${h}  ${p == null ? "-" : p}\n`; } return c; });
  }
  hashCmd("md5sum", "md5"); hashCmd("sha1sum", "SHA-1"); hashCmd("sha256sum", "SHA-256"); hashCmd("sha512sum", "SHA-512");
  def("base64", "base64 인코딩/디코딩 (-d)", (a, io) => { const { f, rest } = opts(a); try{ if(f.d){ const t = (rest.length ? getText(io, "base64", rest[0]) : io.stdin); if(t == null) return 1; io.out += new TextDecoder().decode(b64ToBytes(t.replace(/\s+/g, ""))); } else { const b = rest.length ? getBytes(rest[0]) : enc.encode(io.stdin); io.out += bytesToB64(b).replace(/(.{76})/g, "$1\n") + "\n"; } }catch(e){ return E(io, "base64", e.message); } });

  /* ======================= 환경 / 탐색 ======================= */
  def("env", "환경 변수 목록", (a, io, ctx) => { Object.keys(ctx.env).filter(k => /^[A-Za-z_]/.test(k)).sort().forEach(k => { io.out += `${k}=${ctx.env[k]}\n`; }); });
  def("printenv", "환경 변수 출력", (a, io, ctx) => { if(!a.length) return S.registry.env.fn([], io, ctx); let c = 0; a.forEach(k => { if(ctx.env[k] != null) io.out += ctx.env[k] + "\n"; else c = 1; }); return c; });
  def("export", "환경 변수 설정 (KEY=VALUE)", (a, io, ctx) => { a.forEach(x => { const i = x.indexOf("="); if(i > 0) ctx.env[x.slice(0, i)] = x.slice(i + 1); }); });
  def("unset", "환경 변수 삭제", (a, io, ctx) => { a.forEach(k => { delete ctx.env[k]; }); });
  const kindLabel = r => r.kind === "builtin" ? "내장" : r.kind === "alias" ? "별칭" : "스크립트";
  def("which", "명령어 위치/존재 확인", (a, io) => { let c = 0; a.filter(x => x[0] !== "-").forEach(n => { const r = S.resolve(n); if(r) io.out += r.path + "\n"; else c = 1; }); return c; });
  def("whereis", "명령어 위치", (a, io) => { a.forEach(n => { const r = S.resolve(n); io.out += `${n}:${r ? " " + r.path : ""}\n`; }); });
  def("type", "명령어 종류", (a, io) => { let c = 0; a.forEach(n => { const r = S.resolve(n); if(r) io.out += `${n} is ${kindLabel(r)} (${r.path})\n`; else { io.err += `type: ${n}: not found\n`; c = 1; } }); return c; });
  def("command", "command -v <이름>", (a, io) => { const n = a.filter(x => x !== "-v" && x !== "-V")[0]; const r = n && S.resolve(n); if(r){ io.out += r.path + "\n"; return 0; } return 1; });
  def(["cmds", "help"], "사용 가능한 명령어 목록 (cmds [필터] / cmds -l 설명 포함)", (a, io) => {
    const { f, rest } = opts(a); const flt = rest[0]; let l = S.list(); if(flt) l = l.filter(n => n.includes(flt));
    if(f.l || f.v) l.forEach(n => { const r = S.resolve(n); io.out += `${n.padEnd(12)} ${kindLabel(r)} · ${r.desc || ""}\n`; }); else io.out += l.join(" ") + "\n";
    io.out += `(총 ${l.length}개 — /cmds 에 스크립트를 만들면 새 명령어로 등록돼요)\n`; });
  def("compgen", "compgen -c : 명령어 이름 목록", (a, io) => { const pre = a.filter(x => x[0] !== "-")[0] || ""; io.out += nl(S.list().filter(n => n.startsWith(pre))); });
  def("sleep", "잠시 대기 (최대 5초)", async (a) => { await new Promise(r => setTimeout(r, Math.min(5000, (parseFloat(a[0]) || 0) * 1000))); });
  def("clear", "화면 지우기 (출력 없음)", () => 0);
  def("true", "성공(0)", () => 0); def("false", "실패(1)", () => 1);
  def("date", "현재 날짜/시간 (+포맷)", (a, io) => { const d = new Date(); const p = n => String(n).padStart(2, "0"); const f = a.find(x => x[0] === "+");
    if(!f){ io.out += d.toString() + "\n"; return; }
    io.out += f.slice(1).replace(/%([YmdHMSyjAaBbpsZ%])/g, (m, c) => ({ Y:d.getFullYear(), m:p(d.getMonth() + 1), d:p(d.getDate()), H:p(d.getHours()), M:p(d.getMinutes()), S:p(d.getSeconds()), y:String(d.getFullYear()).slice(2), s:Math.floor(d.getTime() / 1000), A:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()], a:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()], B:d.toLocaleString("en", { month:"long" }), b:d.toLocaleString("en", { month:"short" }), p:d.getHours() < 12 ? "AM" : "PM", Z:"LOCAL", "%":"%", j:String(Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5)).padStart(3, "0") })[c]) + "\n"; });
  def("whoami", "현재 사용자", (a, io) => { io.out += "user\n"; }); def("id", "사용자 ID", (a, io) => { io.out += "uid=1000(user) gid=1000(user) groups=1000(user)\n"; });
  def("hostname", "호스트 이름", (a, io) => { io.out += "linux-local\n"; }); def("uname", "시스템 정보 (-a)", (a, io) => { io.out += a.includes("-a") ? "Linux linux-local 6.0.0-choimini #1 SMP browser-virtual x86_64 GNU/Linux\n" : "Linux\n"; });
  def("ps", "프로세스 목록 (가상 — 백그라운드 프로세스는 없음)", (a, io) => { io.out += "  PID TTY          TIME CMD\n    1 pts/0    00:00:00 sh\n"; });
  def("kill", "프로세스 종료 (가상)", (a, io) => { const pid = a.filter(x => x[0] !== "-")[0]; if(!pid) return E(io, "kill", "usage: kill pid"); return E(io, "kill", `(${pid}) - No such process (가상 환경엔 종료할 백그라운드 프로세스가 없어요)`); });
  def("mktemp", "임시 파일 생성 (-d 디렉터리)", (a, io) => { const p = "/tmp/tmp." + Math.random().toString(36).slice(2, 10); if(a.includes("-d")) FS.mkdirp(p); else FS.touch(p); io.out += p + "\n"; });

  function testExpr(a){
    a = a.slice(); if(a[a.length - 1] === "]") a.pop(); let neg = false; if(a[0] === "!"){ neg = true; a.shift(); }
    let r; const n = a.length;
    if(n === 0) r = false; else if(n === 1) r = a[0] !== "";
    else if(n === 2){ const [o, x] = a; const st = statOf(x); r = o === "-f" ? !!st && st.type === "file" : o === "-d" ? !!st && st.type === "dir" : (o === "-e" || o === "-r" || o === "-w" || o === "-x") ? !!st : o === "-s" ? !!st && (st.size || 0) > 0 : o === "-z" ? x === "" : o === "-n" ? x !== "" : false; }
    else { const [x, o, y] = a; const nx = +x, ny = +y; r = o === "=" || o === "==" ? x === y : o === "!=" ? x !== y : o === "-eq" ? nx === ny : o === "-ne" ? nx !== ny : o === "-lt" ? nx < ny : o === "-gt" ? nx > ny : o === "-le" ? nx <= ny : o === "-ge" ? nx >= ny : false; }
    return neg ? !r : r;
  }
  def(["test", "["], "조건 검사 (-f -d -e -s -z -n = != -eq -lt ...)", (a) => testExpr(a) ? 0 : 1);
  def("expr", "산술/문자열 (a + b)", (a, io) => { try{ const [x, o, y] = a; const nx = +x, ny = +y; const r = o === "+" ? nx + ny : o === "-" ? nx - ny : o === "*" ? nx * ny : o === "/" ? Math.trunc(nx / ny) : o === "%" ? nx % ny : null; if(r == null) return E(io, "expr", "지원: a + - * / % b"); io.out += r + "\n"; return r === 0 ? 1 : 0; }catch(e){ return E(io, "expr", e.message); } });
  def(["sh", "bash", "source", "."], "스크립트 파일 실행 (sh file.sh [인자])", async (a, io, ctx) => {
    let c = null; if(a[0] === "-c"){ c = a[1] || ""; } else if(a[0]){ c = getText(io, "sh", a[0]); if(c == null) return 127; }
    if(c == null) return E(io, "sh", "스크립트 파일 또는 -c '명령' 이 필요해요");
    const r = await S.runScript(c, a[0] === "-c" ? [] : a.slice(1), (ctx.depth || 0) + 1, io.stdin); io.out += r.out; io.err += r.err; return r.code;
  });
  def("alias", "별칭 등록: alias 이름='명령' (/cmds 에 저장돼 영구 유지)", (a, io) => {
    if(!a.length) return 0; a.forEach(x => { const i = x.indexOf("="); if(i < 1) return; const name = x.slice(0, i), body = x.slice(i + 1); try{ FS.writeFile("/cmds/" + name, JSON.stringify({ alias: body, desc: "alias" }), "application/json"); }catch(e){ E(io, "alias", e.message); } }); });

  /* ======================= 패키지 매니저 (pkg / pip / npm / npx) ======================= */
  // 이미 JS 로 구현돼 있어 "설치가 필요 없는" 도구 → 안내만
  const BUILT_IN_PKGS = { coreutils:"ls cat cp mv rm …", grep:"grep", sed:"sed", gawk:"awk", awk:"awk", findutils:"find xargs", tar:"tar", gzip:"gzip gunzip", zip:"zip", unzip:"unzip", curl:"curl", wget:"wget", git:"git", python:"python python3 (Pyodide)", python3:"python python3", nodejs:"node nodejs npm npx", node:"node", "nodejs-lts":"node", diffutils:"diff cmp", bash:"sh bash", procps:"ps kill" };
  function recordPkg(kind, name){
    const p = `/package/${kind}/${name}`; if(FS.isFile(p)) return false;
    FS.writeFile(p, JSON.stringify({ name, kind, installedAt: Date.now() }), "application/json"); return true;
  }
  function listPkgs(kind){ try{ return FS.dirChildren(`/package/${kind}`); }catch(e){ return []; } }
  def("pkg", "패키지 관리 (pkg install/uninstall/list/search)", (a, io) => {
    const { rest } = opts(a); const sub = rest[0], names = rest.slice(1); const pk = FS.pkgList ? listPkgs("pkg") : [];
    if(sub === "list" || sub === "list-installed"){ io.out += (pk.length ? pk.join("\n") + "\n" : "(추가로 설치된 pkg 패키지 없음)\n") + `기본 제공: ${Object.keys(BUILT_IN_PKGS).join(", ")}\n`; return 0; }
    if(sub === "update" || sub === "upgrade"){ io.out += "패키지 목록은 이미 최신이에요 (가상 환경)\n"; return 0; }
    if(sub === "search"){ const q = names[0] || ""; const hits = Object.keys(BUILT_IN_PKGS).filter(n => n.includes(q)); io.out += hits.length ? hits.map(n => `${n} — 기본 제공 (${BUILT_IN_PKGS[n]})`).join("\n") + "\n" : "일치하는 기본 제공 패키지 없음\n"; return 0; }
    if(sub === "uninstall" || sub === "remove"){ let c = 0; names.forEach(n => { const p = `/package/pkg/${n}`; if(FS.isFile(p)){ FS.rm(p, false); io.out += `제거됨: ${n}\n`; } else c = E(io, "pkg", `${n}: 설치되어 있지 않음`); }); return c; }
    if(sub === "install" || sub === "i"){
      if(!names.length) return E(io, "pkg", "설치할 패키지 이름이 필요해요");
      names.filter(n => n[0] !== "-").forEach(n => { if(BUILT_IN_PKGS[n]) io.out += `${n}: 이미 기본 제공돼요 → ${BUILT_IN_PKGS[n]}\n`;
        else { const added = recordPkg("pkg", n); io.out += `${n}: ${added ? "설치 기록됨" : "이미 설치됨"} ⚠ 이 브라우저 환경엔 '${n}' 의 실행 코드가 없어요. 명령어로 쓰려면 /cmds/${n} 에 스크립트(또는 {"alias":"..."})를 만들어야 해요.\n`; } });
      return 0; }
    return E(io, "pkg", "사용법: pkg install|uninstall|list|search|update <이름>");
  });
  def("pip", "Python 패키지 (pip install/list/uninstall) — python 실행 시 Pyodide(micropip)로 로드", (a, io) => {
    const { rest } = opts(a); const sub = rest[0], names = rest.slice(1).filter(n => n[0] !== "-");
    if(sub === "install"){ if(!names.length) return E(io, "pip", "패키지 이름 필요"); names.forEach(n => { io.out += `${n}: ${recordPkg("pip", n.split(/[=<>~]/)[0]) ? "설치 기록됨" : "이미 기록됨"} (python 실행 시 micropip 으로 실제 로드 시도 — 순수 파이썬/Pyodide 지원 패키지만 가능)\n`; }); return 0; }
    if(sub === "list" || sub === "freeze"){ io.out += nl(listPkgs("pip")); return 0; }
    if(sub === "uninstall"){ names.forEach(n => { try{ FS.rm(`/package/pip/${n}`, false); io.out += `제거됨: ${n}\n`; }catch(e){ E(io, "pip", `${n}: not installed`); } }); return 0; }
    return E(io, "pip", "사용법: pip install|list|uninstall <이름>");
  });
  def("pip3", "pip 와 동일", (a, io, ctx) => S.registry.pip.fn(a, io, ctx));
  def("npm", "Node 패키지 기록 (npm install/list/uninstall/init/run) — 격리된 node 실행기에는 모듈 로딩 제약", (a, io) => {
    const { rest } = opts(a); const sub = rest[0], names = rest.slice(1).filter(n => n[0] !== "-");
    if(sub === "install" || sub === "i"){ if(!names.length){ io.out += "up to date (package.json 의존성 설치는 지원하지 않아요)\n"; return 0; } names.forEach(n => { io.out += `${n}: ${recordPkg("npm", n) ? "설치 기록됨" : "이미 기록됨"} ⚠ node 실행기(격리 iframe)는 require() 로 npm 모듈을 불러오지 못해요. 필요하면 코드에서 await import("https://esm.sh/${n}") 를 사용하세요.\n`; }); return 0; }
    if(sub === "list" || sub === "ls"){ io.out += nl(listPkgs("npm")); return 0; }
    if(sub === "uninstall" || sub === "remove"){ names.forEach(n => { try{ FS.rm(`/package/npm/${n}`, false); io.out += `제거됨: ${n}\n`; }catch(e){ E(io, "npm", `${n}: not installed`); } }); return 0; }
    if(sub === "init"){ try{ FS.writeFile("package.json", JSON.stringify({ name:"project", version:"1.0.0", main:"index.js" }, null, 2) + "\n"); io.out += "package.json 생성됨\n"; }catch(e){ return E(io, "npm", e.message); } return 0; }
    if(sub === "-v" || sub === "--version"){ io.out += "npm (choimini virtual)\n"; return 0; }
    return E(io, "npm", "사용법: npm install|list|uninstall|init <이름>  (npm run/start 등은 지원하지 않아요)");
  });
  def("npx", "npx <스크립트.js> → node 로 실행 (외부 패키지 실행은 미지원)", (a, io, ctx) => { if(a[0] && /\.(m?js|cjs)$/.test(a[0])) return S.registry.node.fn(a, io, ctx); return E(io, "npx", "외부 패키지 실행은 지원하지 않아요. .js 파일 경로를 주세요"); });

  /* ======================= python / node (격리 iframe 샌드박스) =======================
     iframe sandbox="allow-scripts" (same-origin 없음) → 사이트의 localStorage/API 키에 접근 불가.
     Linux_Local 의 텍스트 파일 스냅샷을 넘겨주고, 실행 중 만들거나 바꾼 파일만 되돌려 받는다. */
  function snapshotFiles(){ const files = {}; let total = 0; FS.find("/").forEach(p => { const st = statOf(p); if(!st || st.type !== "file" || p.startsWith("/cmds/") || p.startsWith("/package/")) return; const c = String(st.content == null ? "" : st.content); if(isBinContent(c) || total + c.length > 1500000) return; files[p] = c; total += c.length; }); return files; }
  const NODE_SRC = String.raw`(async()=>{
let out="",err="";const changed={};const fsx=Object.assign({},P.files);
const note=(text,pct,done)=>{try{parent.postMessage({id:P.id,type:"progress",text:text,pct:pct,done:!!done},"*")}catch(e){}};
const norm=p=>{p=String(p);if(!p.startsWith("/"))p=P.cwd+"/"+p;const o=[];p.split("/").forEach(s=>{if(!s||s===".")return;if(s==="..")o.pop();else o.push(s)});return "/"+o.join("/")};
const fmt1=x=>{if(typeof x==="string")return x;if(x instanceof Error)return x.stack||String(x);try{return typeof x==="object"?JSON.stringify(x,(k,v)=>typeof v==="bigint"?String(v):v,2):String(x)}catch(e){return String(x)}};
const fmt=a=>{if(typeof a[0]==="string"&&/%[sdifjoO%]/.test(a[0])){let i=1;const s=a[0].replace(/%([sdifjoO%])/g,(m,c)=>{if(c==="%")return "%";if(i>=a.length)return m;const v=a[i++];return c==="d"||c==="i"?String(parseInt(v)):c==="f"?String(parseFloat(v)):(c==="j"||c==="o"||c==="O")?fmt1(v):String(v)});return [s].concat(a.slice(i).map(fmt1)).join(" ")}return a.map(fmt1).join(" ")};
const console={log:(...a)=>{out+=fmt(a)+"\n"},info:(...a)=>{out+=fmt(a)+"\n"},debug:(...a)=>{out+=fmt(a)+"\n"},warn:(...a)=>{err+=fmt(a)+"\n"},error:(...a)=>{err+=fmt(a)+"\n"},table:(d)=>{out+=fmt1(d)+"\n"},dir:(d)=>{out+=fmt1(d)+"\n"},trace:()=>{},time:()=>{},timeEnd:()=>{}};
const fs={readFileSync:(p,enc)=>{const k=norm(p);if(!(k in fsx)){const e=new Error("ENOENT: no such file or directory, open '"+p+"'");e.code="ENOENT";throw e}return fsx[k]},writeFileSync:(p,d)=>{const k=norm(p);fsx[k]=String(d);changed[k]=fsx[k]},appendFileSync:(p,d)=>{const k=norm(p);fsx[k]=(fsx[k]||"")+String(d);changed[k]=fsx[k]},existsSync:p=>{const k=norm(p);return k in fsx||Object.keys(fsx).some(f=>f.startsWith(k+"/"))},readdirSync:p=>{const k=norm(p).replace(/\/$/,"");const s=new Set();Object.keys(fsx).forEach(f=>{if(f.startsWith(k+"/"))s.add(f.slice(k.length+1).split("/")[0])});return[...s]},mkdirSync:()=>{},unlinkSync:p=>{delete fsx[norm(p)]},rmSync:p=>{const k=norm(p);Object.keys(fsx).forEach(f=>{if(f===k||f.startsWith(k+"/"))delete fsx[f]})},statSync:p=>{const k=norm(p);const isF=k in fsx;const isD=!isF&&Object.keys(fsx).some(f=>f.startsWith(k+"/"));if(!isF&&!isD){const e=new Error("ENOENT: no such file or directory, stat '"+p+"'");e.code="ENOENT";throw e}return{isFile:()=>isF,isDirectory:()=>isD,size:isF?fsx[k].length:0,mtimeMs:Date.now()}}};
fs.promises={readFile:async(p,e)=>fs.readFileSync(p,e),writeFile:async(p,d)=>fs.writeFileSync(p,d),appendFile:async(p,d)=>fs.appendFileSync(p,d),readdir:async p=>fs.readdirSync(p),mkdir:async()=>{},unlink:async p=>fs.unlinkSync(p),stat:async p=>fs.statSync(p)};
fs.readFile=(p,e,cb)=>{if(typeof e==="function"){cb=e}try{const d=fs.readFileSync(p);setTimeout(()=>cb(null,d),0)}catch(x){setTimeout(()=>cb(x),0)}};
fs.writeFile=(p,d,e,cb)=>{if(typeof e==="function"){cb=e}fs.writeFileSync(p,d);setTimeout(()=>cb&&cb(null),0)};
const path={sep:"/",join:(...a)=>norm(a.join("/")).replace(/^\//,a[0]&&String(a[0]).startsWith("/")?"/":""),resolve:(...a)=>norm(a.join("/")),basename:(p,e)=>{let b=String(p).split("/").pop();if(e&&b.endsWith(e))b=b.slice(0,-e.length);return b},dirname:p=>String(p).split("/").slice(0,-1).join("/")||"/",extname:p=>{const m=/\.[^./]*$/.exec(p);return m?m[0]:""},relative:(a,b)=>{const x=norm(a).split("/").filter(Boolean),y=norm(b).split("/").filter(Boolean);while(x.length&&y.length&&x[0]===y[0]){x.shift();y.shift()}return x.map(()=>"..").concat(y).join("/")},isAbsolute:p=>String(p).startsWith("/"),parse:p=>{const b=String(p).split("/").pop();const m=/\.[^./]*$/.exec(b);return{root:"/",dir:String(p).split("/").slice(0,-1).join("/"),base:b,ext:m?m[0]:"",name:m?b.slice(0,-m[0].length):b}}};
// ---- 타이머 추적 (프로세스가 "할 일이 끝나면" 자동 종료) ----
const _st=setTimeout,_ct=clearTimeout,_si=setInterval,_ci=clearInterval;const active=new Map();let keepAlive=0;
const setTimeoutT=(f,ms,...a)=>{const id=_st(()=>{active.delete(id);try{const r=f(...a);if(r&&r.catch)r.catch(onFail)}catch(e){onFail(e)}},ms);active.set(id,"t");return id};
const setIntervalT=(f,ms,...a)=>{const id=_si(()=>{try{const r=f(...a);if(r&&r.catch)r.catch(onFail)}catch(e){onFail(e)}},ms);active.set(id,"i");return id};
const clearT=id=>{active.delete(id);_ct(id);_ci(id)};
const setImmediateT=(f,...a)=>setTimeoutT(f,0,...a);
let failed=null;const onFail=e=>{if(e&&e.__exit)return;if(!failed)failed=e};
// ---- 내장 모듈 ----
class EventEmitter{constructor(){this._ev={}}on(n,f){(this._ev[n]=this._ev[n]||[]).push(f);return this}addListener(n,f){return this.on(n,f)}prependListener(n,f){(this._ev[n]=this._ev[n]||[]).unshift(f);return this}once(n,f){const w=(...a)=>{this.off(n,w);return f.apply(this,a)};w._o=f;return this.on(n,w)}off(n,f){const l=this._ev[n];if(l)this._ev[n]=l.filter(x=>x!==f&&x._o!==f);return this}removeListener(n,f){return this.off(n,f)}removeAllListeners(n){if(n)delete this._ev[n];else this._ev={};return this}emit(n,...a){const l=(this._ev[n]||[]).slice();if(!l.length){if(n==="error")throw a[0];return false}l.forEach(f=>{try{const r=f.apply(this,a);if(r&&r.catch)r.catch(e=>{if(n==="error")onFail(e);else this.emit("error",e)})}catch(e){onFail(e)}});return true}listenerCount(n){return(this._ev[n]||[]).length}listeners(n){return(this._ev[n]||[]).slice()}setMaxListeners(){return this}}
EventEmitter.EventEmitter=EventEmitter;
class BufferX extends Uint8Array{toString(enc){enc=enc||"utf8";if(enc==="hex")return[...this].map(b=>b.toString(16).padStart(2,"0")).join("");if(enc==="base64"){let s="";this.forEach(b=>s+=String.fromCharCode(b));return btoa(s)}return new TextDecoder().decode(this)}static from(d,enc){if(typeof d==="string"){if(enc==="hex"){const a=d.match(/../g)||[];return new BufferX(a.map(h=>parseInt(h,16)))}if(enc==="base64"){const s=atob(d);return new BufferX([...s].map(c=>c.charCodeAt(0)))}return new BufferX(new TextEncoder().encode(d))}return new BufferX(d)}static alloc(n){return new BufferX(n)}static byteLength(s){return new TextEncoder().encode(String(s)).length}static concat(l){const t=l.reduce((a,b)=>a+b.length,0),r=new BufferX(t);let o=0;l.forEach(b=>{r.set(b,o);o+=b.length});return r}static isBuffer(x){return x instanceof BufferX}}
const util={format:(...a)=>fmt(a),inspect:x=>fmt1(x),promisify:f=>(...a)=>new Promise((res,rej)=>f(...a,(e,v)=>e?rej(e):res(v))),inherits:(c,s)=>{Object.setPrototypeOf(c.prototype,s.prototype)},isDeepStrictEqual:(a,b)=>JSON.stringify(a)===JSON.stringify(b),TextEncoder,TextDecoder,types:{isPromise:x=>!!x&&typeof x.then==="function"}};
const assertM=(c,m)=>{if(!c)throw new Error(m||"Assertion failed")};Object.assign(assertM,{ok:assertM,equal:(a,b,m)=>assertM(a==b,m||a+" != "+b),strictEqual:(a,b,m)=>assertM(a===b,m||a+" !== "+b),notStrictEqual:(a,b,m)=>assertM(a!==b,m),deepStrictEqual:(a,b,m)=>assertM(JSON.stringify(a)===JSON.stringify(b),m||"not deep equal"),deepEqual:(a,b,m)=>assertM(JSON.stringify(a)===JSON.stringify(b),m||"not deep equal"),throws:(f,m)=>{let t=false;try{f()}catch(e){t=true}assertM(t,m||"Missing expected exception")}});
const osM={EOL:"\n",platform:()=>"linux",type:()=>"Linux",arch:()=>"x64",homedir:()=>"/user",tmpdir:()=>"/tmp",hostname:()=>"choimini",cpus:()=>[{model:"virtual"}],totalmem:()=>4e9,freemem:()=>2e9,uptime:()=>1000};
const cryptoM={randomUUID:()=>crypto.randomUUID(),randomBytes:n=>{const b=new BufferX(n);crypto.getRandomValues(b);return b},randomInt:(a,b)=>{if(b==null){b=a;a=0}return a+Math.floor(Math.random()*(b-a))},webcrypto:crypto,subtle:crypto.subtle,createHash:()=>{throw new Error("crypto.createHash 는 동기 API 라 격리 샌드박스에서 지원하지 않아요. await crypto.subtle.digest('SHA-256', data) 를 쓰세요")}};
const readlineM={createInterface:()=>{const e=new EventEmitter();e.question=(q,cb)=>{out+=q;setTimeoutT(()=>cb(""),0)};e.close=()=>{};e.setPrompt=()=>{};e.prompt=()=>{};return e}};
const httpM={request:(u,o,cb)=>{if(typeof o==="function"){cb=o;o={}}const e=new EventEmitter();const body=[];e.write=d=>body.push(d);e.end=d=>{if(d)body.push(d);keepAlive++;fetch(typeof u==="string"?u:u.href||String(u),Object.assign({method:(o&&o.method)||"GET",headers:o&&o.headers,body:body.length?body.join(""):undefined}))["then"](async r=>{const t=await r.text();const res=new EventEmitter();res.statusCode=r.status;res.headers=Object.fromEntries(r.headers.entries());cb&&cb(res);res.emit("data",t);res.emit("end");e.emit("response",res)}).catch(x=>e.emit("error",x)).finally(()=>{keepAlive--})};return e},get:(u,o,cb)=>{const r=httpM.request(u,o,cb);r.end();return r}};
const childM=new Proxy({},{get:()=>()=>{throw new Error("child_process 는 격리 샌드박스에서 지원하지 않아요 (데스크톱 앱의 '실제 로컬 터미널' 모드를 쓰세요)")}});
const builtin={fs,path,events:EventEmitter,util,assert:assertM,os:osM,crypto:cryptoM,readline:readlineM,http:httpM,https:httpM,child_process:childM,buffer:{Buffer:BufferX},url:{URL,URLSearchParams,fileURLToPath:u=>String(u).replace(/^file:\/\//,""),pathToFileURL:p=>new URL("file://"+p)},timers:{setTimeout:setTimeoutT,setInterval:setIntervalT,clearTimeout:clearT,clearInterval:clearT},"timers/promises":{setTimeout:(ms,v)=>new Promise(r=>setTimeoutT(()=>r(v),ms))},"fs/promises":fs.promises,string_decoder:{StringDecoder:class{write(b){return new TextDecoder().decode(b)}end(){return""}}},stream:{Readable:EventEmitter,Writable:EventEmitter,Transform:EventEmitter},zlib:{},net:{},tls:{},dns:{},worker_threads:{isMainThread:true}};
const proc=new EventEmitter();Object.assign(proc,{argv:["node",...P.args],env:Object.assign({NODE_ENV:"development"},P.env||{}),cwd:()=>P.cwd,exit:c=>{throw{__exit:c||0}},stdout:{write:s=>{out+=s;return true},isTTY:false,columns:80},stderr:{write:s=>{err+=s;return true}},stdin:new EventEmitter(),platform:"linux",version:"v20.11.0",versions:{node:"20.11.0",choimini:"1"},pid:1,arch:"x64",nextTick:(f,...a)=>setTimeoutT(()=>f(...a),0),hrtime:Object.assign(()=>{const t=performance.now();return[Math.floor(t/1000),Math.floor((t%1000)*1e6)]},{bigint:()=>BigInt(Math.floor(performance.now()*1e6))}),uptime:()=>performance.now()/1000,memoryUsage:()=>({rss:5e7,heapUsed:2e7,heapTotal:3e7}),emitWarning:()=>{}});
const ext={};const cache={};
// ---- Discord 테스트용 모의 모듈 (실제 디스코드에는 연결하지 않음) ----
const DISCORD_SRC=P.discordSrc;
const needMock=(n)=>n==="discord.js";
const loadFile=(k)=>{if(cache[k])return cache[k].exports;const src=fsx[k];if(src==null)throw new Error("Cannot find module '"+k+"'");const m={exports:{}};cache[k]=m;if(/\.json$/.test(k)){m.exports=JSON.parse(src);return m.exports}const dir=k.split("/").slice(0,-1).join("/")||"/";const rq=n=>requireFrom(dir,n);(new Function("module","exports","require","__filename","__dirname","process","console","setTimeout","setInterval","clearTimeout","clearInterval","setImmediate","Buffer",esm(src)))(m,m.exports,rq,k,dir,proc,console,setTimeoutT,setIntervalT,clearT,clearT,setImmediateT,BufferX);return m.exports};
const resolveRel=(dir,n)=>{const base=norm(n.startsWith("/")?n:dir+"/"+n);for(const c of [base,base+".js",base+".json",base+".cjs",base+".mjs",base+"/index.js"])if(c in fsx)return c;return null};
const requireFrom=(dir,n)=>{n=String(n).replace(/^node:/,"");if(n.startsWith(".")||n.startsWith("/")){const k=resolveRel(dir,n);if(!k)throw new Error("Cannot find module '"+n+"'");return loadFile(k)}if(n in builtin)return builtin[n];if(n==="dotenv"){return{config:()=>{const k=norm(P.cwd+"/.env");const parsed={};if(k in fsx)fsx[k].split("\n").forEach(l=>{const m=/^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(l);if(m&&!l.trim().startsWith("#")){let v=m[2].replace(/^['"]|['"]$/g,"");parsed[m[1]]=v;if(!(m[1] in proc.env))proc.env[m[1]]=v}});return{parsed}}}}if(n==="node-fetch")return Object.assign(fetch.bind(globalThis),{default:fetch.bind(globalThis)});if(needMock(n)){if(!cache["__discord"]){const mm={exports:{}};(new Function("module","exports","require","EventEmitter","process","console","setTimeout","keepAliveInc","keepAliveDec","onFail",DISCORD_SRC))(mm,mm.exports,x=>requireFrom("/",x),EventEmitter,proc,console,setTimeoutT,()=>{keepAlive++},()=>{keepAlive--},onFail);cache["__discord"]=mm}return cache["__discord"].exports}if(n in ext)return ext[n];throw new Error("Cannot find module '"+n+"' (npm 패키지는 실행 전에 자동으로 내려받아요. 이름을 확인하세요)")};
const require=n=>requireFrom(P.cwd,n);
// ESM import 문을 require 로 바꿔서 실행 (import x from 'm' / import {a} from 'm' / import * as x from 'm' / export default)
const esm=s=>s.replace(/^\s*import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm,"const $1=require('$3');const {$2}=require('$3');").replace(/^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"];?/gm,"const $1=require('$2');").replace(/^\s*import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm,(m,a,b)=>"const {"+a.replace(/\s+as\s+/g,": ")+"}=require('"+b+"');").replace(/^\s*import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"];?/gm,"const $1=(m=>m&&m.default!==undefined&&m.__esModule?m.default:m)(require('$2'));").replace(/^\s*import\s*['"]([^'"]+)['"];?/gm,"require('$1');").replace(/^\s*export\s+default\s+/gm,"module.exports.default=").replace(/^\s*export\s+(const|let|var|function|class|async function)\s+([\w$]+)/gm,(m,k,n)=>"module.exports."+n+"="+"(void 0);"+k+" "+n).replace(/^\s*export\s*\{([^}]*)\};?/gm,"");
// ---- npm 패키지 미리 내려받기 (esm.sh) ----
const scan=(s)=>{const r=new Set();let m;const re1=/require\(\s*['"]([^'"]+)['"]\s*\)/g,re2=/from\s*['"]([^'"]+)['"]/g,re3=/import\s*['"]([^'"]+)['"]/g;for(const re of [re1,re2,re3])while((m=re.exec(s)))r.add(m[1]);return[...r]};
try{
const names=new Set();scan(P.code).forEach(n=>names.add(n));Object.keys(fsx).filter(k=>/\.(m?js|cjs)$/.test(k)&&!k.startsWith("/cmds/")&&!k.startsWith("/package/")&&!k.includes("node_modules")).slice(0,60).forEach(k=>scan(fsx[k]).forEach(n=>names.add(n)));
const todo=[...names].map(n=>String(n).replace(/^node:/,"")).filter(n=>!n.startsWith(".")&&!n.startsWith("/")&&!(n in builtin)&&n!=="dotenv"&&n!=="node-fetch"&&!needMock(n));
let i=0;for(const n of todo){note("터미널 패키지 다운로드중... "+n,Math.round(i/todo.length*100));try{const ns=await import("https://esm.sh/"+n);ext[n]=(ns&&ns.default!==undefined&&Object.keys(ns).length<=2)?ns.default:ns}catch(e){err+="패키지 '"+n+"' 를 내려받지 못했어요 ("+(e&&e.message||e)+")\n"}i++}
if(todo.length)note("터미널 패키지 다운로드 완료 ("+todo.length+"개)",100,true);
const fp=P.code;
(async()=>{})();
const AF=Object.getPrototypeOf(async function(){}).constructor;
const mainMod={exports:{}};
await new AF("module","exports","console","require","process","fs","path","__filename","__dirname","Buffer","setTimeout","setInterval","clearTimeout","clearInterval","setImmediate",esm(P.code))(mainMod,mainMod.exports,console,require,proc,fs,path,P.args[0]||"main.js",P.cwd,BufferX,setTimeoutT,setIntervalT,clearT,clearT,setImmediateT);
// 이벤트 루프: 남은 타이머/연결이 없으면 종료 (setInterval 만 남으면 제한 시간까지만)
const t0=Date.now();
while(!failed){const timeouts=[...active.values()].filter(v=>v==="t").length;const ints=[...active.values()].filter(v=>v==="i").length;if(!timeouts&&!keepAlive&&!ints)break;if(!timeouts&&!keepAlive&&ints&&Date.now()-t0>(P.intervalMs||3000)){out+="(setInterval 이 계속 실행 중이라 "+Math.round((P.intervalMs||3000)/1000)+"초 후 종료했어요)\n";break}if(Date.now()-t0>P.maxMs){err+="실행 제한 시간("+Math.round(P.maxMs/1000)+"초)에 도달해서 종료했어요\n";break}await new Promise(r=>_st(r,25))}
active.forEach((v,id)=>{_ct(id);_ci(id)});
if(failed){const e=failed;if(e&&e.__exit!==undefined){post({out,err,code:e.__exit,changed});return}err+=(e&&e.stack?String(e.stack).split("\n").slice(0,5).join("\n"):String(e))+"\n";post({out,err,code:1,changed});return}
post({out,err,code:0,changed})
}catch(e){active.forEach((v,id)=>{_ct(id);_ci(id)});if(e&&e.__exit!==undefined){post({out,err,code:e.__exit,changed});return}post({out,err:err+(e&&e.stack?String(e.stack).split("\n").slice(0,5).join("\n"):String(e))+"\n",code:1,changed})}
})();
`;
  const DISCORD_SRC = String.raw`const E=EventEmitter;
const log=(...a)=>console.log("[discord-mock]",...a);
const Events={ClientReady:"ready",MessageCreate:"messageCreate",InteractionCreate:"interactionCreate",GuildMemberAdd:"guildMemberAdd",Error:"error",Warn:"warn",Debug:"debug"};
const GatewayIntentBits=new Proxy({Guilds:1,GuildMembers:2,GuildMessages:512,MessageContent:32768,DirectMessages:4096,GuildMessageReactions:1024,GuildVoiceStates:128},{get:(t,k)=>k in t?t[k]:1});
const Partials={Channel:0,Message:1,User:2,GuildMember:3,Reaction:4};
class IntentsBitField{constructor(a){this.bits=a}}
const toText=o=>typeof o==="string"?o:o==null?"":[o.content,...(o.embeds||[]).map(e=>{const d=e.data||e;return "[Embed"+(d.title?": "+d.title:"")+(d.description?" | "+d.description:"")+"]"}),...(o.files?["[첨부 "+o.files.length+"개]"]:[])].filter(Boolean).join(" ");
class Collection extends Map{find(f){for(const [k,v] of this)if(f(v,k,this))return v}filter(f){const c=new Collection();for(const [k,v] of this)if(f(v,k,this))c.set(k,v);return c}map(f){return [...this].map(([k,v])=>f(v,k,this))}first(){return this.values().next().value}toJSON(){return [...this.values()]}}
class Builder{constructor(d){this.data=Object.assign({},d)}toJSON(){return this.data}}
class EmbedBuilder extends Builder{setTitle(v){this.data.title=v;return this}setDescription(v){this.data.description=v;return this}setColor(v){this.data.color=v;return this}addFields(...f){this.data.fields=(this.data.fields||[]).concat(f.flat());return this}setFooter(v){this.data.footer=v;return this}setTimestamp(){this.data.timestamp=Date.now();return this}setThumbnail(v){this.data.thumbnail=v;return this}setImage(v){this.data.image=v;return this}setAuthor(v){this.data.author=v;return this}setURL(v){this.data.url=v;return this}}
class SlashCommandBuilder extends Builder{constructor(){super({options:[]})}setName(v){this.name=this.data.name=v;return this}setDescription(v){this.description=this.data.description=v;return this}setDefaultMemberPermissions(){return this}setDMPermission(){return this}_o(t,f){const o={type:t,required:false};f(new Builder(o).constructor===Builder?new OptB(o):0);this.data.options.push(o);return this}addStringOption(f){return this._o(3,f)}addIntegerOption(f){return this._o(4,f)}addBooleanOption(f){return this._o(5,f)}addUserOption(f){return this._o(6,f)}addChannelOption(f){return this._o(7,f)}addNumberOption(f){return this._o(10,f)}}
class OptB{constructor(o){this.o=o}setName(v){this.o.name=v;return this}setDescription(v){this.o.description=v;return this}setRequired(v=true){this.o.required=v;return this}addChoices(...c){this.o.choices=c.flat();return this}setMinValue(v){this.o.min=v;return this}setMaxValue(v){this.o.max=v;return this}}
class ActionRowBuilder extends Builder{constructor(){super({components:[]})}addComponents(...c){this.data.components.push(...c.flat());return this}}
class ButtonBuilder extends Builder{setCustomId(v){this.data.custom_id=v;return this}setLabel(v){this.data.label=v;return this}setStyle(v){this.data.style=v;return this}setEmoji(v){this.data.emoji=v;return this}setURL(v){this.data.url=v;return this}setDisabled(v=true){this.data.disabled=v;return this}}
const ButtonStyle={Primary:1,Secondary:2,Success:3,Danger:4,Link:5};
const PermissionFlagsBits=new Proxy({},{get:(t,k)=>typeof k==="string"?1n:0n});
const ActivityType={Playing:0,Streaming:1,Listening:2,Watching:3,Custom:4,Competing:5};
const Colors=new Proxy({},{get:()=>0x5865f2});
const MessageFlags={Ephemeral:64};
const Routes={applicationCommands:id=>"/applications/"+id+"/commands",applicationGuildCommands:(a,g)=>"/applications/"+a+"/guilds/"+g+"/commands"};
class REST{constructor(){}setToken(){return this}async put(r,o){const n=((o&&o.body)||[]).length;log("슬래시 명령 등록(모의): "+r+" — "+n+"개");return (o&&o.body)||[]}async post(){return {}}async delete(){return {}}}
const mkUser=(n,bot)=>({id:"U"+(Math.abs(hash(n))%1e9),username:n,tag:n+"#0001",displayName:n,bot:!!bot,toString(){return "<@"+this.id+">"},displayAvatarURL(){return "https://cdn.example/avatar.png"},send:async o=>{log("DM → "+n+": "+toText(o));return mkMsg(o,mkChan("dm"),mkUser("봇",true))}});
const hash=s=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))|0;return h};
const mkChan=(n)=>({id:"C"+n,name:n,type:0,isTextBased:()=>true,send:async o=>{log("#"+n+" ← 봇: "+toText(o));return mkMsg(o,mkChan(n),mkUser("봇",true))},sendTyping:async()=>{}});
const mkGuild=()=>({id:"G1",name:"테스트 서버",memberCount:3,members:{cache:new Collection(),fetch:async()=>null},channels:{cache:new Collection()},roles:{cache:new Collection()}});
const mkMsg=(o,ch,author)=>{const c=typeof o==="string"?o:(o&&o.content)||"";const g=mkGuild();const m={id:"M"+Math.random().toString(36).slice(2,8),content:c,author,member:{user:author,displayName:author.username,roles:{cache:new Collection(),add:async()=>{},remove:async()=>{}},permissions:{has:()=>true}},channel:ch,channelId:ch.id,guild:g,guildId:g.id,createdTimestamp:Date.now(),mentions:{users:new Collection(),members:new Collection(),has:()=>false},attachments:new Collection(),embeds:[]};
 m.reply=async x=>{log("↩ 봇 답장: "+toText(x));return mkMsg(x,ch,mkUser("봇",true))};m.react=async e=>{log("반응 추가: "+e)};m.delete=async()=>{log("메시지 삭제")};m.edit=async x=>{log("메시지 수정: "+toText(x));return m};m.pin=async()=>{};return m};
class Client extends E{constructor(o){super();this.options=o||{};this.user=null;this.guilds={cache:new Collection()};this.channels={cache:new Collection(),fetch:async id=>mkChan(String(id))};this.users={cache:new Collection(),fetch:async()=>mkUser("user")};this.application={commands:{set:async c=>{log("명령 등록(모의): "+(c||[]).length+"개");return c},create:async c=>c}};this.commands=new Collection();this.ws={ping:42}}
 async login(token){
  if(!token)console.warn("[discord-mock] 경고: 토큰이 비어 있어요 (실제 디스코드에선 TokenInvalid 에러). 모의 실행은 계속합니다.");
  this.user=Object.assign(mkUser("테스트봇",true),{setActivity:a=>log("활동 상태: "+JSON.stringify(a)),setPresence:p=>log("상태 설정")});
  log("※ 브라우저 샌드박스에서는 실제 디스코드에 접속할 수 없어, 모의 서버로 로직만 테스트합니다 (실제 접속은 PC 터미널에서).");
  keepAliveInc();
  const g=mkGuild();this.guilds.cache.set(g.id,g);
  setTimeout(()=>{
   try{this.emit("ready",this);this.emit("clientReady",this)}catch(e){onFail(e)}
   log("ready 이벤트 발생 — 로그인: "+this.user.tag);
   const argv=process.argv,says=[],slashes=[];
   for(let i=0;i<argv.length;i++){if(argv[i]==="--say"&&argv[i+1])says.push(argv[++i]);else if(argv[i]==="--slash"&&argv[i+1]){const parts=[argv[++i]];while(argv[i+1]&&!argv[i+1].startsWith("--"))parts.push(argv[++i]);slashes.push(parts)}}
   if(!says.length&&!slashes.length)log('시뮬레이션: node 파일.js --say "!ping"  /  --slash ping  /  --slash say text=안녕 (여러 번 가능)');
   let d=150;const sched=f=>{setTimeout(()=>{try{const r=f();if(r&&r.catch)r.catch(onFail)}catch(e){onFail(e)}},d);d+=300};
   const ch=mkChan("general"),user=mkUser("테스터",false);
   says.forEach(t=>sched(()=>{log("#general ← 테스터: "+t);const m=mkMsg(t,ch,user);return this.emit("messageCreate",m)}));
   slashes.forEach(parts=>sched(()=>{const name=parts[0],opts={};parts.slice(1).forEach(p=>{const i=p.indexOf("=");if(i>0)opts[p.slice(0,i)]=p.slice(i+1)});log("/"+name+" ← 테스터 "+JSON.stringify(opts));
    const ia={id:"I1",commandName:name,user,member:{user,roles:{cache:new Collection()}},channel:ch,channelId:ch.id,guild:mkGuild(),client:this,replied:false,deferred:false,
     isChatInputCommand:()=>true,isCommand:()=>true,isButton:()=>false,isAutocomplete:()=>false,isModalSubmit:()=>false,isStringSelectMenu:()=>false,
     options:{getString:(k)=>opts[k]??null,getInteger:k=>opts[k]==null?null:parseInt(opts[k]),getNumber:k=>opts[k]==null?null:parseFloat(opts[k]),getBoolean:k=>opts[k]==null?null:opts[k]==="true",getUser:k=>opts[k]?mkUser(opts[k]):null,getChannel:()=>ch,getSubcommand:()=>opts.sub||null,get:k=>opts[k]==null?null:{value:opts[k]}},
     reply:async x=>{ia.replied=true;log("↩ 응답: "+toText(x));return x},deferReply:async()=>{ia.deferred=true;log("(응답 지연 deferReply)")},editReply:async x=>{log("↩ 응답 수정: "+toText(x))},followUp:async x=>{log("↩ 추가 응답: "+toText(x))},deleteReply:async()=>{}};
    return this.emit("interactionCreate",ia)}));
   setTimeout(()=>{keepAliveDec()},d+1200);
  },100);
  return token||"mock-token"};
 destroy(){this.emit("shardDisconnect");return Promise.resolve()}isReady(){return !!this.user}}
Client.prototype.once=function(n,f){if(n==="clientReady")n="ready";return E.prototype.once.call(this,n,f)};
Client.prototype.on=function(n,f){if(n==="clientReady")n="ready";return E.prototype.on.call(this,n,f)};
module.exports={Client,Collection,EmbedBuilder,SlashCommandBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,GatewayIntentBits,IntentsBitField,Partials,Events,REST,Routes,PermissionFlagsBits,ActivityType,Colors,MessageFlags,Intents:GatewayIntentBits,version:"14-mock"};
`;
  function termProgress(text, pct, done){ try{ window.dispatchEvent(new CustomEvent("choimini-terminal-progress", { detail:{ text, pct, done:!!done } })); }catch(e){} }
  /* 처음 터미널(python/node)을 쓸 때 한 번만: 필요한 패키지를 미리 내려받고 진행률을 알린다 */
  let firstUseP = null;
  function firstUse(kind){
    let seen = false; try{ seen = localStorage.getItem("choimini_term_pkgs_v1") === "1"; }catch(e){}
    if(seen) return Promise.resolve();
    if(firstUseP) return firstUseP;
    const urls = ["https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js"];
    firstUseP = (async () => {
      termProgress("터미널 패키지 다운로드중...", 0);
      let i = 0;
      for(const u of urls){ try{ await fetch(u, { mode:"no-cors" }); }catch(e){} i++; termProgress("터미널 패키지 다운로드중...", Math.round(i / urls.length * 100), i === urls.length); }
      try{ localStorage.setItem("choimini_term_pkgs_v1", "1"); }catch(e){}
    })();
    return firstUseP;
  }
  function runSandbox(kind, code, args, timeoutMs){
    return new Promise(resolve => {
      const files = snapshotFiles(); const cwd = FS.pwd(); const id = "sb" + Math.random().toString(36).slice(2);
      const pipPkgs = kind === "python" ? listPkgs("pip") : [];
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.style.display = "none";
      let done = false; const finish = r => { if(done) return; done = true; window.removeEventListener("message", onMsg); clearTimeout(timer); frame.remove(); resolve(r); };
      const timer = setTimeout(() => finish({ out:"", err:`실행 시간 초과 (${Math.round(timeoutMs / 1000)}초)\n`, code:124, changed:{} }), timeoutMs);
      const onMsg = ev => { if(ev.source !== frame.contentWindow || !ev.data || ev.data.id !== id) return; if(ev.data.type === "progress"){ termProgress(ev.data.text, ev.data.pct, ev.data.done); return; } finish(ev.data.result); };
      window.addEventListener("message", onMsg);
      const payload = JSON.stringify({ id, code, args, files, cwd, pipPkgs, discordSrc: DISCORD_SRC, env: Object.assign({}, S.env || {}), maxMs: timeoutMs - 5000, intervalMs: 4000 }).replace(/</g, "\\u003c");
      const common = `const P=${payload};const post=r=>parent.postMessage({id:P.id,result:r},"*");`;
      const nodeScript = common + NODE_SRC;
      const pyScript = `${common}
(async()=>{let out="",err="";try{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";await new Promise((r,j)=>{s.onload=r;s.onerror=()=>j(new Error("Pyodide 로드 실패 (네트워크 확인)"))});document.head.appendChild(s);
const py=await loadPyodide();py.setStdout({batched:l=>{out+=l+"\\n"}});py.setStderr({batched:l=>{err+=l+"\\n"}});
const ROOT="/vfs";const mk=d=>{let c="";d.split("/").filter(Boolean).forEach(s=>{c+="/"+s;try{py.FS.mkdir(c)}catch(e){}})};mk(ROOT);
Object.keys(P.files).forEach(p=>{mk(ROOT+p.split("/").slice(0,-1).join("/"));py.FS.writeFile(ROOT+p,P.files[p])});mk(ROOT+P.cwd);py.FS.chdir(ROOT+P.cwd);
if(P.pipPkgs.length){try{await py.loadPackage("micropip");const mp=py.pyimport("micropip");for(const n of P.pipPkgs){try{await py.loadPackage(n)}catch(e){try{await mp.install(n)}catch(e2){err+="pip: '"+n+"' 로드 실패 ("+e2.message.split("\\n")[0]+")\\n"}}}}catch(e){}}
py.globals.set("__args",P.args);await py.runPythonAsync("import sys\\nsys.argv=list(__args)");
let code=0;try{await py.runPythonAsync(P.code)}catch(e){err+=String(e.message||e).split("\\n").slice(-6).join("\\n")+"\\n";code=1}
const changed={};const walk=d=>{py.FS.readdir(d).forEach(n=>{if(n==="."||n==="..")return;const f=d+"/"+n;const st=py.FS.stat(f);if(py.FS.isDir(st.mode))walk(f);else{try{const t=py.FS.readFile(f,{encoding:"utf8"});const key=f.slice(ROOT.length);if(P.files[key]!==t)changed[key]=t}catch(e){}}})};walk(ROOT);post({out,err,code,changed})}catch(e){post({out,err:err+String(e&&e.message||e)+"\\n",code:1,changed:{}})}})();`;
      frame.srcdoc = `<!doctype html><html><body><script>${kind === "python" ? pyScript : nodeScript}<\/script></body></html>`;
      document.body.appendChild(frame);
    });
  }
  async function runInterpreter(kind, a, io){
    let code, args, rest = a;
    // 스크립트 이름 뒤의 옵션(--say 등)은 스크립트 인자이므로 해석하지 않는다
    if(a.length && /^-[ce]$|^--eval$|^--command$/.test(a[0]) && a.length > 1){ code = a[1]; args = [a[0]].concat(a.slice(2)); }
    else if(a.length && /^-[ce]./.test(a[0])){ code = a[0].slice(2); args = [a[0].slice(0, 2)].concat(a.slice(1)); }
    else if(a.length && /^-/.test(a[0]) && a[0] !== "-"){ rest = a.slice(1); if(!rest.length) return E(io, kind, "실행할 스크립트 파일이 필요해요"); const t = getText(io, kind, rest[0]); if(t == null) return 2; code = t; args = rest; }
    else if(rest.length){ const t = getText(io, kind, rest[0]); if(t == null) return 2; code = t; args = rest; }
    else if(io.stdin){ code = io.stdin; args = ["-"]; }
    else return E(io, kind, "실행할 스크립트 파일이나 -c '코드' 가 필요해요");
    await firstUse(kind);
    const r = await runSandbox(kind, code, args, kind === "python" ? 120000 : 60000);
    io.out += r.out; io.err += r.err;
    Object.keys(r.changed || {}).forEach(p => { try{ FS.writeFile(p, r.changed[p]); }catch(e){ io.err += `(파일 저장 실패 ${p}: ${e.message})\n`; } });
    return r.code;
  }
  def(["python", "python3"], "Python 실행 (Pyodide/WebAssembly, 격리 샌드박스)", (a, io) => runInterpreter("python", a, io));
  def(["node", "nodejs"], "JavaScript 실행 (격리 샌드박스, fs/path 지원)", (a, io) => runInterpreter("node", a, io));


  /* ======================= HTML 미리보기 / 실제 테스트 (htmltest, jscheck) =======================
     격리 iframe(sandbox="allow-scripts", same-origin 없음)에서 HTML 을 실제로 실행해 보고
     콘솔 로그/에러, 캔버스 그려짐 여부, 키 입력 후 상태, 임의 JS 식 결과를 돌려준다. */
  function buildPreviewHtml(path){
    const st = statOf(path); if(!st || st.type !== "file") throw new Error(`${path}: ${NOFILE}`);
    let html = String(st.content || ""); const dir = st.path.slice(0, st.path.lastIndexOf("/")) || "/";
    const readRel = src => { if(/^(https?:)?\/\//.test(src) || /^data:/.test(src)) return null; const p = FS.normPath(src.startsWith("/") ? src : (dir === "/" ? "" : dir) + "/" + src); const s = statOf(p); return s && s.type === "file" ? String(s.content || "") : null; };
    html = html.replace(/<script([^>]*?)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => { const t = readRel(src); return t == null ? m : `<script${a}${b}>${t.replace(/<\/script/gi, "<\\/script")}<\/script>`; });
    html = html.replace(/<link([^>]*?)href=["']([^"']+\.css)["']([^>]*)>/gi, (m, a, href, b) => { if(!/stylesheet/i.test(a + b)) return m; const t = readRel(href); return t == null ? m : `<style>${t}</style>`; });
    return html;
  }
  function runHtmlTest(html, o){
    return new Promise(resolve => {
      const id = "ht" + Math.random().toString(36).slice(2);
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.style.cssText = "position:fixed;left:-9999px;top:0;width:" + (o.w || 800) + "px;height:" + (o.h || 600) + "px;border:0;";
      let done = false; const finish = r => { if(done) return; done = true; window.removeEventListener("message", onMsg); clearTimeout(timer); frame.remove(); resolve(r); };
      const timer = setTimeout(() => finish({ timeout:true, logs:[], errors:["테스트 시간 초과"], evals:[], canvases:[], dom:{} }), (o.ms || 1500) + (o.keys.length * 350) + 6000);
      const onMsg = ev => { if(ev.source !== frame.contentWindow || !ev.data || ev.data.id !== id) return; if(ev.data.type === "ready") frame.contentWindow.postMessage({ id, cmd:"run", keys:o.keys, evals:o.evals, ms:o.ms || 1500 }, "*"); else if(ev.data.type === "report") finish(ev.data.report); };
      window.addEventListener("message", onMsg);
      const probe = `<script>(function(){var ID=${JSON.stringify(id)},L=[],ER=[];function s(a){try{return typeof a==="string"?a:JSON.stringify(a)}catch(e){return String(a)}}
["log","info","warn","error"].forEach(function(t){var o=console[t];console[t]=function(){var m=[].slice.call(arguments).map(s).join(" ");(t==="error"?ER:L).push((t==="log"?"":t+": ")+m);try{o.apply(console,arguments)}catch(e){}}});
window.addEventListener("error",function(e){ER.push("에러: "+e.message+(e.lineno?" (줄 "+e.lineno+")":""))});window.addEventListener("unhandledrejection",function(e){ER.push("처리되지 않은 Promise 오류: "+s(e.reason&&e.reason.message||e.reason))});
window.addEventListener("message",function(ev){var d=ev.data;if(!d||d.id!==ID||d.cmd!=="run")return;var sleep=function(t){return new Promise(function(r){setTimeout(r,t)})};
(async function(){await sleep(d.ms);var tgt=[document.activeElement,document.body,document,window];
for(var i=0;i<d.keys.length;i++){var k=d.keys[i];["keydown","keyup"].forEach(function(t){tgt.forEach(function(x){try{x.dispatchEvent(new KeyboardEvent(t,{key:k==="Space"?" ":k,code:k==="Space"?"Space":(k.length===1?"Key"+k.toUpperCase():k),bubbles:true}))}catch(e){}})});await sleep(300)}
var ev2=[];for(var j=0;j<d.evals.length;j++){try{ev2.push({expr:d.evals[j],value:s((0,eval)(d.evals[j]))})}catch(e){ev2.push({expr:d.evals[j],error:String(e&&e.message||e)})}}
var cv=[].slice.call(document.querySelectorAll("canvas")).map(function(c){var r={w:c.width,h:c.height,drawn:null};try{var x=c.getContext("2d");if(x&&c.width&&c.height){var im=x.getImageData(0,0,c.width,c.height).data,n=0,step=Math.max(1,Math.floor(im.length/4/4000))*4;for(var p=3;p<im.length;p+=step)if(im[p]>0)n++;r.drawn=Math.round(n/(im.length/step)*100)}}catch(e){r.drawn="?"}return r});
var q=function(t){return document.querySelectorAll(t).length};
parent.postMessage({id:ID,type:"report",report:{logs:L.slice(0,60),errors:ER.slice(0,30),evals:ev2,canvases:cv,dom:{title:document.title,canvas:q("canvas"),buttons:q("button"),inputs:q("input,textarea,select"),text:(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim().slice(0,240)}}},"*")})()});
window.addEventListener("load",function(){parent.postMessage({id:ID,type:"ready"},"*")});})()<\/script>`;
      let doc = html; doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, m => m + probe) : probe + doc;
      frame.srcdoc = doc; document.body.appendChild(frame);
    });
  }
  def("htmltest", "HTML 실제 실행 테스트: htmltest 파일.html [-t 대기ms] [-k 키,키] [-e 'JS식'] — 에러/콘솔/캔버스/DOM 보고", async (a, io) => {
    const { v, rest } = opts(a, "tke", ["time", "keys", "eval"]); if(!rest.length) return E(io, "htmltest", "usage: htmltest file.html [-t ms] [-k ArrowLeft,Space] [-e 'expr']");
    let html; try{ html = buildPreviewHtml(rest[0]); }catch(e){ return E(io, "htmltest", e.message); }
    const evals = [].concat(v.e || v.eval || []); const keys = String(v.k || v.keys || "").split(",").map(x => x.trim()).filter(Boolean);
    const r = await runHtmlTest(html, { ms: Math.min(8000, +(v.t || v.time) || 1500), keys, evals });
    const bad = r.errors.length > 0; io.out += `[htmltest] ${rest[0]} — ${bad ? "❌ 오류 " + r.errors.length + "건" : "✅ 실행 오류 없음"}${r.timeout ? " (시간 초과)" : ""}\n`;
    if(r.dom) io.out += `제목: ${r.dom.title || "(없음)"} · canvas ${r.dom.canvas} · button ${r.dom.buttons} · input ${r.dom.inputs}\n`;
    (r.canvases || []).forEach((c, i) => { io.out += `canvas#${i + 1} ${c.w}x${c.h} — ${c.drawn === null ? "2D 컨텍스트 아님" : c.drawn === "?" ? "확인 불가" : c.drawn + "% 픽셀에 그려짐" + (c.drawn === 0 ? " ⚠ 아무것도 안 그려짐" : "")}\n`; });
    if(r.dom && r.dom.text) io.out += `화면 텍스트: ${r.dom.text}\n`;
    r.evals.forEach(e => { io.out += `eval ${e.expr} → ${e.error ? "오류: " + e.error : e.value}\n`; });
    if(r.logs.length) io.out += "콘솔:\n" + r.logs.map(l => "  " + l).join("\n") + "\n"; if(r.errors.length) io.out += "오류:\n" + r.errors.map(l => "  " + l).join("\n") + "\n";
    return bad ? 1 : 0;
  });
  def("jscheck", "JS 문법 검사 (실행 안 함): jscheck 파일.js|파일.html", (a, io) => {
    if(!a.length) return E(io, "jscheck", "파일 필요"); let bad = 0;
    a.forEach(p => { const t = getText(io, "jscheck", p); if(t == null){ bad = 1; return; }
      const chunks = /\.html?$/i.test(p) ? [...t.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/type=["']?(module|application\/json|text\/template)/i.test(m[1])).map(m => m[2]) : [t];
      chunks.forEach((c, i) => { try{ new Function(c); io.out += `${p}${chunks.length > 1 ? "#script" + (i + 1) : ""}: 문법 OK\n`; }catch(e){ bad = 1; io.out += `${p}${chunks.length > 1 ? "#script" + (i + 1) : ""}: ❌ ${e.message}\n`; } }); });
    return bad;
  });
  S.buildPreviewHtml = buildPreviewHtml; S.getBytes = getBytes;

  /* ======================= git (최소 구현) ======================= */
  function repoRoot(){ let p = FS.pwd(); for(;;){ if(FS.isFile(joinP(p === "/" ? "" : p, ".git/choimini.json").replace(/^\/\//, "/"))) return p; if(p === "/") return null; p = FS.parentOf(p) || "/"; } }
  function repoFile(root){ return (root === "/" ? "" : root) + "/.git/choimini.json"; }
  function loadRepo(root){ return JSON.parse(FS.readFile(repoFile(root))); }
  function workFiles(root){ const o = {}; FS.find(root).forEach(p => { const st = statOf(p); if(st && st.type === "file" && !p.includes("/.git/")) o[p.slice(root === "/" ? 1 : root.length + 1)] = String(st.content); }); return o; }
  def("git", "간단한 git (init/add/commit/status/log/branch/diff --stat) — 원격(clone/push/pull) 미지원", (a, io) => {
    const sub = a[0]; const args = a.slice(1);
    if(sub === "init"){ const root = FS.pwd(); if(FS.isFile(repoFile(root))){ io.out += "Reinitialized existing repository\n"; return 0; } FS.writeFile(repoFile(root), JSON.stringify({ branch:"main", staged:{}, commits:[] })); io.out += `Initialized empty repository in ${root}/.git/\n`; return 0; }
    const root = repoRoot(); if(!root) return E(io, "git", "fatal: not a git repository (git init 먼저)");
    const repo = loadRepo(root); const save = () => FS.writeFile(repoFile(root), JSON.stringify(repo)); const work = workFiles(root);
    const last = repo.commits[repo.commits.length - 1]; const base = last ? last.files : {};
    if(sub === "add"){ const targets = args.filter(x => x[0] !== "-"); const all = targets.includes(".") || args.includes("-A"); Object.keys(work).forEach(f => { if(all || targets.some(t => f === t.replace(/^\.\//, "") || f.startsWith(t.replace(/\/$/, "") + "/"))) repo.staged[f] = work[f]; }); Object.keys(base).forEach(f => { if(!(f in work) && all) repo.staged[f] = null; }); save(); return 0; }
    if(sub === "commit"){ const mi = args.indexOf("-m"); const msg = mi >= 0 ? args[mi + 1] : null; if(!msg) return E(io, "git", "커밋 메시지(-m)가 필요해요"); if(args.includes("-a")) Object.keys(work).forEach(f => { if(f in base) repo.staged[f] = work[f]; });
      if(!Object.keys(repo.staged).length) { io.out += "nothing to commit\n"; return 1; } const files = Object.assign({}, base); Object.keys(repo.staged).forEach(f => { if(repo.staged[f] == null) delete files[f]; else files[f] = repo.staged[f]; });
      const id = Math.random().toString(16).slice(2, 9); repo.commits.push({ id, msg, ts: Date.now(), files }); io.out += `[${repo.branch} ${id}] ${msg}\n ${Object.keys(repo.staged).length} file(s) changed\n`; repo.staged = {}; save(); return 0; }
    if(sub === "status"){ const mod = [], neu = [], del = []; Object.keys(work).forEach(f => { if(!(f in base)) neu.push(f); else if(base[f] !== work[f]) mod.push(f); }); Object.keys(base).forEach(f => { if(!(f in work)) del.push(f); });
      const st = Object.keys(repo.staged); io.out += `On branch ${repo.branch}\n`; if(st.length) io.out += "Changes to be committed:\n" + st.map(f => `\t${repo.staged[f] == null ? "deleted" : "staged"}: ${f}`).join("\n") + "\n";
      const un = mod.filter(f => !(f in repo.staged) || repo.staged[f] !== work[f]); if(un.length) io.out += "Changes not staged:\n" + un.map(f => "\tmodified: " + f).join("\n") + "\n"; const ut = neu.filter(f => !(f in repo.staged)); if(ut.length) io.out += "Untracked files:\n" + ut.map(f => "\t" + f).join("\n") + "\n"; if(del.length) io.out += "Deleted:\n" + del.map(f => "\t" + f).join("\n") + "\n"; if(!st.length && !un.length && !ut.length && !del.length) io.out += "nothing to commit, working tree clean\n"; return 0; }
    if(sub === "log"){ const one = args.includes("--oneline"); io.out += nl(repo.commits.slice().reverse().map(c => one ? `${c.id} ${c.msg}` : `commit ${c.id}\nDate:   ${new Date(c.ts).toString()}\n\n    ${c.msg}\n`)); return 0; }
    if(sub === "branch"){ io.out += `* ${repo.branch}\n`; return 0; }
    if(sub === "diff"){ Object.keys(work).forEach(f => { if(!(f in base)) io.out += `new file: ${f}\n`; else if(base[f] !== work[f]) io.out += `modified: ${f}\n`; }); Object.keys(base).forEach(f => { if(!(f in work)) io.out += `deleted: ${f}\n`; }); return 0; }
    return E(io, "git", `'${sub}' 는 지원하지 않아요 (지원: init add commit status log branch diff). clone/push/pull 같은 원격 작업은 브라우저 안에서 불가능해요`);
  });

  /* ======================= 마무리: /cmds 동기화 ======================= */
  S.syncCmdsDir();
})(window);
