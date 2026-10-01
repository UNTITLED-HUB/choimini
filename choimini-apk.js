/* ============================================================================
   choimini-apk.js — 브라우저 안에서 "웹앱 → 설치 가능한 APK" 를 만드는 빌더 (SDK/Gradle 불필요)
   · 미리 컴파일해 둔 WebView 호스트(classes.dex) + 직접 만든 AndroidManifest(AXML) + 프로젝트 파일(assets/www)
   · ZIP 으로 묶고 APK Signature Scheme v2(RSA-2048/SHA-256)로 서명 (WebCrypto)
   · 서명 키는 이 브라우저에 한 번 만들어 저장 → 같은 키로 서명해야 앱 업데이트(덮어쓰기 설치)가 된다
   한계: Java/Kotlin 소스 컴파일(Gradle)은 못 한다. HTML/JS/CSS 웹앱(또는 URL 래퍼)만 APK 로 만든다.
   ============================================================================ */
(function(global){
  "use strict";
  const DEX_B64 = "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YWluQWN0aXZpdHk7AB9MamF2YS9pby9CeXRlQXJyYXlPdXRwdXRTdHJlYW07ABVMamF2YS9pby9JbnB1dFN0cmVhbTsAGExqYXZhL2xhbmcvQ2hhclNlcXVlbmNlOwAVTGphdmEvbGFuZy9FeGNlcHRpb247ABJMamF2YS9sYW5nL09iamVjdDsAEkxqYXZhL2xhbmcvU3RyaW5nOwAFVVRGLTgAAVYABFZJSUwAAlZMAANWTEkABFZMSUkAAlZaAAFaAAJaSQAEWkxMTAACW0IAEltMYW5kcm9pZC9uZXQvVXJpOwADYWN0AAthZGRDYXRlZ29yeQAhYW5kcm9pZC5pbnRlbnQuYWN0aW9uLkdFVF9DT05URU5UACBhbmRyb2lkLmludGVudC5jYXRlZ29yeS5PUEVOQUJMRQAJY2FuR29CYWNrAAJjYgAFY2xvc2UACmNvbmZpZy50eHQADWNyZWF0ZUNob29zZXIAJGZpbGU6Ly8vYW5kcm9pZF9hc3NldC93d3cvaW5kZXguaHRtbAAJZ2V0QXNzZXRzAAdnZXREYXRhAAtnZXRTZXR0aW5ncwAGZ29CYWNrAAZsZW5ndGgAB2xvYWRVcmwAEG9uQWN0aXZpdHlSZXN1bHQADW9uQmFja1ByZXNzZWQACG9uQ3JlYXRlAA5vblJlY2VpdmVWYWx1ZQARb25TaG93RmlsZUNob29zZXIABG9wZW4AC29wZW5DaG9vc2VyAARyZWFkABRyZXF1ZXN0V2luZG93RmVhdHVyZQASc2V0QWxsb3dGaWxlQWNjZXNzACNzZXRBbGxvd1VuaXZlcnNhbEFjY2Vzc0Zyb21GaWxlVVJMcwAOc2V0Q29udGVudFZpZXcAEnNldERhdGFiYXNlRW5hYmxlZAAUc2V0RG9tU3RvcmFnZUVuYWJsZWQAFHNldEphdmFTY3JpcHRFbmFibGVkACNzZXRNZWRpYVBsYXliYWNrUmVxdWlyZXNVc2VyR2VzdHVyZQAHc2V0VHlwZQASc2V0V2ViQ2hyb21lQ2xpZW50ABBzZXRXZWJWaWV3Q2xpZW50ABZzdGFydEFjdGl2aXR5Rm9yUmVzdWx0AAhzdGFydFVybAAIdG9TdHJpbmcABHRyaW0AA3dlYgAFd3JpdGUAAAADAAAADAAIAAkAAAABAAAADQAAAAEAAAAPAAAAAQAAABQAAAABAAAABgAAAAEAAAAYAAAAAQAAAAAAAAABAAAAAgAAAAEAAAAHAAAAAwAAABgAAAAAAAAAAQAAABUAAAABAAAACgAAAAEAAAAIAAAAAwAAAAAAAAADAAAAAQAAABcAAAACAAAAAwAAAAIAAAADABIAAAAAAAIAAgABAAAAAAAAAAYAAABwEAsAAABbAQAADgAFAAQAAgAAAAAAAAAHAAAAVBAAAG4gIQAwABIQDwAAAAEAAQABAAAAAAAAAAQAAABwEAAAAAAOAAYAAQAEAAEAAAAAADUAAABuEB0ABQAMABoBMABuIAkAEAAMACIBEABwECYAAQATAgACIyIYAG4gKgAgAAoDPQMHABIEbkAoACE0KPZuECkAAAAaAB0AbiAnAAEADABuECwAAAAMAG4QKwAAAAoBPQEDABEAGgAyABEAAAAAAAAAMQABAAEBEzIIAAQABAAAAAAAAAAgAAAAb0ABAFR2VEABADgAGgASARLyMyYQADgHDgBuEAcABwAMAjgCCAASESMRGQASA00CAQNyIAoAEAASAFtAAQAOAAIAAQABAAAAAAAAABQAAABUEAIAOAAOAG4QEwAAAAoAOAAIAFQQAgBuEBUAAAAOAG8QAgABAA4ABQACAAIAAAAAAAAAQQAAAG8gAwBDABIQbiAiAAMAIgAMAHAgEgAwAFswAgBuEBQAAAAMARISbiAQACEAbiAPACEAbiAOACEAbiAMACEAbiANACEAEgJuIBEAIQAiAQ0AcBAZAAEAbiAYABAAIgEOAHAgGgAxAG4gFwAQAG4gIwADAHAQJQADAAwBbiAWABAADgAAAAUAAgADAAAAAAAAACcAAABUMAEAOAAGABIBciAKABAAWzQBACIAAwAaASsAcCAEABAAGgEsAG4gBQAQABoBAABuIAgAEAAaAQIAcSAGABAADAATAXoAbjAkAAMBDgAAAQEBABAagIAEiBYbAaQWAAICBAECAQIcgYAExBYJAtwWHgTkFwEBtBgBBOwYAQGAGg0AAAAAAAAAAQAAAAAAAAABAAAAUgAAAHAAAAACAAAAGgAAALgBAAADAAAAGwAAACACAAAEAAAAAwAAAGQDAAAFAAAALQAAAHwDAAAGAAAAAgAAAOQEAAACIAAAUgAAACQFAAABEAAAEQAAAHAKAAADEAAAAQAAAAQLAAABIAAACAAAAAgLAAAAIAAAAgAAAF4NAAAAEAAAAQAAAJANAAA=";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const subtle = (global.crypto && global.crypto.subtle) || null;
  const b64ToU8 = b => { const s = atob(b), u = new Uint8Array(s.length); for(let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const u8ToB64 = u => { let s = ""; for(let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  function concat(list){ let n = 0; list.forEach(a => { n += a.length; }); const o = new Uint8Array(n); let p = 0; list.forEach(a => { o.set(a, p); p += a.length; }); return o; }
  const le16 = v => new Uint8Array([v & 255, (v >> 8) & 255]);
  const le32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const le64 = v => concat([le32(v >>> 0), le32(Math.floor(v / 4294967296))]);

  /* ---------------- CRC32 / deflate ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u){ let c = 0xFFFFFFFF; for(let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function deflateRaw(u){
    if(typeof CompressionStream === "undefined") return null;
    try{ const cs = new CompressionStream("deflate-raw"); const w = cs.writable.getWriter(); w.write(u); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }catch(e){ return null; }
  }
  async function inflateRaw(u){
    const ds = new DecompressionStream("deflate-raw"); const w = ds.writable.getWriter(); w.write(u); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  /* ---------------- ZIP ---------------- */
  const DOS_TIME = 0, DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
  async function zipParts(entries){
    const locals = [], cds = []; let off = 0;
    for(const e of entries){
      const name = enc.encode(e.name), data = e.data, crc = crc32(data);
      let method = 0, body = data;
      if(!e.store && data.length > 64){ const d = await deflateRaw(data); if(d && d.length < data.length){ method = 8; body = d; } }
      const lh = concat([le32(0x04034b50), le16(method ? 20 : 10), le16(0x0800), le16(method), le16(DOS_TIME), le16(DOS_DATE), le32(crc), le32(body.length), le32(data.length), le16(name.length), le16(0), name]);
      locals.push(lh, body);
      cds.push(concat([le32(0x02014b50), le16(0x031e), le16(method ? 20 : 10), le16(0x0800), le16(method), le16(DOS_TIME), le16(DOS_DATE), le32(crc), le32(body.length), le32(data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(off), name]));
      off += lh.length + body.length;
    }
    return { sec1: concat(locals), cd: concat(cds), count: entries.length };
  }
  const eocd = (count, cdSize, cdOff) => concat([le32(0x06054b50), le16(0), le16(0), le16(count), le16(count), le32(cdSize), le32(cdOff), le16(0)]);
  async function readZip(u){
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let e = -1;
    for(let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--){ if(dv.getUint32(i, true) === 0x06054b50){ e = i; break; } }
    if(e < 0) throw new Error("ZIP/APK 형식이 아니에요");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for(let k = 0; k < n; k++){
      if(dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u.subarray(p + 46, p + 46 + nl));
      out.push({ name, method, csize, usize, lo, read: async () => { const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true); const raw = u.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csize); return method === 0 ? raw : await inflateRaw(raw); } });
      p += 46 + nl + el + cl;
    }
    return out;
  }

  /* ---------------- AXML (바이너리 AndroidManifest) ---------------- */
  const RES = { label:0x01010001, icon:0x01010002, name:0x01010003, theme:0x01010000, debuggable:0x0101000f, exported:0x01010010, configChanges:0x0101001f, versionCode:0x0101021b, versionName:0x0101021c, minSdkVersion:0x0101020c, targetSdkVersion:0x01010270, usesCleartextTraffic:0x010104ec, allowBackup:0x01010280, hardwareAccelerated:0x010102d3, screenOrientation:0x0101001e, windowSoftInputMode:0x0101022b };
  function buildAxml(m){
    // m: { pkg, label, versionCode, versionName, minSdk, targetSdk, permissions[], orientation? }
    const NS = "http://schemas.android.com/apk/res/android";
    const S = (v) => ({ t:"s", v }), I = (v) => ({ t:"i", v }), H = (v) => ({ t:"h", v }), B = (v) => ({ t:"b", v });
    const tree = { tag:"manifest", attrs:[["package", null, S(m.pkg)], ["versionCode", "versionCode", I(m.versionCode)], ["versionName", "versionName", S(m.versionName)]], kids:[
      { tag:"uses-sdk", attrs:[["minSdkVersion", "minSdkVersion", I(m.minSdk)], ["targetSdkVersion", "targetSdkVersion", I(m.targetSdk)]] },
      ...m.permissions.map(p => ({ tag:"uses-permission", attrs:[["name", "name", S(p)]] })),
      { tag:"application", attrs:[["label", "label", S(m.label)], ["allowBackup", "allowBackup", B(true)], ["usesCleartextTraffic", "usesCleartextTraffic", B(true)], ["hardwareAccelerated", "hardwareAccelerated", B(true)]], kids:[
        { tag:"activity", attrs:[["label", "label", S(m.label)], ["name", "name", S("com.choimini.webapp.MainActivity")], ["exported", "exported", B(true)], ["configChanges", "configChanges", H(0x0fb0)], ["windowSoftInputMode", "windowSoftInputMode", H(0x10)]].concat(m.orientation ? [["screenOrientation", "screenOrientation", I(m.orientation)]] : []), kids:[
          { tag:"intent-filter", attrs:[], kids:[
            { tag:"action", attrs:[["name", "name", S("android.intent.action.MAIN")]] },
            { tag:"category", attrs:[["name", "name", S("android.intent.category.LAUNCHER")]] } ] } ] } ] } ] };
    // 문자열 풀: 리소스 id 가 있는 속성 이름이 앞쪽(리소스 맵 순서와 동일)
    const idNames = [], pool = [], idx = new Map();
    const add = s => { if(!idx.has(s)){ idx.set(s, pool.length); pool.push(s); } return idx.get(s); };
    const used = new Set(); (function walk(n){ n.attrs.forEach(a => { if(a[1]) used.add(a[1]); }); (n.kids || []).forEach(walk); })(tree);
    [...used].sort((a, b) => RES[a] - RES[b]).forEach(n => { idNames.push(RES[n]); add(n); });
    const nsPrefix = add("android"), nsUri = add(NS);
    (function walk(n){ add(n.tag); n.attrs.forEach(a => { add(a[0]); if(a[2].t === "s") add(a[2].v); }); (n.kids || []).forEach(walk); })(tree);
    const strBytes = pool.map(s => { const len = s.length; const hdr = len > 0x7fff ? concat([le16(0x8000 | (len >> 16)), le16(len & 0xffff)]) : le16(len); const ch = new Uint8Array(len * 2); for(let i = 0; i < len; i++){ ch[i * 2] = s.charCodeAt(i) & 255; ch[i * 2 + 1] = s.charCodeAt(i) >> 8; } return concat([hdr, ch, le16(0)]); });
    let so = 0; const offs = strBytes.map(b => { const o = so; so += b.length; return o; });
    const pad4 = n => (4 - (n % 4)) % 4;
    const strData = concat(strBytes), strPad = pad4(strData.length);
    const poolSize = 28 + 4 * pool.length + strData.length + strPad;
    const poolChunk = concat([le16(1), le16(28), le32(poolSize), le32(pool.length), le32(0), le32(0), le32(28 + 4 * pool.length), le32(0), ...offs.map(le32), strData, new Uint8Array(strPad)]);
    const resChunk = concat([le16(0x180), le16(8), le32(8 + 4 * idNames.length), ...idNames.map(le32)]);
    const nodes = []; let line = 1;
    const hdr = (type, size) => concat([le16(type), le16(16), le32(size), le32(line++), le32(0xffffffff)]);
    nodes.push(concat([hdr(0x100, 24), le32(nsPrefix), le32(nsUri)]));
    (function walk(n){
      const attrs = n.attrs.map(a => ({ ns: a[1] ? nsUri : -1, name: add(a[0]), res: a[1] ? RES[a[1]] : 0, val: a[2] })).sort((x, y) => (x.res ? 0 : 1) - (y.res ? 0 : 1) || x.res - y.res);
      const ab = attrs.map(a => { const v = a.val; let raw = 0xffffffff, type, data; if(v.t === "s"){ raw = idx.get(v.v); type = 3; data = raw; } else if(v.t === "i"){ type = 0x10; data = v.v >>> 0; } else if(v.t === "h"){ type = 0x11; data = v.v >>> 0; } else { type = 0x12; data = v.v ? 0xffffffff : 0; } return concat([le32(a.ns >>> 0), le32(a.name), le32(raw), le16(8), new Uint8Array([0, type]), le32(data)]); });
      nodes.push(concat([hdr(0x102, 36 + 20 * attrs.length), le32(0xffffffff), le32(idx.get(n.tag)), le16(0x14), le16(0x14), le16(attrs.length), le16(0), le16(0), le16(0), ...ab]));
      (n.kids || []).forEach(walk);
      nodes.push(concat([hdr(0x103, 24), le32(0xffffffff), le32(idx.get(n.tag))]));
    })(tree);
    nodes.push(concat([hdr(0x101, 24), le32(nsPrefix), le32(nsUri)]));
    const body = concat([poolChunk, resChunk, ...nodes]);
    return concat([le16(3), le16(8), le32(8 + body.length), body]);
  }
  /* AXML → 사람이 읽는 텍스트 (apk info 용) */
  function decodeAxml(u){
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); const strings = [];
    let p = 8; const total = dv.getUint32(4, true);
    while(p < total && p < u.length){
      const type = dv.getUint16(p, true), hs = dv.getUint16(p + 2, true), size = dv.getUint32(p + 4, true);
      if(type === 1){
        const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 16, true), ss = dv.getUint32(p + 20, true), utf8 = !!(flags & 0x100);
        for(let i = 0; i < n; i++){
          let o = p + ss + dv.getUint32(p + 28 + 4 * i, true);
          if(utf8){ let l = u[o++]; if(l & 0x80) l = ((l & 0x7f) << 8) | u[o++]; let bl = u[o++]; if(bl & 0x80) bl = ((bl & 0x7f) << 8) | u[o++]; strings.push(dec.decode(u.subarray(o, o + bl))); }
          else { let l = dv.getUint16(o, true); o += 2; if(l & 0x8000){ l = ((l & 0x7fff) << 16) | dv.getUint16(o, true); o += 2; } let s = ""; for(let k = 0; k < l; k++) s += String.fromCharCode(dv.getUint16(o + 2 * k, true)); strings.push(s); }
        }
      } else if(type === 0x102 || type === 0x103){
        break;
      }
      p += size;
    }
    const out = []; let depth = 0; p = 8;
    while(p < total && p < u.length){
      const type = dv.getUint16(p, true), size = dv.getUint32(p + 4, true);
      if(type === 0x102){
        const ns = dv.getInt32(p + 16, true), name = dv.getInt32(p + 20, true), cnt = dv.getUint16(p + 28, true); let a = p + 36; const attrs = [];
        for(let i = 0; i < cnt; i++){ const an = dv.getInt32(a + 4, true), raw = dv.getInt32(a + 8, true), dt = u[a + 15], data = dv.getUint32(a + 16, true); attrs.push(strings[an] + "=" + (raw >= 0 ? JSON.stringify(strings[raw]) : dt === 0x12 ? (data ? "true" : "false") : dt === 0x11 ? "0x" + data.toString(16) : dt === 1 ? "@0x" + data.toString(16) : String(data | 0))); a += 20; }
        out.push("  ".repeat(depth) + "<" + strings[name] + (attrs.length ? " " + attrs.join(" ") : "") + ">"); depth++;
      } else if(type === 0x103){ depth--; }
      p += size;
    }
    return out.join("\n");
  }

  /* ---------------- ASN.1 / X.509 자체서명 인증서 ---------------- */
  const der = (tag, ...c) => { const b = concat(c); const l = b.length; const h = l < 128 ? [l] : l < 256 ? [0x81, l] : [0x82, l >> 8, l & 255]; return concat([new Uint8Array([tag, ...h]), b]); };
  const oid = a => { const b = [a[0] * 40 + a[1]]; a.slice(2).forEach(v => { const t = []; do{ t.unshift(v & 127); v = Math.floor(v / 128); }while(v > 0); t.forEach((x, i) => b.push(i < t.length - 1 ? x | 128 : x)); }); return der(6, new Uint8Array(b)); };
  const OID_SHA256RSA = oid([1, 2, 840, 113549, 1, 1, 11]);
  const SIGALG = der(0x30, OID_SHA256RSA, der(5, new Uint8Array(0)));
  const nameCN = cn => der(0x30, der(0x31, der(0x30, oid([2, 5, 4, 3]), der(0x0c, enc.encode(cn)))));
  async function makeCert(keyPair, cn){
    const spki = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
    const serial = crypto.getRandomValues(new Uint8Array(8)); serial[0] &= 0x7f; if(serial[0] === 0) serial[0] = 1;
    const tbs = der(0x30, der(0xa0, der(2, new Uint8Array([2]))), der(2, serial), SIGALG, nameCN(cn), der(0x30, der(0x17, enc.encode("240101000000Z")), der(0x17, enc.encode("491231235959Z"))), nameCN(cn), spki);
    const sig = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, tbs));
    return { cert: der(0x30, tbs, SIGALG, der(3, new Uint8Array([0]), sig)), spki };
  }
  const KEY_LS = "choimini_apk_key_v1";
  async function getKey(){
    let saved = null; try{ saved = JSON.parse(global.localStorage.getItem(KEY_LS) || "null"); }catch(e){}
    const algo = { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" };
    if(saved && saved.pkcs8 && saved.cert && saved.spki){
      const priv = await subtle.importKey("pkcs8", b64ToU8(saved.pkcs8), algo, false, ["sign"]);
      return { priv, cert: b64ToU8(saved.cert), spki: b64ToU8(saved.spki), isNew:false };
    }
    const kp = await subtle.generateKey({ name:"RSASSA-PKCS1-v1_5", modulusLength:2048, publicExponent:new Uint8Array([1, 0, 1]), hash:"SHA-256" }, true, ["sign", "verify"]);
    const { cert, spki } = await makeCert(kp, "Choimini App Signing");
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
    try{ global.localStorage.setItem(KEY_LS, JSON.stringify({ pkcs8:u8ToB64(pkcs8), cert:u8ToB64(cert), spki:u8ToB64(spki) })); }catch(e){}
    const priv = await subtle.importKey("pkcs8", pkcs8, algo, false, ["sign"]);
    return { priv, cert, spki, isNew:true };
  }
  async function certFingerprint(cert){ const h = new Uint8Array(await subtle.digest("SHA-256", cert)); return [...h].map(x => x.toString(16).padStart(2, "0")).join(":"); }

  /* ---------------- APK Signature Scheme v2 ---------------- */
  const lp = b => concat([le32(b.length), b]);                  // length-prefixed
  const seq = list => concat(list.map(lp));
  async function sha(u){ return new Uint8Array(await subtle.digest("SHA-256", u)); }
  async function sectionDigests(u){ const out = []; for(let o = 0; o < u.length || (o === 0 && !u.length); o += 1048576){ const c = u.subarray(o, Math.min(u.length, o + 1048576)); out.push(await sha(concat([new Uint8Array([0xa5]), le32(c.length), c]))); if(!u.length) break; } return out; }
  async function signV2(sec1, cd, count, key){
    const eocd0 = eocd(count, cd.length, sec1.length);
    const chunks = [...await sectionDigests(sec1), ...await sectionDigests(cd), ...await sectionDigests(eocd0)];
    const top = await sha(concat([new Uint8Array([0x5a]), le32(chunks.length), ...chunks]));
    const ALGO = 0x0103;
    const digests = lp(concat([le32(ALGO), lp(top)]));
    const signedData = concat([lp(digests), lp(lp(key.cert)), lp(new Uint8Array(0))]);
    const sig = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key.priv, signedData));
    const signer = concat([lp(signedData), lp(lp(concat([le32(ALGO), lp(sig)]))), lp(key.spki)]);
    const value = lp(lp(signer));
    const pair = (id, v) => concat([le64(v.length + 4), le32(id), v]);
    const sigPair = pair(0x7109871a, value);
    const base = 32 + sigPair.length, padN = (4096 - ((base + 12) % 4096)) % 4096;
    const pairs = padN || (base % 4096) ? concat([sigPair, pair(0x42726577, new Uint8Array(padN))]) : sigPair;
    const block = concat([le64(pairs.length + 24), pairs, le64(pairs.length + 24), enc.encode("APK Sig Block 42")]);
    return concat([sec1, block, cd, eocd(count, cd.length, sec1.length + block.length)]);
  }

  /* ---------------- 빌드 ---------------- */
  const sanitizePkg = p => { p = String(p || "").toLowerCase().replace(/[^a-z0-9_.]/g, ""); const parts = p.split(".").filter(s => /^[a-z]/.test(s)); return parts.length >= 2 ? parts.join(".") : ""; };
  async function build(o){
    // o: { files:{ "index.html": Uint8Array, ... }, label, pkg, versionName, versionCode, url, permissions, orientation }
    if(!subtle) throw new Error("이 브라우저는 WebCrypto(https 필요)를 지원하지 않아요");
    const label = (o.label || "My App").slice(0, 60);
    const pkg = sanitizePkg(o.pkg) || ("com.choimini.app" + (label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "x"));
    const perms = (o.permissions && o.permissions.length) ? o.permissions : ["android.permission.INTERNET"];
    const manifest = buildAxml({ pkg, label, versionCode: o.versionCode || 1, versionName: o.versionName || "1.0", minSdk: 24, targetSdk: 34, permissions: perms, orientation: o.orientation });
    const entries = [{ name:"AndroidManifest.xml", data:manifest }, { name:"classes.dex", data:b64ToU8(DEX_B64) }];
    if(o.url) entries.push({ name:"assets/config.txt", data:enc.encode(o.url) });
    Object.keys(o.files || {}).sort().forEach(p => entries.push({ name:"assets/www/" + p.replace(/^\/+/, ""), data:o.files[p] }));
    if(!o.url && !(o.files && o.files["index.html"])) throw new Error("index.html 이 없어요 (프로젝트 폴더 바로 아래에 있어야 해요)");
    const { sec1, cd, count } = await zipParts(entries);
    const key = await getKey();
    const apk = await signV2(sec1, cd, count, key);
    return { apk, pkg, label, fingerprint: await certFingerprint(key.cert), newKey: key.isNew, entries: entries.length };
  }
  async function info(u){
    const z = await readZip(u); const out = { entries: z.map(e => ({ name:e.name, size:e.usize })), manifest:null, signed:false };
    const m = z.find(e => e.name === "AndroidManifest.xml"); if(m){ try{ out.manifest = decodeAxml(await m.read()); }catch(e){ out.manifest = "(매니페스트 해석 실패: " + e.message + ")"; } }
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); for(let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--){ if(dv.getUint32(i, true) === 0x06054b50){ const co = dv.getUint32(i + 16, true); const magic = dec.decode(u.subarray(co - 16, co)); out.signedV2 = magic === "APK Sig Block 42"; break; } }
    out.signedV1 = z.some(e => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(e.name));
    return out;
  }


  /* ---------------- Windows EXE (WebView 래퍼: 미리 빌드한 실행기 + 앱 파일 ZIP 을 이어붙임) ---------------- */
  const STUB_URLS = ["./choimini-exe-stub.bin", "https://untitled-hub.github.io/choimini/choimini-exe-stub.bin"];
  async function fetchStub(progress){
    let cache = null; try{ cache = await caches.open("choimini-stubs-v1"); const hit = await cache.match("exe-stub"); if(hit) return new Uint8Array(await hit.arrayBuffer()); }catch(e){}
    let lastErr = null;
    for(const u of STUB_URLS){
      try{
        const r = await fetch(u); if(!r.ok) throw new Error("HTTP " + r.status);
        const total = +r.headers.get("content-length") || 0; const reader = r.body && r.body.getReader ? r.body.getReader() : null; let buf;
        if(reader){ const parts = []; let got = 0; for(;;){ const { done, value } = await reader.read(); if(done) break; parts.push(value); got += value.length; if(progress && total) progress(Math.round(got / total * 100)); } buf = concat(parts); } else buf = new Uint8Array(await r.arrayBuffer());
        if(buf.length < 100000 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error("실행기 파일이 올바르지 않아요");
        try{ if(cache) await cache.put("exe-stub", new Response(buf)); }catch(e){}
        return buf;
      }catch(e){ lastErr = e; }
    }
    throw new Error("EXE 실행기(choimini-exe-stub.bin)를 내려받지 못했어요: " + (lastErr && lastErr.message));
  }
  async function buildExe(stub, o){
    const entries = [{ name:"__app.json", data:enc.encode(JSON.stringify({ name:o.label, width:o.width || 1100, height:o.height || 720, url:o.url || "" })) }];
    Object.keys(o.files || {}).sort().forEach(p => entries.push({ name:p.replace(/^\/+/, ""), data:o.files[p] }));
    if(!o.url && !(o.files && o.files["index.html"])) throw new Error("index.html 이 없어요 (프로젝트 폴더 바로 아래에 있어야 해요)");
    const { sec1, cd, count } = await zipParts(entries);
    const zip = concat([sec1, cd, eocd(count, cd.length, sec1.length)]);
    return { exe: concat([stub, zip, enc.encode("CHOIEXE1"), le64(zip.length)]), files: entries.length - 1 };
  }

  /* ---------------- 가상 터미널 명령어: apk ---------------- */
  function installShell(){
    const S = global.ChoiminiShell, FS = global.LinuxFS; if(!S || !FS || S.registry.apk) return !!(S && S.registry && S.registry.apk);
    const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";
    const absP = p => { try{ return FS.stat(p).path; }catch(e){ return FS.normPath(FS.joinPath(FS.pwd(), p)); } };
    function parse(a){ const o = { _:[], perm:[] }; for(let i = 0; i < a.length; i++){ const t = a[i]; const nx = () => a[++i]; if(t === "-n" || t === "--name") o.n = nx(); else if(t === "-p" || t === "--package") o.p = nx(); else if(t === "-v" || t === "--version") o.v = nx(); else if(t === "-c" || t === "--code") o.c = nx(); else if(t === "-o" || t === "--out") o.o = nx(); else if(t === "--url") o.url = nx(); else if(t === "--size") o.size = nx(); else if(t === "--perm") o.perm.push(nx()); else if(t === "--landscape") o.orient = 0; else if(t === "--portrait") o.orient = 1; else o._.push(t); } return o; }
    S.def("apk", "웹앱 폴더 → 설치 가능한 APK 빌드 (apk build|info|key). 터미널 안에서 SDK 없이 빌드·서명", async (a, io) => {
      const sub = a[0], o = parse(a.slice(1));
      try{
        if(sub === "build"){
          const dir = o._[0]; if(!dir && !o.url){ io.err += "사용법: apk build <프로젝트폴더> [-n 앱이름] [-p com.example.app] [-v 1.0] [-c 1] [-o out.apk] [--url https://…] [--perm android.permission.CAMERA] [--portrait|--landscape]\n"; return 1; }
          const files = {}; let total = 0;
          if(dir){
            const root = absP(dir); if(!FS.isDir(root)){ io.err += `apk: ${dir}: 폴더가 아니에요\n`; return 1; }
            FS.find(root).forEach(p => { const st = FS.stat(p); if(!st || st.type !== "file") return; const rel = p.slice(root === "/" ? 1 : root.length + 1); if(/(^|\/)(node_modules|\.git)\//.test(rel + "/") || /\.apk$/i.test(rel)) return; const u = S.getBytes(p); files[rel] = u; total += u.length; });
            if(!Object.keys(files).length){ io.err += "apk: 폴더가 비어 있어요\n"; return 1; }
          }
          if(total > 200 * 1048576){ io.err += "apk: 프로젝트가 너무 커요 (200MB 초과)\n"; return 1; }
          const label = o.n || (dir ? dir.replace(/\/+$/, "").split("/").pop() : "My App");
          const r = await build({ files, label, pkg:o.p, versionName:o.v, versionCode:o.c ? parseInt(o.c, 10) : 1, url:o.url, permissions:o.perm.length ? ["android.permission.INTERNET"].concat(o.perm) : null, orientation:o.orient });
          let out = o.o || (label.replace(/[^\w.\-가-힣]+/g, "_") + ".apk"); if(!/\.apk$/i.test(out)) out += ".apk";
          const dataUrl = "data:application/vnd.android.package-archive;base64," + u8ToB64(r.apk);
          FS.writeFile(out, dataUrl, "application/vnd.android.package-archive");
          io.out += `APK 빌드 완료: ${absP(out)} (${fmt(r.apk.length)})\n  앱 이름: ${r.label}\n  패키지: ${r.pkg}\n  파일 ${Object.keys(files).length}개 → assets/www/${o.url ? "  (시작 주소: " + o.url + ")" : ""}\n  서명: v2 (SHA-256 ${r.fingerprint.slice(0, 23)}…)${r.newKey ? "\n  ※ 이 브라우저에서 처음 서명 키를 만들었어요. 같은 키로 서명해야 앱 업데이트(덮어쓰기 설치)가 돼요." : ""}\n  설치: 파일 패널에서 APK 를 다운로드해 폰에서 열면 돼요 (알 수 없는 앱 설치 허용 필요, Android 7.0+).\n`;
          return 0;
        }
        if(sub === "info"){
          const p = o._[0]; if(!p){ io.err += "사용법: apk info <파일.apk>\n"; return 1; }
          const i = await info(S.getBytes(p));
          io.out += `파일 ${i.entries.length}개 · 서명: ${i.signedV2 ? "v2" : ""}${i.signedV1 ? " v1" : ""}${!i.signedV2 && !i.signedV1 ? "없음" : ""}\n` + i.entries.slice(0, 60).map(e => `  ${String(e.size).padStart(9)}  ${e.name}`).join("\n") + (i.entries.length > 60 ? `\n  …(${i.entries.length - 60}개 더)` : "") + "\n";
          if(i.manifest) io.out += "\n[AndroidManifest.xml]\n" + i.manifest + "\n";
          return 0;
        }
        if(sub === "key"){
          if(o._[0] === "reset"){ try{ global.localStorage.removeItem(KEY_LS); }catch(e){} io.out += "서명 키를 삭제했어요. 다음 빌드에서 새 키가 만들어지며, 예전 키로 설치한 앱은 덮어쓰기 설치가 안 돼요.\n"; return 0; }
          const k = await getKey(); io.out += `서명 인증서 SHA-256: ${await certFingerprint(k.cert)}${k.isNew ? "\n(방금 새로 만들었어요)" : ""}\n`; return 0;
        }
      }catch(e){ io.err += `apk: ${e.message}\n`; return 1; }
      io.err += "사용법: apk build <폴더> [옵션] | apk info <apk> | apk key [reset]\n"; return 1;
    });

    S.def("exe", "웹앱 폴더 → Windows 실행 파일(.exe) 빌드 (exe build). 터미널 안에서 SDK 없이 빌드", async (a, io) => {
      const sub = a[0], o = parse(a.slice(1));
      if(sub !== "build"){ io.err += "사용법: exe build <프로젝트폴더> [-n 앱이름] [-o out.exe] [--size 1100x720] [--url https://…]\n"; return 1; }
      try{
        const dir = o._[0]; if(!dir && !o.url){ io.err += "exe: 프로젝트 폴더나 --url 이 필요해요\n"; return 1; }
        const files = {}; let total = 0;
        if(dir){
          const root = absP(dir); if(!FS.isDir(root)){ io.err += `exe: ${dir}: 폴더가 아니에요\n`; return 1; }
          FS.find(root).forEach(p => { const st = FS.stat(p); if(!st || st.type !== "file") return; const rel = p.slice(root === "/" ? 1 : root.length + 1); if(/(^|\/)(node_modules|\.git)\//.test(rel + "/") || /\.(exe|apk)$/i.test(rel)) return; const u = S.getBytes(p); files[rel] = u; total += u.length; });
          if(!Object.keys(files).length){ io.err += "exe: 폴더가 비어 있어요\n"; return 1; }
        }
        if(total > 250 * 1048576){ io.err += "exe: 프로젝트가 너무 커요 (250MB 초과)\n"; return 1; }
        const m = /^(\d+)x(\d+)$/.exec(o.size || ""); const label = o.n || (dir ? dir.replace(/\/+$/, "").split("/").pop() : "App");
        const prog = (t, p, d) => { try{ global.dispatchEvent(new CustomEvent("choimini-terminal-progress", { detail:{ text:t, pct:p, done:!!d } })); }catch(e){} };
        prog("EXE 실행기 다운로드중... (최초 1회, 약 6MB)", 0);
        const stub = await fetchStub(p => prog("EXE 실행기 다운로드중... (최초 1회, 약 6MB)", p)); prog("EXE 실행기 준비 완료", 100, true);
        const r = await buildExe(stub, { files, label, url:o.url, width:m ? +m[1] : 1100, height:m ? +m[2] : 720 });
        let out = o.o || (label.replace(/[^\w.\-가-힣]+/g, "_") + ".exe"); if(!/\.exe$/i.test(out)) out += ".exe";
        FS.writeFile(out, "data:application/vnd.microsoft.portable-executable;base64," + u8ToB64(r.exe), "application/vnd.microsoft.portable-executable");
        io.out += `EXE 빌드 완료: ${absP(out)} (${fmt(r.exe.length)})\n  앱 이름: ${label}\n  파일 ${r.files}개 포함${o.url ? " (시작 주소: " + o.url + ")" : ""}\n  실행: Windows 10/11 에서 더블클릭 (Edge/Chrome 이 앱 창으로 열려요)\n  ※ 서명되지 않은 파일이라 처음 실행 때 SmartScreen 경고가 뜰 수 있어요 ("추가 정보 → 실행").\n`;
        return 0;
      }catch(e){ io.err += `exe: ${e.message}\n`; return 1; }
    });
    return true;
  }
  if(global.ChoiminiShell) installShell(); else global.addEventListener && global.addEventListener("load", installShell);

  global.ChoiminiApk = { buildExe, fetchStub, build, info, decodeAxml, buildAxml, readZip, zipParts, signV2, getKey, sanitizePkg, b64ToU8, u8ToB64 };
  if(typeof module !== "undefined" && module.exports) module.exports = global.ChoiminiApk;
})(typeof globalThis !== "undefined" ? globalThis : window);
