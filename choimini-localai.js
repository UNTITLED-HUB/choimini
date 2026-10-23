/* choimini-localai.js — 로컬 Gemma 모델(기기 안에서 실행)로 "빠른 판단"을 하는 모듈.
   두 가지 엔진 중 쓸 수 있는 것을 자동으로 고른다:
     · native — Android 앱 안의 MediaPipe(AndroidBridge.localLlm*). 사용자가 받아 둔 Gemma .task 파일을 골라서 쓴다.
     · webgpu — WebLLM(WebGPU). 브라우저/Windows 앱/크롬 확장처럼 WebGPU 가 되는 곳. 모델을 알아서 내려받는다.
   - 서버로 아무것도 보내지 않고 토큰도 쓰지 않는다.
   - 사용자의 최초 동의 없이는 내려받거나 실행하지 않는다(settings.localAI.consent).
   - 기기 램에 맞춰 모델을 자동 추천하거나 사용자가 직접 고를 수 있다.
   - 쓸 수 없는 환경이면 이유와 해결 방법을 안내하고, 빠른 판단은 기존 클라우드 Lite 모델이 대신한다.
   전역: window.ChoiminiLocalAI */
(function () {
  "use strict";
  const WEBLLM_URL = function () { return window.CHOIMINI_WEBLLM_URL || "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm"; };

  /* ---- webgpu 엔진용 모델 (WebLLM 0.2.86 기본 목록). mb = 내려받기 크기 대략 ---- */
  const MODELS = [
    { id: "gemma3-1b-it-q4f16_1-MLC",   label: "Gemma 3 1B",     mb: 711,  f16: false, minRam: 2, ctx: 4096 },
    { id: "gemma-2b-it-q4f32_1-MLC",    label: "Gemma 2B (f32)",  mb: 1750, f16: false, minRam: 4, ctx: 4096 },
    { id: "gemma-2-2b-it-q4f16_1-MLC",  label: "Gemma 2 2B",      mb: 1895, f16: true,  minRam: 4, ctx: 4096 },
    { id: "gemma-2-2b-it-q4f32_1-MLC",  label: "Gemma 2 2B (f32)", mb: 2509, f16: false, minRam: 6, ctx: 4096 },
    { id: "gemma-4-E2B-it-q4f16_1-MLC", label: "Gemma 4 E2B",     mb: 3387, f16: true,  minRam: 8, ctx: 4096 },
    { id: "gemma-2-9b-it-q4f16_1-MLC",  label: "Gemma 2 9B",      mb: 6422, f16: true,  minRam: 16, ctx: 4096 },
  ];
  const byId = function (id) { return MODELS.find(function (m) { return m.id === id; }) || null; };

  /* ---- native 엔진용 안내 (Hugging Face 의 LiteRT 커뮤니티 Gemma .task 파일. 라이선스 동의 + 로그인 필요) ---- */
  const NATIVE_GUIDE = [
    { key: "gemma3-1b", label: "Gemma 3 1B", approxMB: 550,  minRamGB: 3, url: "https://huggingface.co/litert-community/Gemma3-1B-IT" },
    { key: "gemma2-2b", label: "Gemma 2 2B", approxMB: 2500, minRamGB: 6, url: "https://huggingface.co/litert-community/Gemma2-2B-IT" },
  ];
  function recommendNative(ramGB) {
    if (!(ramGB >= 3)) return null;
    return ramGB >= 6 ? NATIVE_GUIDE[1] : NATIVE_GUIDE[0];
  }

  const NB = function () { const b = window.AndroidBridge; return (b && typeof b.localLlmStatus === "function") ? b : null; };

  const st = { backend: "", wgpu: null, f16: false, ramGB: 0, ramKnown: false, webllm: null, engine: null, modelId: "", state: "idle", progress: 0, text: "", error: "", loading: null, native: null };
  const listeners = [];
  function emit() { listeners.slice().forEach(function (cb) { try { cb(status()); } catch (e) {} }); }
  function set(p) { Object.assign(st, p); emit(); }

  function nativeStatus() { try { return JSON.parse(NB().localLlmStatus()); } catch (e) { return { available: false }; } }

  async function probe() {
    if (st.backend) { if (st.backend === "native") { st.native = nativeStatus(); st.ramGB = Math.round((st.native.ramMB || 0) / 1024 * 10) / 10; } return st; }
    if (NB()) {
      const ns = nativeStatus();
      if (ns && ns.available) {
        st.backend = "native"; st.native = ns; st.wgpu = true;
        st.ramGB = Math.round((ns.ramMB || 0) / 1024 * 10) / 10; st.ramKnown = ns.ramMB > 0;
        if (st.state === "idle" && !ns.hasModel) st.state = "needs-model";
        return st;
      }
    }
    let ok = false, f16 = false;
    try {
      if (navigator.gpu && navigator.gpu.requestAdapter) {
        const ad = await navigator.gpu.requestAdapter();
        if (ad) { ok = true; f16 = !!(ad.features && ad.features.has && ad.features.has("shader-f16")); }
      }
    } catch (e) { ok = false; }
    const dm = Number(navigator.deviceMemory);   // Chrome 계열만 제공(최대 8로 잘려서 보고됨). 모르면 4 로 가정(보수적)
    st.backend = "webgpu"; st.ramGB = dm > 0 ? dm : 4; st.ramKnown = dm > 0; st.f16 = f16; st.wgpu = ok;
    return st;
  }

  /* 램에 비례해 자동으로 모델 결정(webgpu). 램이 2GB 이하이거나 WebGPU 가 없으면 null(권장하지 않음) */
  function recommend(ramGB, f16) {
    if (!(ramGB > 2)) return null;
    let want;
    if (ramGB <= 4) want = "gemma3-1b-it-q4f16_1-MLC";
    else if (ramGB <= 6) want = f16 ? "gemma-2-2b-it-q4f16_1-MLC" : "gemma-2-2b-it-q4f32_1-MLC";
    else want = f16 ? "gemma-4-E2B-it-q4f16_1-MLC" : "gemma-2-2b-it-q4f32_1-MLC";
    return byId(want);
  }
  function usable(m, ramGB, f16) { return !!m && (!m.f16 || f16) && ramGB >= m.minRam; }

  let getSettings = function () { return (window.settings) || {}; };
  function cfg() {
    const s = (getSettings().localAI) || {};
    return { enabled: !!s.enabled, consent: !!s.consent, model: s.model || "auto" };
  }
  function pickModel() {
    if (st.backend === "native") return null;
    const c = cfg();
    if (c.model && c.model !== "auto") return byId(c.model);
    return recommend(st.ramGB, st.f16);
  }

  /* "이 기기에서 로컬 AI 를 쓸 수 있는가" — 채팅창 배너/설정 안내용 */
  function possible() {
    if (st.backend === "native") return !!recommendNative(st.ramGB);
    return !!st.wgpu && !!recommend(st.ramGB, st.f16);
  }

  function status() {
    const c = cfg(); const m = pickModel();
    const native = st.backend === "native";
    return {
      backend: st.backend, native: native,
      supported: !!st.wgpu, f16: st.f16, ramGB: st.ramGB, ramKnown: !!st.ramKnown,
      enabled: c.enabled, consent: c.consent, choice: c.model, model: m, models: MODELS,
      guide: native ? NATIVE_GUIDE : null, nativeRecommend: native ? recommendNative(st.ramGB) : null,
      hasModelFile: native ? !!(st.native && st.native.hasModel) : null,
      modelName: native && st.native ? st.native.modelName : "", modelMB: native && st.native ? st.native.modelMB : 0,
      possible: possible(),
      state: st.state, progress: st.progress, text: st.text, error: st.error, loadedId: st.modelId,
      ready: st.state === "ready" && (native || !!st.engine),
    };
  }

  /* ---------------- native 엔진 ---------------- */
  const pending = {};   // id → {resolve,reject,timer}
  let nativeLoadWait = null;
  window.__choiminiLocalLlmEvent = function (json) {
    let e; try { e = JSON.parse(json); } catch (x) { return; }
    if (e.type === "copy") set({ state: "copying", progress: e.pct || 0, text: (e.name || "모델") + " 가져오는 중…", error: "" });
    else if (e.type === "copied") { st.native = nativeStatus(); set({ state: "idle", progress: 100, text: "", error: "" }); if (cfg().enabled && cfg().consent) load(); }
    else if (e.type === "cancel") { set({ state: st.native && st.native.hasModel ? "idle" : "needs-model" }); }
    else if (e.type === "deleted") { st.native = nativeStatus(); set({ state: "needs-model", progress: 0, text: "", modelId: "" }); }
    else if (e.type === "loaded") { st.native = nativeStatus(); set({ state: "ready", progress: 100, text: "준비됨", error: "", modelId: "native" }); if (nativeLoadWait) { nativeLoadWait(true); nativeLoadWait = null; } }
    else if (e.type === "error") { st.native = nativeStatus(); set({ state: "error", error: String(e.msg || "오류"), text: "" }); if (nativeLoadWait) { nativeLoadWait(false); nativeLoadWait = null; } }
    else if (e.type === "result") {
      const p = pending[e.id]; if (!p) return; delete pending[e.id]; clearTimeout(p.timer);
      if (e.error) p.reject(new Error(e.error)); else p.resolve(String(e.text || ""));
    }
  };
  function pickNativeModel() { if (NB()) { set({ state: "copying", progress: 0, text: "파일 선택 중…" }); NB().localLlmPickModel(); } }

  /* Gemma 대화 형식 (system 역할이 없어서 첫 user 턴에 합친다) */
  function gemmaPrompt(messages) {
    let sys = "", out = "";
    messages.forEach(function (m) {
      if (m.role === "system") sys += (sys ? "\n" : "") + m.content;
      else {
        const role = m.role === "assistant" ? "model" : "user";
        const body = (role === "user" && sys ? sys + "\n\n" : "") + m.content; if (role === "user") sys = "";
        out += "<start_of_turn>" + role + "\n" + body + "<end_of_turn>\n";
      }
    });
    return out + "<start_of_turn>model\n";
  }

  /* ---------------- 공통: 불러오기 / 끄기 / 지우기 ---------------- */
  async function load() {
    if (st.loading) return st.loading;
    const c = cfg();
    if (!c.enabled || !c.consent) return false;
    st.loading = (async function () {
      try {
        await probe();
        if (st.backend === "native") {
          if (!recommendNative(st.ramGB) && !(st.native && st.native.hasModel)) { set({ state: "unsupported", error: "램이 부족해서 로컬 모델을 쓰기 어려워요(클라우드 Lite 사용)", text: "" }); return false; }
          if (!st.native.hasModel) { set({ state: "needs-model", error: "", text: "" }); return false; }
          if (st.state === "ready") return true;
          set({ state: "loading", progress: 0, error: "", text: "모델을 메모리에 올리는 중… (처음엔 1분 정도 걸릴 수 있어요)" });
          const done = new Promise(function (res) { nativeLoadWait = res; });
          NB().localLlmLoad();
          return await done;
        }
        if (!st.wgpu) { set({ state: "unsupported", error: "이 기기/앱은 WebGPU 를 지원하지 않아요", text: "" }); return false; }
        const m = pickModel();
        if (!m) { set({ state: "unsupported", error: "램이 부족해서 로컬 모델을 쓰지 않아요(클라우드 Lite 사용)", text: "" }); return false; }
        if (!usable(m, st.ramGB, st.f16)) { set({ state: "unsupported", error: m.label + " 은(는) 이 기기에서 실행하기 어려워요", text: "" }); return false; }
        if (st.engine && st.modelId === m.id) { set({ state: "ready" }); return true; }
        if (st.engine) { try { await st.engine.unload(); } catch (e) {} st.engine = null; }
        set({ state: "loading", progress: 0, error: "", text: m.label + " 준비 중…" });
        if (!st.webllm) st.webllm = await import(/* @vite-ignore */ WEBLLM_URL());
        const engine = await st.webllm.CreateMLCEngine(m.id, {
          initProgressCallback: function (r) { set({ progress: Math.round(((r && r.progress) || 0) * 100), text: (r && r.text) || "" }); },
        }, { context_window_size: m.ctx });
        st.engine = engine;
        set({ state: "ready", modelId: m.id, progress: 100, text: m.label + " 준비됨", error: "" });
        return true;
      } catch (e) {
        st.engine = null;
        set({ state: "error", error: "로컬 모델을 불러오지 못했어요: " + String((e && e.message) || e).slice(0, 140), text: "" });
        return false;
      } finally { st.loading = null; }
    })();
    return st.loading;
  }

  async function unload() {
    if (st.backend === "native") { try { NB().localLlmUnload(); } catch (e) {} set({ state: st.native && st.native.hasModel ? "idle" : "needs-model", progress: 0, text: "", modelId: "" }); return; }
    try { if (st.engine) await st.engine.unload(); } catch (e) {}
    st.engine = null; set({ state: "idle", progress: 0, text: "", modelId: "" });
  }
  /* 내려받은/가져온 모델 파일 지우기(저장공간 확보) */
  async function clearCache() {
    try {
      if (st.backend === "native") { NB().localLlmDelete(); return true; }
      await unload();
      if (!st.webllm) st.webllm = await import(/* @vite-ignore */ WEBLLM_URL());
      for (const m of MODELS) { try { if (await st.webllm.hasModelInCache(m.id)) await st.webllm.deleteModelAllInfoInCache(m.id); } catch (e) {} }
      return true;
    } catch (e) { return false; }
  }

  function ready() { const c = cfg(); return c.enabled && c.consent && st.state === "ready" && (st.backend === "native" || !!st.engine); }
  /* 프롬프트에 넣을 이전 결과 글자 수 한도(엔진별 문맥 길이) */
  function ctxChars() { return st.backend === "native" ? 1300 : 2200; }

  /* messages: [{role:"system"|"user"|"assistant", content}] → {text, usage}. signal 로 중단 */
  async function generate(messages, opt) {
    opt = opt || {};
    if (!ready()) throw new Error("local model not ready");
    if (st.backend === "native") {
      if (opt.signal && opt.signal.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      const id = "g" + Date.now() + Math.random().toString(36).slice(2, 6);
      const p = new Promise(function (resolve, reject) {
        const timer = setTimeout(function () { delete pending[id]; reject(new Error("local model timeout")); }, opt.timeoutMs || 60000);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        if (opt.signal) opt.signal.addEventListener("abort", function () { if (pending[id]) { clearTimeout(timer); delete pending[id]; const e = new Error("aborted"); e.name = "AbortError"; reject(e); } }, { once: true });
      });
      NB().localLlmGenerate(id, gemmaPrompt(messages));
      const text = await p;
      return { text: text, usage: null };
    }
    const engine = st.engine;
    let aborted = false;
    const onAbort = function () { aborted = true; try { engine.interruptGenerate(); } catch (e) {} };
    if (opt.signal) { if (opt.signal.aborted) onAbort(); else opt.signal.addEventListener("abort", onAbort, { once: true }); }
    let acc = "", usage = null;
    try {
      const it = await engine.chat.completions.create({
        messages: messages, stream: true, temperature: opt.temperature == null ? 0.2 : opt.temperature,
        max_tokens: opt.maxTokens || 320, stream_options: { include_usage: true },
      });
      for await (const ch of it) {
        const d = ch && ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
        if (d) { acc += d; if (opt.onDelta) opt.onDelta(acc); }
        if (ch && ch.usage) usage = ch.usage;
      }
    } finally { if (opt.signal) opt.signal.removeEventListener("abort", onAbort); }
    if (aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return { text: acc, usage: usage };
  }

  window.ChoiminiLocalAI = {
    MODELS: MODELS, NATIVE_GUIDE: NATIVE_GUIDE, probe: probe, recommend: recommend, recommendNative: recommendNative, usable: usable, status: status,
    load: load, unload: unload, clearCache: clearCache, ready: ready, generate: generate, pickModel: pickModel, possible: possible,
    pickNativeModel: pickNativeModel, ctxChars: ctxChars, gemmaPrompt: gemmaPrompt,
    bind: function (fn) { getSettings = fn; },
    onChange: function (cb) { listeners.push(cb); },
  };
})();
