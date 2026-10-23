/* choimini-localai.js — 로컬 Gemma 모델(기기 안에서 실행)로 "빠른 판단"을 하는 모듈.
   - WebLLM(WebGPU)으로 Gemma 를 이 기기에 내려받아 실행한다. 서버로 아무것도 보내지 않고 토큰도 쓰지 않는다.
   - 사용자의 최초 동의 없이는 내려받거나 실행하지 않는다(settings.localAI.consent).
   - 기기 램(navigator.deviceMemory)과 WebGPU 지원에 맞춰 모델을 자동으로 고르거나, 사용자가 직접 고를 수 있다.
   - 쓸 수 없는 환경(WebGPU 없음, 램 부족, 내려받기 실패)이면 조용히 꺼지고 기존 클라우드 Lite 모델이 대신한다.
   전역: window.ChoiminiLocalAI */
(function () {
  "use strict";
  const WEBLLM_URL = function () { return window.CHOIMINI_WEBLLM_URL || "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm"; };

  /* 고를 수 있는 Gemma 모델 (WebLLM 0.2.86 기본 목록 기준). mb = 내려받기 크기 대략, vram = 실행에 필요한 GPU 메모리 */
  const MODELS = [
    { id: "gemma3-1b-it-q4f16_1-MLC",   label: "Gemma 3 1B",     mb: 711,  vram: 711,  f16: false, minRam: 2, ctx: 4096 },
    { id: "gemma-2b-it-q4f32_1-MLC",    label: "Gemma 2B (f32)",  mb: 1750, vram: 1750, f16: false, minRam: 4, ctx: 4096 },
    { id: "gemma-2-2b-it-q4f16_1-MLC",  label: "Gemma 2 2B",      mb: 1895, vram: 1895, f16: true,  minRam: 4, ctx: 4096 },
    { id: "gemma-2-2b-it-q4f32_1-MLC",  label: "Gemma 2 2B (f32)", mb: 2509, vram: 2509, f16: false, minRam: 6, ctx: 4096 },
    { id: "gemma-4-E2B-it-q4f16_1-MLC", label: "Gemma 4 E2B",     mb: 3387, vram: 3387, f16: true,  minRam: 8, ctx: 4096 },
    { id: "gemma-2-9b-it-q4f16_1-MLC",  label: "Gemma 2 9B",      mb: 6422, vram: 6422, f16: true,  minRam: 16, ctx: 4096 },
  ];
  const byId = function (id) { return MODELS.find(function (m) { return m.id === id; }) || null; };

  const st = { wgpu: null, f16: false, ramGB: 0, webllm: null, engine: null, modelId: "", state: "idle", progress: 0, text: "", error: "", loading: null };
  const listeners = [];
  function emit() { listeners.slice().forEach(function (cb) { try { cb(status()); } catch (e) {} }); }
  function set(p) { Object.assign(st, p); emit(); }

  async function probe() {
    if (st.wgpu !== null) return st;
    let ok = false, f16 = false;
    try {
      if (navigator.gpu && navigator.gpu.requestAdapter) {
        const ad = await navigator.gpu.requestAdapter();
        if (ad) { ok = true; f16 = !!(ad.features && ad.features.has && ad.features.has("shader-f16")); }
      }
    } catch (e) { ok = false; }
    const dm = Number(navigator.deviceMemory);   // Chrome 계열만 제공(최대 8로 잘려서 보고됨). 모르면 4 로 가정(보수적)
    st.ramGB = dm > 0 ? dm : 4;
    st.ramKnown = dm > 0;
    st.f16 = f16; st.wgpu = ok;
    return st;
  }

  /* 램에 비례해 자동으로 모델 결정. 램이 2GB 이하이거나 WebGPU 가 없으면 null(권장하지 않음) */
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
    const c = cfg();
    if (c.model && c.model !== "auto") return byId(c.model);
    return recommend(st.ramGB, st.f16);
  }

  function status() {
    const c = cfg(); const m = pickModel();
    return {
      supported: !!st.wgpu, f16: st.f16, ramGB: st.ramGB, ramKnown: !!st.ramKnown,
      enabled: c.enabled, consent: c.consent, choice: c.model, model: m, models: MODELS,
      state: st.state, progress: st.progress, text: st.text, error: st.error, loadedId: st.modelId,
      ready: st.state === "ready" && !!st.engine,
    };
  }

  /* 모델 내려받기 + 메모리에 올리기. 동의가 없으면 아무것도 하지 않는다. */
  async function load() {
    if (st.loading) return st.loading;
    const c = cfg();
    if (!c.enabled || !c.consent) return false;
    st.loading = (async function () {
      try {
        await probe();
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
    try { if (st.engine) await st.engine.unload(); } catch (e) {}
    st.engine = null; set({ state: "idle", progress: 0, text: "", modelId: "" });
  }
  /* 내려받은 모델 파일 지우기(저장공간 확보) */
  async function clearCache() {
    try {
      await unload();
      if (!st.webllm) st.webllm = await import(/* @vite-ignore */ WEBLLM_URL());
      for (const m of MODELS) { try { if (await st.webllm.hasModelInCache(m.id)) await st.webllm.deleteModelAllInfoInCache(m.id); } catch (e) {} }
      return true;
    } catch (e) { return false; }
  }

  function ready() { const c = cfg(); return c.enabled && c.consent && st.state === "ready" && !!st.engine; }

  /* messages: [{role:"system"|"user"|"assistant", content}] → 문자열. 스트리밍 onDelta(text). signal 로 중단 */
  async function generate(messages, opt) {
    opt = opt || {};
    if (!ready()) throw new Error("local model not ready");
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
    MODELS: MODELS, probe: probe, recommend: recommend, usable: usable, status: status, load: load, unload: unload,
    clearCache: clearCache, bind: function (fn) { getSettings = fn; }, ready: ready, generate: generate, pickModel: pickModel,
    onChange: function (cb) { listeners.push(cb); },
  };
})();
