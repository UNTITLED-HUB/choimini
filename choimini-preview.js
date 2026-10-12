/* choimini-preview.js — 통합 파일 미리보기 엔진
   ChoiminiPreview.render(host, { name, size?, bytes? | load?(limit, onProgress) → Uint8Array })
   · 어떤 파일이든: [미리보기] [텍스트] [Hex] 탭. 바이너리도 '텍스트' 탭에서 글자만 뽑아 볼 수 있다.
   · 동영상/오디오/이미지/PDF/마크다운/CSV/JSON/ZIP·APK·docx·xlsx·pptx·epub·tar·gz 지원, 압축 파일은 안쪽 파일도 열어 본다.
   · SandBox(LinuxFS) 파일과 Local(실제 컴퓨터) 파일이 같은 엔진을 쓴다.
   · 모든 텍스트는 줄바꿈(wrap)하고, 안내 문구는 한 줄로 짧게 쓴다. */
(function(){
  "use strict";
  const MAX_FULL = 150 * 1024 * 1024;   // 이보다 큰 파일은 앞부분만 읽어 Hex/텍스트로 본다
  const HEAD = 256 * 1024;
  const TEXT_CAP = 2 * 1024 * 1024;     // 텍스트 탭에 한 번에 보여 줄 최대 바이트
  const HEX_PAGE = 64 * 1024;

  const EXT = {
    image: "png jpg jpeg gif webp bmp ico avif svg",
    video: "mp4 m4v webm mov mkv ogv avi 3gp",
    audio: "mp3 wav ogg oga m4a aac flac opus weba",
    pdf: "pdf",
    md: "md markdown mdx",
    csv: "csv tsv",
    json: "json jsonl ndjson geojson",
    zip: "zip apk jar aab war whl xpi docx xlsx pptx odt ods odp epub xapk apks",
    gz: "gz tgz",
    tar: "tar"
  };
  const EXTMAP = {}; Object.keys(EXT).forEach(k => EXT[k].split(" ").forEach(e => EXTMAP[e] = k));
  const MIME = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", bmp:"image/bmp", ico:"image/x-icon", avif:"image/avif", svg:"image/svg+xml",
    mp4:"video/mp4", m4v:"video/mp4", webm:"video/webm", mov:"video/mp4", mkv:"video/webm", ogv:"video/ogg", "3gp":"video/3gpp", avi:"video/x-msvideo",
    mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", oga:"audio/ogg", m4a:"audio/mp4", aac:"audio/aac", flac:"audio/flac", opus:"audio/ogg", weba:"audio/webm", pdf:"application/pdf" };
  const KIND_LABEL = { image:"이미지", video:"동영상", audio:"오디오", pdf:"PDF", md:"마크다운", csv:"표(CSV)", json:"JSON", zip:"압축 파일", gz:"gzip", tar:"tar", text:"텍스트", bin:"바이너리" };

  const ext = n => { const m = /\.([A-Za-z0-9]+)$/.exec(String(n || "")); return m ? m[1].toLowerCase() : ""; };
  const base = n => String(n || "").split(/[\\/]/).pop();
  const fmt = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  function el(tag, cls, txt){ const e = document.createElement(tag); if(cls) e.className = cls; if(txt != null) e.textContent = txt; return e; }
  const startsWith = (u, sig, off) => { off = off || 0; if(u.length < off + sig.length) return false; for(let i = 0; i < sig.length; i++) if(u[off + i] !== sig[i]) return false; return true; };
  const ascii = s => Array.from(s, c => c.charCodeAt(0));

  /* ---------------- 종류 판별 (확장자 우선, 없으면 파일 머리말) ---------------- */
  function sniff(u){
    if(startsWith(u, [0x89, 0x50, 0x4E, 0x47]) || startsWith(u, ascii("GIF8")) || startsWith(u, [0xFF, 0xD8, 0xFF]) || (startsWith(u, ascii("RIFF")) && startsWith(u, ascii("WEBP"), 8)) || startsWith(u, ascii("BM"))) return "image";
    if(startsWith(u, ascii("%PDF"))) return "pdf";
    if(startsWith(u, [0x50, 0x4B, 3, 4]) || startsWith(u, [0x50, 0x4B, 5, 6])) return "zip";
    if(startsWith(u, [0x1F, 0x8B])) return "gz";
    if(startsWith(u, ascii("ustar"), 257)) return "tar";
    if(startsWith(u, ascii("ftyp"), 4) || startsWith(u, [0x1A, 0x45, 0xDF, 0xA3])) return "video";
    if(startsWith(u, ascii("ID3")) || startsWith(u, ascii("OggS")) || startsWith(u, ascii("fLaC")) || (startsWith(u, ascii("RIFF")) && startsWith(u, ascii("WAVE"), 8))) return "audio";
    return "";
  }
  function looksText(u){
    const n = Math.min(u.length, 8192); if(!n) return true;
    let bad = 0; for(let i = 0; i < n; i++){ const b = u[i]; if(b === 0) return false; if(b < 9 || (b > 13 && b < 32)) bad++; }
    if(bad / n > 0.02) return false;
    try{ new TextDecoder("utf-8", { fatal: true }).decode(u.subarray(0, n)); return true; }catch(e){
      // 8192 바이트 경계에서 글자가 잘린 경우만 허용
      try{ new TextDecoder("utf-8", { fatal: true }).decode(u.subarray(0, Math.max(0, n - 3))); return true; }catch(_){ return false; }
    }
  }
  function detect(name, u){
    const k = EXTMAP[ext(name)];
    if(k && k !== "svg") return k;
    const s = sniff(u); if(s) return s;
    return looksText(u) ? "text" : "bin";
  }

  /* ---------------- 스타일 (한 번만 주입) ---------------- */
  function injectStyle(){
    if(document.getElementById("cpv-style")) return;
    const s = document.createElement("style"); s.id = "cpv-style";
    s.textContent = `
.cpv{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;color:var(--text,#eee);font-size:13px;}
.cpv-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border,#444);flex-wrap:wrap;}
.cpv-meta{flex:1;min-width:0;font-size:11.5px;color:var(--text-dim,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cpv-tabs{display:flex;gap:4px;}
.cpv-tabs button,.cpv-back{padding:3px 9px;border-radius:7px;border:1px solid var(--border,#444);background:var(--panel-2,#222);color:var(--text,#eee);font-size:12px;cursor:pointer;}
.cpv-tabs button.on{background:var(--accent,#4a8cff);border-color:var(--accent,#4a8cff);color:#fff;}
.cpv-body{flex:1;min-height:0;overflow:auto;padding:10px;box-sizing:border-box;}
.cpv-body.flush{padding:0;display:flex;}
.cpv pre{margin:0;font:12px/1.55 Consolas,"SFMono-Regular",Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;}
.cpv pre.hex{white-space:pre;overflow-wrap:normal;word-break:normal;}
.cpv-note{font-size:11.5px;color:var(--text-dim,#999);margin:0 0 8px;}
.cpv video,.cpv audio{max-width:100%;}
.cpv video{width:100%;height:100%;object-fit:contain;background:#000;border-radius:8px;}
.cpv audio{width:100%;}
.cpv img.big{max-width:100%;max-height:100%;margin:auto;object-fit:contain;}
.cpv iframe{flex:1;border:0;width:100%;background:#fff;}
.cpv-list .r{display:flex;gap:8px;padding:5px 4px;border-bottom:1px solid var(--border,#333);cursor:pointer;align-items:baseline;}
.cpv-list .r:hover{background:var(--panel-2,#222);}
.cpv-list .r .n{flex:1;min-width:0;overflow-wrap:anywhere;}
.cpv-list .r .s{color:var(--text-dim,#999);font-size:11.5px;white-space:nowrap;}
.cpv-list .r.d{cursor:default;font-weight:600;color:var(--text-dim,#999);}
.cpv-md{line-height:1.65;overflow-wrap:anywhere;}
.cpv-md h1,.cpv-md h2{border-bottom:1px solid var(--border,#444);padding-bottom:4px;}
.cpv-md h1{font-size:1.5em;margin:.7em 0 .4em}.cpv-md h2{font-size:1.28em;margin:.8em 0 .4em}.cpv-md h3{font-size:1.12em;margin:.8em 0 .3em}.cpv-md h4,.cpv-md h5,.cpv-md h6{font-size:1em;margin:.8em 0 .3em}
.cpv-md p{margin:.5em 0}.cpv-md ul,.cpv-md ol{margin:.4em 0;padding-left:1.5em}
.cpv-md code{background:var(--panel-2,#222);padding:1px 5px;border-radius:5px;font-size:.92em}
.cpv-md pre.cpv-code{background:var(--panel-2,#222);padding:10px;border-radius:8px;margin:.6em 0}
.cpv-md blockquote{margin:.5em 0;padding:2px 12px;border-left:3px solid var(--accent,#4a8cff);color:var(--text-dim,#aaa)}
.cpv-md table,.cpv-tbl{border-collapse:collapse;margin:.5em 0;font-size:12.5px}
.cpv-md th,.cpv-md td,.cpv-tbl th,.cpv-tbl td{border:1px solid var(--border,#444);padding:4px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere;max-width:340px}
.cpv-md th,.cpv-tbl th{background:var(--panel-2,#222);color:var(--text,#eee);position:sticky;top:0}
.cpv-md a{color:var(--accent,#6aa8ff)}.cpv-md hr{border:0;border-top:1px solid var(--border,#444)}
`;
    document.head.appendChild(s);
  }

  /* ---------------- 바이트 → 텍스트 ---------------- */
  function utf8(u, cap){ return new TextDecoder("utf-8").decode(cap && u.length > cap ? u.subarray(0, cap) : u); }
  function stringsOf(u){
    const cap = Math.min(u.length, TEXT_CAP), s = u.subarray(0, cap), out = [];
    const a = new TextDecoder("utf-8").decode(s).match(/[\t\x20-\x7E -￼]{4,}/g);
    const sane = x => { const t = x.replace(/\s+$/, ""), w = (t.match(/[\p{L}\p{N}\s]/gu) || []).length; if(w / t.length < 0.7 || !/[\p{L}\p{N}]{3}/u.test(t)) return ""; if(t.length < 6 && !/^[A-Za-z0-9 ._-]+$|^[\uAC00-\uD7A3\u4E00-\u9FFF\u3040-\u30FF ]+$/.test(t)) return ""; return t; };
    if(a) a.forEach(x => { const t = sane(x); if(t) out.push(t); });
    // UTF-16LE (Windows 실행 파일 등): 두 가지 정렬 모두 확인
    for(let al = 0; al < 2; al++){
      const b = new TextDecoder("utf-16le").decode(s.subarray(al, al + ((cap - al) & ~1))).match(/[\x20-\x7E]{5,}/g);
      if(b) b.forEach(x => { const t = sane(x); if(t && !out.includes(t)) out.push(t); });
    }
    return out;
  }
  function hexRows(u, from, to){
    const rows = [];
    for(let o = from; o < to; o += 16){
      const n = Math.min(16, to - o); let h = "", t = "";
      for(let i = 0; i < 16; i++){
        if(i < n){ const b = u[o + i]; h += (b < 16 ? "0" : "") + b.toString(16) + " "; t += b >= 32 && b < 127 ? String.fromCharCode(b) : "."; }
        else h += "   ";
        if(i === 7) h += " ";
      }
      rows.push(o.toString(16).padStart(8, "0") + "  " + h + " |" + t + "|");
    }
    return rows.join("\n");
  }

  /* ---------------- 압축 풀기 ---------------- */
  async function stream(u, kind){
    const ds = new DecompressionStream(kind); const w = ds.writable.getWriter(); w.write(u); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  function zipEntries(u){
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let e = -1;
    for(let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--){ if(dv.getUint32(i, true) === 0x06054b50){ e = i; break; } }
    if(e < 0) throw new Error("ZIP 구조를 찾지 못했어요");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for(let k = 0; k < n && p + 46 <= u.length; k++){
      if(dv.getUint32(p, true) !== 0x02014b50) break;
      const fl = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = new TextDecoder("utf-8").decode(u.subarray(p + 46, p + 46 + nl)).replace(/\\/g, "/");
      const enc = !!(fl & 1);
      out.push({ name, size: us, dir: name.endsWith("/"), read: async () => {
        if(enc) throw new Error("암호가 걸린 파일이에요");
        const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true), st = lo + 30 + lnl + lel;
        const raw = u.subarray(st, st + cs);
        if(method === 0) return raw;
        if(method === 8) return await stream(raw, "deflate-raw");
        throw new Error("지원하지 않는 압축 방식(" + method + ")");
      } });
      p += 46 + nl + el + cl;
    }
    return out.filter(x => x.name && !x.name.startsWith("__MACOSX/"));
  }
  function tarEntries(u){
    const out = []; const td = new TextDecoder("utf-8"); let p = 0, longName = null;
    const str = (a, b) => { let e = a; while(e < b && u[e]) e++; return td.decode(u.subarray(a, e)); };
    while(p + 512 <= u.length){
      if(u[p] === 0 && u[p + 1] === 0) break;
      let name = str(p, p + 100); const size = parseInt(str(p + 124, p + 136).trim() || "0", 8) || 0, type = String.fromCharCode(u[p + 156] || 48);
      const pre = str(p + 345, p + 500); if(pre) name = pre + "/" + name;
      const data = p + 512;
      if(type === "L"){ longName = td.decode(u.subarray(data, data + size)).replace(/\0+$/, ""); }
      else if(type === "0" || type === "\0" || type === "5"){
        if(longName){ name = longName; longName = null; }
        const dir = type === "5" || name.endsWith("/");
        out.push({ name, size, dir, read: async () => u.subarray(data, data + size) });
      }
      p = data + Math.ceil(size / 512) * 512;
    }
    return out;
  }

  /* ---------------- 문서(OOXML/ODF/PDF)에서 글자 뽑기 ---------------- */
  const unxml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
  async function entryText(es, name){ const e = es.find(x => x.name === name); return e ? utf8(await e.read()) : ""; }
  async function docText(es, name){
    const e = ext(name);
    if(e === "docx"){
      const x = await entryText(es, "word/document.xml"); if(!x) return null;
      return unxml(x.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
    }
    if(e === "pptx"){
      const slides = es.filter(x => /^ppt\/slides\/slide\d+\.xml$/.test(x.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0]) - parseInt(b.name.match(/\d+/)[0]));
      const out = [];
      for(let i = 0; i < slides.length; i++){ const x = utf8(await slides[i].read()); out.push("── 슬라이드 " + (i + 1) + " ──\n" + unxml(x.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{2,}/g, "\n").trim()); }
      return out.join("\n\n") || null;
    }
    if(e === "odt" || e === "odp" || e === "ods"){
      const x = await entryText(es, "content.xml"); if(!x) return null;
      return unxml(x.replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<\/text:(p|h)>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
    }
    return null;
  }
  async function xlsxRows(es){
    const sheets = es.filter(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0]) - parseInt(b.name.match(/\d+/)[0]));
    if(!sheets.length) return null;
    const sst = []; const sx = await entryText(es, "xl/sharedStrings.xml");
    if(sx) sx.split(/<si[ >]/).slice(1).forEach(si => { sst.push(unxml((si.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, "")).join(""))); });
    const x = await sheets[0].read(); const doc = new DOMParser().parseFromString(utf8(x), "application/xml"); const rows = [];
    doc.querySelectorAll("row").forEach(r => {
      const row = [];
      r.querySelectorAll("c").forEach(c => {
        const ref = c.getAttribute("r") || "", m = /^([A-Z]+)/.exec(ref); let col = row.length;
        if(m){ col = 0; for(const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64; col--; }
        const t = c.getAttribute("t"), v = c.querySelector("v"); let val = "";
        if(t === "s" && v) val = sst[+v.textContent] || ""; else if(t === "inlineStr") val = (c.textContent || ""); else if(v) val = v.textContent;
        row[col] = val;
      });
      rows.push(row);
    });
    return { rows, count: sheets.length };
  }
  async function pdfText(u){
    // 단순 글꼴 PDF 의 글자만 뽑는다(한글 등 CID 글꼴은 못 읽을 수 있음)
    const s = new TextDecoder("latin1").decode(u.length > 40 * 1048576 ? u.subarray(0, 40 * 1048576) : u), out = [];
    const re = /stream\r?\n/g; let m, n = 0;
    while((m = re.exec(s)) && n < 400){
      const end = s.indexOf("endstream", re.lastIndex); if(end < 0) break;
      const head = s.slice(Math.max(0, m.index - 300), m.index); n++;
      let chunk = u.subarray(re.lastIndex, end);
      try{ if(/FlateDecode/.test(head.slice(head.lastIndexOf("obj")))) chunk = await stream(chunk, "deflate"); else if(/Filter/.test(head.slice(head.lastIndexOf("obj")))) continue; }catch(e){ continue; }
      const t = new TextDecoder("latin1").decode(chunk);
      if(!/BT[\s\S]*?ET/.test(t)) continue;
      (t.match(/BT[\s\S]*?ET/g) || []).forEach(bt => {
        let line = "";
        bt.replace(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|T\*|Td|TD/g, (x, arr, one) => {
          if(arr != null) line += (arr.match(/\(((?:[^)\\]|\\.)*)\)/g) || []).map(p => p.slice(1, -1)).join("");
          else if(one != null) line += one; else line += "\n";
          return x;
        });
        line = line.replace(/\\([()\\])/g, "$1").replace(/\\(\d{3})/g, (x, o) => String.fromCharCode(parseInt(o, 8)));
        if(line.trim()) out.push(line.trim());
      });
    }
    return out.join("\n");
  }

  /* ---------------- 마크다운 (HTML 은 전부 이스케이프) ---------------- */
  function mdInline(s){
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, a) => "🖼 " + a);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, t, u) => /^(https?:|mailto:)/i.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => "<b>" + (a || b) + "</b>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
    s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[+i]) + "</code>");
  }
  function mdList(items, from, indent){
    const ord = items[from].ord; let h = "<" + (ord ? "ol" : "ul") + ">", i = from;
    while(i < items.length && items[i].ind >= indent){
      if(items[i].ind > indent){ const r = mdList(items, i, items[i].ind); h = h.replace(/<\/li>$/, r[0] + "</li>"); i = r[1]; continue; }
      let t = items[i].text, cb = ""; const c = /^\[( |x|X)\]\s+(.*)/.exec(t);
      if(c){ cb = '<input type="checkbox" disabled ' + (c[1] !== " " ? "checked" : "") + "> "; t = c[2]; }
      h += "<li>" + cb + mdInline(t) + "</li>"; i++;
    }
    return [h + "</" + (ord ? "ol" : "ul") + ">", i];
  }
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  function mdToHtml(src){
    src = String(src).replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
    const L = src.split("\n"), out = []; let i = 0, m;
    const isBlock = l => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LI.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
    while(i < L.length){
      const l = L[i];
      if((m = /^\s*(```|~~~)/.exec(l))){ const f = m[1], buf = []; i++; while(i < L.length && !L[i].trim().startsWith(f)){ buf.push(L[i]); i++; } i++; out.push('<pre class="cpv-code">' + esc(buf.join("\n")) + "</pre>"); continue; }
      if(!l.trim()){ i++; continue; }
      if((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))){ out.push("<h" + m[1].length + ">" + mdInline(m[2]) + "</h" + m[1].length + ">"); i++; continue; }
      if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)){ out.push("<hr>"); i++; continue; }
      if(/^\s*>/.test(l)){ const buf = []; while(i < L.length && /^\s*>/.test(L[i])){ buf.push(L[i].replace(/^\s*>\s?/, "")); i++; } out.push("<blockquote>" + mdToHtml(buf.join("\n")) + "</blockquote>"); continue; }
      if(/^\s*\|.*\|\s*$/.test(l) && i + 1 < L.length && TSEP.test(L[i + 1])){
        const head = cells(l); i += 2; const rows = [];
        while(i < L.length && /\|/.test(L[i]) && L[i].trim()){ rows.push(cells(L[i])); i++; }
        out.push("<table><thead><tr>" + head.map(c => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>" + rows.map(r => "<tr>" + head.map((_, k) => "<td>" + mdInline(r[k] || "") + "</td>").join("") + "</tr>").join("") + "</tbody></table>"); continue;
      }
      if(LI.test(l)){
        const items = [];
        while(i < L.length){ const x = LI.exec(L[i]); if(x) items.push({ ind: x[1].replace(/\t/g, "  ").length, ord: /\d/.test(x[2]), text: x[3] }); else if(L[i].trim() && /^\s{2,}\S/.test(L[i]) && items.length) items[items.length - 1].text += " " + L[i].trim(); else break; i++; }
        out.push(mdList(items, 0, items[0].ind)[0]); continue;
      }
      const buf = [l]; i++;
      while(i < L.length && L[i].trim() && !isBlock(L[i])){ buf.push(L[i]); i++; }
      out.push("<p>" + buf.map(mdInline).join("<br>") + "</p>");
    }
    return out.join("\n");
  }

  /* ---------------- CSV ---------------- */
  function parseCsv(t, d){
    const rows = []; let row = [], c = "", q = false;
    for(let i = 0; i < t.length && rows.length < 2001; i++){
      const ch = t[i];
      if(q){ if(ch === '"'){ if(t[i + 1] === '"'){ c += '"'; i++; } else q = false; } else c += ch; }
      else if(ch === '"') q = true;
      else if(ch === d){ row.push(c); c = ""; }
      else if(ch === "\n"){ row.push(c.replace(/\r$/, "")); rows.push(row); row = []; c = ""; }
      else c += ch;
    }
    if(c || row.length){ row.push(c); rows.push(row); }
    return rows;
  }
  function tableEl(rows, header){
    const t = el("table", "cpv-tbl"), maxC = Math.min(60, rows.reduce((m, r) => Math.max(m, r.length), 0));
    rows.slice(0, 500).forEach((r, ri) => {
      const tr = document.createElement("tr");
      for(let k = 0; k < maxC; k++){ const td = document.createElement(header && ri === 0 ? "th" : "td"); td.textContent = r[k] == null ? "" : String(r[k]); tr.appendChild(td); }
      t.appendChild(tr);
    });
    return t;
  }

  /* ---------------- 화면 만들기 ---------------- */
  function blobUrl(host, u, mime){ const url = URL.createObjectURL(new Blob([u], { type: mime || "application/octet-stream" })); (host._cpvUrls = host._cpvUrls || []).push(url); return url; }
  function dispose(host){ if(host && host._cpvUrls){ host._cpvUrls.forEach(u => { try{ URL.revokeObjectURL(u); }catch(_){} }); host._cpvUrls = []; } }

  async function show(root, o, top){
    root.innerHTML = "";
    const bar = el("div", "cpv-bar"), meta = el("div", "cpv-meta"), tabs = el("div", "cpv-tabs"), body = el("div", "cpv-body");
    if(o.onBack){ const b = el("button", "cpv-back", "← 목록"); b.onclick = o.onBack; bar.appendChild(b); }
    bar.appendChild(meta); bar.appendChild(tabs); root.appendChild(bar); root.appendChild(body);
    meta.textContent = base(o.name) + (o.size != null ? " · " + fmt(o.size) : "");
    meta.title = o.name;

    let u = o.bytes, partial = false;
    if(!u){
      body.textContent = "불러오는 중…";
      try{
        const lim = o.size > MAX_FULL ? HEAD : 0;
        u = await o.load(lim, p => { body.textContent = "불러오는 중… " + p; }); partial = lim > 0;
      }catch(e){ body.textContent = "읽지 못했어요: " + (e && e.message || e); return; }
    }
    const kind = detect(o.name, u), e = ext(o.name);
    meta.textContent = base(o.name) + " · " + fmt(partial ? o.size : u.length) + " · " + (KIND_LABEL[kind] || kind);

    const views = [];
    const isText = kind === "text" || kind === "md" || kind === "csv" || kind === "json";
    const note = txt => { const n = el("p", "cpv-note", txt); return n; };

    // ----- 미리보기 탭 -----
    let prev = null;
    if(!partial){
      if(kind === "image" || (e === "svg")) prev = () => { const im = el("img", "big"); im.src = blobUrl(root, u, MIME[e] || "image/png"); im.onerror = () => { body.textContent = "이미지를 표시하지 못했어요"; }; body.classList.add("flush"); body.appendChild(im); };
      else if(kind === "video") prev = () => {
        body.classList.add("flush"); const v = document.createElement("video"); v.controls = true; v.playsInline = true; v.preload = "metadata"; v.src = blobUrl(root, u, MIME[e] || "video/mp4");
        v.onerror = () => { body.classList.remove("flush"); body.innerHTML = ""; body.appendChild(note("이 형식은 브라우저에서 재생할 수 없어요 (코덱/컨테이너). 다운로드해서 재생하세요."));
          body.appendChild(el("pre", null, "크기 " + fmt(u.length) + "\n앞부분 16바이트: " + Array.from(u.subarray(0, 16), b => b.toString(16).padStart(2, "0")).join(" "))); };
        body.appendChild(v);
      };
      else if(kind === "audio") prev = () => { const a = document.createElement("audio"); a.controls = true; a.preload = "metadata"; a.src = blobUrl(root, u, MIME[e] || "audio/mpeg"); a.onerror = () => { body.insertBefore(note("이 오디오는 재생할 수 없어요."), a); }; body.appendChild(a); };
      else if(kind === "pdf") prev = () => { body.classList.add("flush"); body.style.flexDirection = "column"; const f = document.createElement("iframe"); f.src = blobUrl(root, u, "application/pdf"); body.appendChild(f); body.appendChild(note("안 보이면 [텍스트] 탭에서 글자를 확인하세요.")); };
      else if(kind === "md") prev = () => { const d = el("div", "cpv-md"); d.innerHTML = mdToHtml(utf8(u, TEXT_CAP)); body.appendChild(d); };
      else if(kind === "csv") prev = () => { const t = utf8(u, TEXT_CAP), first = t.split("\n", 1)[0], d = [",", "\t", ";", "|"].reduce((b, c) => first.split(c).length > first.split(b).length ? c : b, ","); const rows = parseCsv(t, d); body.appendChild(tableEl(rows, true)); if(rows.length > 500) body.appendChild(note("앞 500줄만 표시")); };
      else if(kind === "json") prev = () => { const t = utf8(u, TEXT_CAP); let s = t; if(u.length <= TEXT_CAP && !/\.(jsonl|ndjson)$/i.test(o.name)){ try{ s = JSON.stringify(JSON.parse(t), null, 2); }catch(_){} } body.appendChild(el("pre", null, s)); };
    }

    // ----- 압축 파일 -----
    let archive = null;
    if(!partial && (kind === "zip" || kind === "tar")){
      try{ archive = { es: kind === "zip" ? zipEntries(u) : tarEntries(u) }; }catch(err){ archive = { err: err.message }; }
    }
    if(!partial && kind === "gz"){
      try{
        const d = await stream(u, "gzip"); const inner = o.name.replace(/\.(gz|tgz)$/i, e === "tgz" ? ".tar" : "");
        return show(root, { name: inner, bytes: d, size: d.length, onBack: o.onBack, gzNote: base(o.name) }, top);
      }catch(err){ prev = () => body.appendChild(note("gzip 을 풀지 못했어요: " + err.message)); }
    }
    if(archive && archive.es){
      const es = archive.es, ocr = (e === "docx" || e === "pptx" || e === "odt" || e === "odp" || e === "ods");
      const list = () => {
        const d = el("div", "cpv-list"); const tot = es.filter(x => !x.dir).length;
        d.appendChild(note(tot + "개 파일" + (o.gzNote ? " · " + o.gzNote + " 안" : "")));
        const seen = new Set(), rows = [];
        es.slice().sort((a, b) => a.name.replace(/^\.\//, "") < b.name.replace(/^\.\//, "") ? -1 : 1).forEach(x => {
          const nm = x.name.replace(/^\.\//, ""), parts = nm.replace(/\/$/, "").split("/");
          for(let k = 1; k < parts.length; k++){ const dn = parts.slice(0, k).join("/") + "/"; if(!seen.has(dn)){ seen.add(dn); rows.push({ name: dn, dir: true, size: 0 }); } }
          if(x.dir){ if(!seen.has(nm)){ seen.add(nm); rows.push({ name: nm, dir: true, size: 0 }); } } else rows.push(Object.assign({}, x, { name: nm, orig: x }));
        });
        rows.slice(0, 600).forEach(x => {
          const r = el("div", "r" + (x.dir ? " d" : "")); const depth = x.name.replace(/\/$/, "").split("/").length - 1;
          const n = el("span", "n", (depth ? " ".repeat(Math.min(depth, 8)) + "└ " : "") + x.name.replace(/\/$/, "").split("/").pop() + (x.dir ? "/" : "")); n.title = x.name;
          r.appendChild(n); if(!x.dir) r.appendChild(el("span", "s", fmt(x.size)));
          if(!x.dir) r.onclick = () => {
            if(x.size > MAX_FULL){ alert("너무 커서 열 수 없어요"); return; }
            show(root, { name: x.name, size: x.size, load: async () => await x.orig.read(), onBack: () => show(root, o, top) }, top);
          };
          d.appendChild(r);
        });
        if(rows.length > 600) d.appendChild(note("…외 " + (rows.length - 600) + "개"));
        body.appendChild(d);
      };
      prev = list;
      if(e === "apk" && window.ChoiminiApk && ChoiminiApk.info) views.push({ label: "정보", fn: async () => { body.textContent = "분석 중…"; try{ const i = await ChoiminiApk.info(u); body.innerHTML = ""; body.appendChild(el("pre", null, "서명 " + (i.signedV2 ? "v2" : i.signedV1 ? "v1" : "없음") + (i.manifest ? "\n\n" + i.manifest : ""))); }catch(err){ body.textContent = "읽지 못했어요: " + err.message; } } });
      if(ocr) views.push({ label: "글자", fn: async () => { body.textContent = "추출 중…"; try{ const t = await docText(es, o.name); body.innerHTML = ""; body.appendChild(el("pre", null, t || "(글자가 없어요)")); }catch(err){ body.textContent = "읽지 못했어요: " + err.message; } } });
      if(e === "xlsx") views.push({ label: "시트", fn: async () => { body.textContent = "읽는 중…"; try{ const r = await xlsxRows(es); body.innerHTML = ""; if(!r){ body.textContent = "시트를 찾지 못했어요"; return; } if(r.count > 1) body.appendChild(note("첫 시트만 표시 (전체 " + r.count + "개)")); body.appendChild(tableEl(r.rows, false)); if(r.rows.length > 500) body.appendChild(note("앞 500줄만 표시")); }catch(err){ body.textContent = "읽지 못했어요: " + err.message; } } });
    } else if(archive && archive.err){
      prev = () => body.appendChild(note(archive.err + " — [텍스트]/[Hex] 탭으로 확인하세요."));
    }
    if(!partial && kind === "pdf") views.push({ label: "글자", fn: async () => { body.textContent = "추출 중…"; const t = await pdfText(u).catch(() => ""); body.innerHTML = ""; body.appendChild(note("간단 추출 — 글꼴에 따라 일부만 나와요")); body.appendChild(el("pre", null, t || "(추출된 글자가 없어요)")); } });

    // ----- 텍스트 / Hex 탭 -----
    const textTab = () => {
      if(isText){
        body.appendChild(el("pre", null, utf8(u, TEXT_CAP)));
        if(u.length > TEXT_CAP) body.appendChild(note("앞 " + fmt(TEXT_CAP) + "만 표시"));
      } else {
        const s = stringsOf(u);
        body.appendChild(note("글자만 추출" + (partial ? " · 앞 " + fmt(u.length) + "만" : "")));
        body.appendChild(el("pre", null, s.length ? s.join("\n") : "(읽을 수 있는 글자가 없어요)"));
      }
    };
    const hexTab = () => {
      const pre = el("pre", "hex"); let shown = 0;
      const more = el("button", "cpv-back", "더 보기"); more.style.marginTop = "8px";
      const add = () => { const to = Math.min(u.length, shown + HEX_PAGE); pre.textContent += (shown ? "\n" : "") + hexRows(u, shown, to); shown = to; more.style.display = shown < u.length ? "" : "none"; more.textContent = "더 보기 (" + fmt(u.length - shown) + " 남음)"; };
      more.onclick = add; add(); body.appendChild(pre); body.appendChild(more);
    };

    const tabList = [];
    if(prev) tabList.push({ label: "미리보기", fn: prev });
    views.forEach(v => { if(v.label) tabList.push(v); });
    if(!(archive && archive.es)) tabList.push({ label: isText && prev ? "원문" : isText ? "텍스트" : "텍스트 추출", fn: textTab });
    tabList.push({ label: "Hex", fn: hexTab });
    let cur = -1;
    const open = i => {
      cur = i; tabs.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === i));
      body.innerHTML = ""; body.className = "cpv-body"; body.removeAttribute("style");
      if(partial) body.appendChild(note("파일이 커서 앞 " + fmt(u.length) + "만 읽었어요."));
      Promise.resolve(tabList[i].fn()).catch(err => { body.textContent = "표시하지 못했어요: " + (err && err.message || err); });
    };
    tabList.forEach((t, i) => { const b = el("button", null, t.label); b.onclick = () => open(i); tabs.appendChild(b); });
    open(0);
    return { kind };
  }

  function render(host, o){
    injectStyle(); dispose(host);
    host.innerHTML = "";
    const root = el("div", "cpv"); host.appendChild(root);
    root._cpvUrls = host._cpvUrls = host._cpvUrls || [];
    return show(root, o, root);
  }

  window.ChoiminiPreview = { render, dispose, detect, mdToHtml, stringsOf, hexRows, fmt, zipEntries, tarEntries, parseCsv };
})();
