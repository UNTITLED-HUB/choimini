/* ============================================================================
   choimini-shell.js  —  WORK / CODE 모드용 셸 코어 (runcmd)
   ----------------------------------------------------------------------------
   - 특정 명령어 몇 개만 고정 제공하지 않는다. 명령어는 "레지스트리"에 def()로 등록되고,
     /cmds 폴더의 실제 항목(사용자/AI가 추가한 스크립트·별칭)과 합쳐져 "현재 사용 가능한 목록"이 된다.
   - AI는 which / type / whereis / compgen -c / cmds 로 언제든 목록을 다시 조회할 수 있다.
   - 파이프(|), 리다이렉션(> >> <), 체인(; && ||), 변수($VAR), 명령 치환($(...)),
     글롭(*, ?), 히어독(<<EOF)을 지원한다.
   - 전부 브라우저 안 가상 Linux_Local 에서만 실행된다 (실제 OS 접근 없음).
   명령어 구현은 choimini-shell-cmds.js 에 있다.
   ============================================================================ */
(function(global){
  "use strict";
  const FS = global.LinuxFS;
  if(!FS){ console.warn("[ChoiminiShell] LinuxFS 없음"); return; }

  const REG = Object.create(null);           // name -> { fn, desc, group }
  const ENV = { HOME:"/user", USER:"user", LOGNAME:"user", SHELL:"/cmds/sh", PATH:"/cmds", LANG:"ko_KR.UTF-8", TERM:"xterm", HOSTNAME:"linux-local" };
  const MAX_DEPTH = 8;                       // 스크립트/별칭 재귀 상한
  const MAX_OUT = 200000;
  let lastCode = 0;

  function def(names, desc, fn, group){
    (Array.isArray(names) ? names : [names]).forEach(n => { REG[n] = { fn, desc, group: group || "core" }; });
  }

  /* ---------------- 명령어 탐색 (동적) ---------------- */
  function cmdFileNames(){
    try{ return FS.dirChildren("/cmds").filter(n => FS.isFile("/cmds/" + n)); }catch(e){ return []; }
  }
  // /cmds 안의 항목 중 "내장 메타"가 아닌 것(=사용자/AI가 추가한 스크립트·별칭)
  function customCmd(name){
    if(!/^[\w.+-]+$/.test(name)) return null;
    const st = FS.stat("/cmds/" + name);
    if(!st || st.type !== "file") return null;
    const c = String(st.content || "");
    try{
      const j = JSON.parse(c);
      if(j && typeof j === "object"){
        if(j.builtin) return null;
        if(j.alias) return { kind:"alias", body:String(j.alias), desc:j.desc || "alias" };
        if(j.script) return { kind:"script", body:String(j.script), desc:j.desc || "script" };
        return null;
      }
    }catch(e){}
    if(!c.trim()) return null;
    return { kind:"script", body:c, desc:"script" };
  }
  function list(){
    const set = new Set(Object.keys(REG));
    cmdFileNames().forEach(n => { if(customCmd(n)) set.add(n); });
    return Array.from(set).sort();
  }
  function resolve(name){
    if(REG[name]) return { kind:"builtin", name, desc:REG[name].desc, path:"/cmds/" + name };
    const c = customCmd(name);
    if(c) return Object.assign({ name, path:"/cmds/" + name }, c);
    return null;
  }
  // /cmds 에 내장 명령어 메타데이터 파일을 만들어 둔다(없을 때만) → "Linux_Local/cmds 에 있는 명령어" 구조 유지
  function syncCmdsDir(){
    const seed = {};
    Object.keys(REG).forEach(n => { seed["/cmds/" + n] = JSON.stringify({ name:n, builtin:true, desc:REG[n].desc, group:REG[n].group }); });
    try{ FS.seedFiles(seed); }catch(e){ console.warn("[ChoiminiShell] /cmds 동기화 실패", e); }
  }

  /* ---------------- 토크나이저 ---------------- */
  function isWild(s){ return /[*?]/.test(s); }
  function tokenize(line){
    const toks = []; let cur = "", has = false, wild = false, i = 0;
    const push = () => { if(has){ toks.push({ t:"w", v:cur, glob: wild }); } cur = ""; has = false; wild = false; };
    const varAt = (str, at) => {           // str[at] === "$"
      let m = /^\$\{(\w+)(?::-([^}]*))?\}/.exec(str.slice(at));
      if(m) return { v: (ENV[m[1]] != null && ENV[m[1]] !== "") ? ENV[m[1]] : (m[2] || ""), n: m[0].length };
      m = /^\$(\?|\w+)/.exec(str.slice(at));
      if(m){ return { v: m[1] === "?" ? String(lastCode) : (ENV[m[1]] || ""), n: m[0].length }; }
      return { v:"$", n:1 };
    };
    while(i < line.length){
      const c = line[i];
      if(c === "'"){ i++; while(i < line.length && line[i] !== "'") cur += line[i++]; i++; has = true; continue; }
      if(c === '"'){
        i++;
        while(i < line.length && line[i] !== '"'){
          if(line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i+1])){ cur += line[i+1]; i += 2; continue; }
          if(line[i] === "$"){ const r = varAt(line, i); cur += r.v; i += r.n; continue; }
          cur += line[i++];
        }
        i++; has = true; continue;
      }
      if(c === "\\"){ cur += line[i+1] != null ? line[i+1] : ""; i += 2; has = true; continue; }
      if(c === "$"){ const r = varAt(line, i); cur += r.v; i += r.n; has = true; continue; }
      if(c === "#" && !has){ break; }
      if(/\s/.test(c)){ push(); i++; continue; }
      if(c === "&" && line[i+1] === "&"){ push(); toks.push({ t:"op", v:"&&" }); i += 2; continue; }
      if(c === "|" && line[i+1] === "|"){ push(); toks.push({ t:"op", v:"||" }); i += 2; continue; }
      if(c === ";" || c === "|"){ push(); toks.push({ t:"op", v:c }); i++; continue; }
      if(c === "2" && line[i+1] === ">" && !has){                        // 2> , 2>&1
        if(line.slice(i, i+4) === "2>&1"){ toks.push({ t:"op", v:"2>&1" }); i += 4; continue; }
        if(line[i+2] === ">"){ toks.push({ t:"op", v:"2>>" }); i += 3; } else { toks.push({ t:"op", v:"2>" }); i += 2; }
        continue;
      }
      if(c === ">"){ push(); if(line[i+1] === ">"){ toks.push({ t:"op", v:">>" }); i += 2; } else { toks.push({ t:"op", v:">" }); i++; } continue; }
      if(c === "<"){ push(); toks.push({ t:"op", v:"<" }); i++; continue; }
      if(c === "~" && !has && (i + 1 >= line.length || /[\s/]/.test(line[i+1]))){ cur += ENV.HOME; has = true; i++; continue; }
      if(c === "*" || c === "?") wild = true;
      cur += c; has = true; i++;
    }
    push();
    return toks;
  }

  // 글롭 확장: 디렉터리 한 단계씩 * ? 매칭 (경로 세그먼트 단위)
  function globToRe(g){ return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); }
  function expandGlob(pat){
    const abs = pat.startsWith("/");
    const segs = pat.split("/").filter(s => s !== "");
    let bases = [abs ? "/" : ""];
    for(const seg of segs){
      const next = [];
      for(const b of bases){
        if(!isWild(seg)){ next.push(b === "" ? seg : (b === "/" ? "/" + seg : b + "/" + seg)); continue; }
        let names = [];
        try{ names = FS.dirChildren(b === "" ? "." : b); }catch(e){}
        const re = globToRe(seg);
        names.filter(n => re.test(n) && (seg.startsWith(".") || !n.startsWith("."))).forEach(n => next.push(b === "" ? n : (b === "/" ? "/" + n : b + "/" + n)));
      }
      bases = next;
    }
    const found = bases.filter(p => FS.exists(p));
    return found.length ? found.sort() : [pat];
  }

  /* ---------------- 명령 치환 $(...) (토크나이즈 전에 처리) ---------------- */
  async function substitute(line, depth){
    if(line.indexOf("$(") < 0) return line;
    let out = "", i = 0, inSingle = false;
    while(i < line.length){
      const c = line[i];
      if(c === "'"){ inSingle = !inSingle; out += c; i++; continue; }
      if(!inSingle && c === "$" && line[i+1] === "("){
        let d = 1, j = i + 2;
        while(j < line.length && d > 0){ if(line[j] === "(") d++; else if(line[j] === ")") d--; j++; }
        const inner = line.slice(i + 2, j - 1);
        const r = await runLine(inner, depth + 1, null);
        out += r.out.replace(/\n+$/, "");
        i = j; continue;
      }
      out += c; i++;
    }
    return out;
  }

  /* ---------------- 파싱: 리스트 → 파이프라인 → 명령 ---------------- */
  function parseTokens(toks){
    const list = []; let pipeline = [], cmd = { argv:[], redirs:[] }, sep = null;
    const endCmd = () => { if(cmd.argv.length || cmd.redirs.length) pipeline.push(cmd); cmd = { argv:[], redirs:[] }; };
    const endPipe = (nextSep) => { endCmd(); if(pipeline.length) list.push({ pipeline, sep }); pipeline = []; sep = nextSep; };
    for(let k = 0; k < toks.length; k++){
      const t = toks[k];
      if(t.t === "op"){
        if(t.v === "|"){ endCmd(); continue; }
        if(t.v === ";" || t.v === "&&" || t.v === "||"){ endPipe(t.v); continue; }
        if(t.v === "2>&1"){ cmd.redirs.push({ op:"2>&1" }); continue; }
        const target = toks[k+1];
        if(!target || target.t !== "w") throw new Error("문법 오류: 리다이렉션 대상 없음");
        cmd.redirs.push({ op:t.v, target:target.v }); k++; continue;
      }
      if(t.glob) cmd.argv.push({ glob:true, v:t.v }); else cmd.argv.push({ v:t.v });
    }
    endPipe(null);
    return list;
  }

  /* ---------------- 실행 ---------------- */
  function makeIO(stdin){ return { stdin: stdin == null ? "" : stdin, out:"", err:"" }; }
  function abspath(p){ return FS.abs(p); }

  async function runSimple(cmdSpec, stdin, depth){
    const argv = [];
    cmdSpec.argv.forEach(a => { if(a.glob) expandGlob(a.v).forEach(x => argv.push(x)); else argv.push(a.v); });
    const io = makeIO(stdin);
    // 리다이렉션 입력 처리
    for(const r of cmdSpec.redirs){ if(r.op === "<"){ try{ io.stdin = String(FS.readFile(r.target)); }catch(e){ io.err += `sh: ${r.target}: No such file or directory\n`; return { io, code:1, redirs:cmdSpec.redirs }; } } }
    let code = 0;
    if(!argv.length){ return { io, code:0, redirs:cmdSpec.redirs }; }
    // VAR=value 단독 대입
    if(argv.every(a => /^\w+=/.test(a))){ argv.forEach(a => { const i = a.indexOf("="); ENV[a.slice(0,i)] = a.slice(i+1); }); return { io, code:0, redirs:cmdSpec.redirs }; }
    const name = argv[0], args = argv.slice(1);
    const r = resolve(name);
    if(!r){
      io.err += `sh: ${name}: command not found\n`;
      const hint = suggest(name);
      if(hint) io.err += hint + "\n";
      return { io, code:127, redirs:cmdSpec.redirs };
    }
    try{
      if(r.kind === "builtin"){
        const ret = await REG[name].fn(args, io, { name, depth, env:ENV, run: (l) => runLine(l, depth + 1, null) });
        code = typeof ret === "number" ? ret : 0;
      } else if(r.kind === "alias"){
        const sub = await runLine(r.body + " " + args.map(quote).join(" "), depth + 1, io.stdin);
        io.out += sub.out; io.err += sub.err; code = sub.code;
      } else {
        const sub = await runScript(r.body, args, depth + 1, io.stdin);
        io.out += sub.out; io.err += sub.err; code = sub.code;
      }
    }catch(e){
      io.err += `${name}: ${(e && e.message) || e}\n`; code = code || 1;
    }
    return { io, code, redirs:cmdSpec.redirs };
  }
  function quote(s){ return /^[\w./=:@%+,-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  // 없는 명령어면: 비슷한 이름 / 설치 안내
  function suggest(name){
    const l = list();
    const near = l.filter(n => n.startsWith(name.slice(0, 2)) && Math.abs(n.length - name.length) <= 2).slice(0, 5);
    let s = `힌트: 'which ${name}' 또는 'cmds' 로 사용 가능한 명령어를 확인하세요. 필요한 도구라면 'pkg install <패키지>' / 'pip install' / 'npm install' 로 설치할 수 있어요.`;
    if(near.length) s = `비슷한 명령어: ${near.join(", ")}\n` + s;
    return s;
  }

  function writeRedirect(op, target, text){
    const p = abspath(target);
    if(op === ">>" || op === "2>>"){
      let prev = "";
      try{ if(FS.isFile(p)) prev = String(FS.readFile(p)); }catch(e){}
      FS.writeFile(p, prev + text);
    } else {
      FS.writeFile(p, text);
    }
  }

  async function runPipeline(pl, depth, stdin0){
    let stdin = stdin0, errAll = "", code = 0, outFinal = "";
    for(let i = 0; i < pl.length; i++){
      const res = await runSimple(pl[i], stdin, depth);
      let out = res.io.out, err = res.io.err;
      code = res.code;
      // 리다이렉션 적용
      const merge = res.redirs.some(r => r.op === "2>&1");
      if(merge){ out += err; err = ""; }
      for(const r of res.redirs){
        try{
          if(r.op === ">" || r.op === ">>"){ writeRedirect(r.op, r.target, out); out = ""; }
          else if(r.op === "2>" || r.op === "2>>"){ if(r.target !== "/dev/null") writeRedirect(r.op, r.target, err); err = ""; }
        }catch(e){ err += `sh: ${r.target}: ${e.message}\n`; code = 1; }
      }
      errAll += err;
      if(i < pl.length - 1){ stdin = out; } else { outFinal = out; }
    }
    return { out: outFinal, err: errAll, code };
  }

  // 따옴표/괄호를 존중하며 ; && || 로 문장을 나눈다 (변수·명령 치환은 각 문장을 "실행하기 직전"에 처리해야
  // `export A=5; echo $A` 같은 한 줄 체인이 올바르게 동작한다)
  function splitStatements(line){
    const out = []; let cur = "", q = null, par = 0, sep = null;
    const flush = next => { out.push({ text: cur, sep }); cur = ""; sep = next; };
    for(let i = 0; i < line.length; i++){
      const c = line[i];
      if(q){ cur += c; if(c === "\\" && q === '"'){ cur += line[++i] || ""; } else if(c === q) q = null; continue; }
      if(c === "\\"){ cur += c + (line[++i] || ""); continue; }
      if(c === "'" || c === '"'){ q = c; cur += c; continue; }
      if(c === "$" && line[i+1] === "("){ par++; cur += "$("; i++; continue; }
      if(par > 0){ if(c === "(") par++; else if(c === ")") par--; cur += c; continue; }
      if(c === "#" && (cur === "" || /\s$/.test(cur))){ break; }
      if(c === ";"){ flush(";"); continue; }
      if(c === "&" && line[i+1] === "&"){ flush("&&"); i++; continue; }
      if(c === "|" && line[i+1] === "|"){ flush("||"); i++; continue; }
      cur += c;
    }
    out.push({ text: cur, sep });
    return out.filter(x => x.text.trim() !== "");
  }

  async function runLine(line, depth, stdin){
    depth = depth || 0;
    if(depth > MAX_DEPTH) return { out:"", err:"sh: 재귀 깊이 초과\n", code:1 };
    let out = "", err = "", code = 0, first = true;
    for(const st of splitStatements(line)){
      if(!first){
        if(st.sep === "&&" && lastCode !== 0) continue;
        if(st.sep === "||" && lastCode === 0) continue;
      }
      first = false;
      let items;
      try{ items = parseTokens(tokenize(await substitute(st.text, depth))); }
      catch(e){ err += `sh: ${e.message}\n`; code = 2; lastCode = 2; continue; }
      for(const it of items){
        const r = await runPipeline(it.pipeline, depth, stdin);
        out += r.out; err += r.err; code = r.code; lastCode = r.code; stdin = null;
      }
      if(out.length > MAX_OUT){ err += "sh: 출력이 너무 커서 잘림\n"; out = out.slice(0, MAX_OUT); break; }
    }
    return { out, err, code };
  }

  // 여러 줄(스크립트). 히어독 지원. 위치 인자 $1.. $@ $# 치환.
  async function runScript(text, args, depth, stdin){
    const saved = {};
    ["@","#","0"].concat(args.map((_, i) => String(i + 1))).forEach(k => { saved[k] = ENV[k]; });
    args.forEach((a, i) => { ENV[String(i + 1)] = a; });
    ENV["@"] = args.join(" "); ENV["#"] = String(args.length); ENV["0"] = "script";
    const lines = String(text).replace(/\r/g, "").split("\n");
    let out = "", err = "", code = 0;
    for(let n = 0; n < lines.length; n++){
      let line = lines[n];
      if(n === 0 && line.startsWith("#!")) continue;
      let hereIn = stdin;
      const hm = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(line);
      if(hm){
        const word = hm[2], body = [];
        n++;
        while(n < lines.length && lines[n].trim() !== word){ body.push(lines[n]); n++; }
        hereIn = body.join("\n") + (body.length ? "\n" : "");
        if(hm[1] !== "'" && hm[1] !== '"'){
          hereIn = hereIn.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => ENV[a || b] != null ? ENV[a || b] : "");
        }
        line = line.replace(hm[0], "");
      }
      if(!line.trim()) continue;
      const r = await runLine(line, depth, hereIn);
      out += r.out; err += r.err; code = r.code;
      if(out.length > MAX_OUT) break;
    }
    Object.keys(saved).forEach(k => { if(saved[k] == null) delete ENV[k]; else ENV[k] = saved[k]; });
    return { out, err, code };
  }

  // 외부 진입점 : AI 의 runcmd 한 번 호출
  async function run(command){
    const r = await runScript(String(command), [], 0, null);
    let output = r.out;
    if(r.err) output += (output && !output.endsWith("\n") ? "\n" : "") + r.err;
    return { output: output.replace(/\n+$/, ""), code: r.code, stdout: r.out, stderr: r.err };
  }

  global.ChoiminiShell = { def, run, runLine, runScript, list, resolve, syncCmdsDir, env: ENV, registry: REG, quote, tokenize };
})(window);
