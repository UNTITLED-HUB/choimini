/* ============================================================
   Choimini 공용 인증 + 토큰 모듈 (Google 로그인 필수)
   - Android / Chrome / Desktop 세 앱이 모두 이 웹앱을 로드하므로,
     이 파일 하나로 로그인/토큰 로직을 공유한다.
   - 답변(채팅) 데이터는 서버에 올리지 않는다. 토큰만 계정 단위로 공유.
   - index.html <head>에서 supabase-js v2 로드 후 이 파일을 로드:
       <script src="https://esm.sh/@supabase/supabase-js@2"></script>  // 또는 UMD 번들
       <script src="./choimini-auth.js"></script>
   ============================================================ */
(function () {
  "use strict";

  const SUPABASE_URL = "https://cfozaatwytsitimvjkyz.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmb3phYXR3eXRzaXRpbXZqa3l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1Njc5MjYsImV4cCI6MjEwNTE0MzkyNn0.HXpMHM9RyaP51m4hGP5DS8hlQHs1nMqmDDuea5W1Nnc";

  // 앱 종류: 네이티브 래퍼(Android/Desktop)가 로드 전에 window에 주입한다.
  //   window.CHOIMINI_APP = "web" | "android" | "chrome" | "desktop"
  // Chrome 확장은 iframe이라 window에 주입할 수 없어서 URL 파라미터(?app=chrome)로 알려준다.
  const _urlApp = new URLSearchParams(window.location.search).get("app");
  const APP = window.CHOIMINI_APP || (_urlApp === "chrome" ? "chrome" : "web");

  // WebView(Android/Desktop)에서는 구글이 임베디드 웹뷰 내 OAuth를 차단하므로,
  // OAuth URL을 네이티브가 "시스템 브라우저"로 열도록 위임한다.
  //   - Android: window.AndroidBridge.openAuth(url)
  //   - Desktop: window.DesktopBridge.openAuth(url)
  // 로그인 성공 후 네이티브가 딥링크(choimini://auth?...)를 받아
  // window.__choiminiHandleAuthCallback(fullUrl) 를 호출해준다.

  /* ---------------- Desktop 앱 Google 로그인: 시스템 브라우저 쪽 처리 ----------------
     앱 → 시스템 브라우저로 "<사이트>?desktop_login=<Supabase 로그인 주소>" 를 연다.
       ① 이 탭(OS 가 연 탭)은 버튼 한 번으로 로그인 창을 "스크립트로" 열고 스스로 닫는다
          (브라우저는 스크립트가 연 창 / 기록이 1개뿐인 탭만 스크립트로 닫을 수 있다).
       ② 로그인을 마치면 그 창이 사이트(?code=...)로 돌아온다 → choimini://auth-callback 으로 앱에 code 를 넘기고,
          앱이 로그인을 끝냈다고 서버에 표시(handoff_mark)하면 그걸 확인한 뒤 창을 닫는다.
          (확인 전에 닫으면 "앱 열기" 확인창까지 같이 닫혀 버려서 앱이 code 를 못 받는다)
     PKCE 검증값은 앱(웹뷰)에만 있으므로, 이 브라우저에서는 code 를 세션으로 바꾸지 않는다. */
  const HANDOFF_KEY = "choimini.desktopHandoff";
  const _q0 = new URLSearchParams(window.location.search);
  function handoffStub() {
    window.CHOIMINI_SKIP_CLOUDFLARE = true; // 이 페이지는 안내 화면만 보여 준다 (Cloudflare 확인 불필요)
    window.ChoiminiAuth = { onReady: function () {}, onAuthChange: function () {}, isLoggedIn: function () { return false; }, getUser: function () { return null; },
      getAccessToken: async function () { return null; }, getBalance: async function () { return 0; }, spend: async function () { return { ok: false, balance: 0 }; }, login: function () {}, logout: function () {} };
    document.documentElement.classList.add("choimini-handoff");
    const st = document.createElement("style");
    st.textContent = "html.choimini-handoff body>*:not(#choiminiHandoff){display:none!important}#choiminiHandoff{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0b0f;color:#e7e9f2;font-family:-apple-system,'Segoe UI',Pretendard,sans-serif;z-index:2147483647}#choiminiHandoff .b{background:#12151f;border:1px solid #262b40;border-radius:16px;padding:28px 26px;width:min(380px,90vw);text-align:center}#choiminiHandoff .l{width:46px;height:46px;border-radius:50%;background:#3b82f6;color:#fff;font-weight:700;font-size:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px}#choiminiHandoff h1{font-size:17px;margin:0 0 8px}#choiminiHandoff p{font-size:13px;color:#8891a8;margin:0 0 16px;line-height:1.6}#choiminiHandoff button{width:100%;padding:11px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-top:6px}#choiminiHandoff button.s{background:#1c2030;color:#c8cde0}";
    (document.head || document.documentElement).appendChild(st);
  }
  function handoffRender(html) {
    const put = function () {
      let el = document.getElementById("choiminiHandoff");
      if (!el) { el = document.createElement("div"); el.id = "choiminiHandoff"; document.body.appendChild(el); }
      el.innerHTML = '<div class="b"><div class="l">최</div>' + html + "</div>";
    };
    if (document.body) put(); else document.addEventListener("DOMContentLoaded", put);
  }
  function randNonce() { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  let handoffMode = false;
  if (APP === "web") {
    const launchUrl = _q0.get("desktop_login");
    const code0 = _q0.get("code");
    let pending = null; try { pending = JSON.parse(localStorage.getItem(HANDOFF_KEY) || "null"); } catch (e) {}
    if (launchUrl && launchUrl.indexOf(SUPABASE_URL + "/auth/v1/authorize?") === 0) {
      // ① 시작 탭
      handoffMode = true; handoffStub();
      try { localStorage.setItem(HANDOFF_KEY, JSON.stringify({ t: Date.now(), n: randNonce() })); } catch (e) {}
      history.replaceState(null, "", location.pathname);
      handoffRender('<h1>Choimini Desktop 로그인</h1><p>아래 버튼을 누르면 Google 로그인 창이 열려요.<br>로그인이 끝나면 창은 자동으로 닫혀요.</p><button id="hoGo">Google 계정으로 계속</button>');
      document.addEventListener("click", function (e) {
        if (!e.target || e.target.id !== "hoGo") return;
        const w = window.open(launchUrl, "choimini-login", "width=520,height=680");
        if (!w) { location.replace(launchUrl); return; } // 팝업 차단 → 이 탭에서 진행
        setTimeout(function () { window.close(); handoffRender("<h1>로그인 창이 열렸어요</h1><p>열린 창에서 로그인을 마쳐 주세요.<br>이 탭은 닫아도 돼요.</p>"); }, 300);
      });
    } else if (code0 && pending && Date.now() - (pending.t || 0) < 15 * 60 * 1000) {
      // ② 로그인 완료 → 앱으로 전달
      handoffMode = true; handoffStub();
      try { localStorage.removeItem(HANDOFF_KEY); } catch (e) {}
      history.replaceState(null, "", location.pathname);
      const nonce = pending.n || "";
      const deep = "choimini://auth-callback?code=" + encodeURIComponent(code0) + "&n=" + encodeURIComponent(nonce);
      handoffRender('<h1>✅ 로그인 완료</h1><p id="hoMsg">Choimini Desktop 으로 돌아가는 중이에요…<br>"앱 열기" 확인창이 뜨면 <b>열기</b>를 눌러 주세요.</p><button id="hoOpen">앱 열기</button><button id="hoClose" class="s">이 창 닫기</button>');
      const launch = function () { location.href = deep; };
      setTimeout(launch, 150);
      document.addEventListener("click", function (e) { if (!e.target) return; if (e.target.id === "hoOpen") launch(); else if (e.target.id === "hoClose") window.close(); });
      const msg = function (h) { const m = document.getElementById("hoMsg"); if (m) m.innerHTML = h; };
      const started = Date.now();
      const poll = async function () {
        let done = false;
        try {
          const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/handoff_check", { method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }, body: JSON.stringify({ p_nonce: nonce }) });
          done = r.ok && (await r.json()) === true;
        } catch (e) {}
        if (done) {
          msg("앱에서 로그인이 끝났어요. 이 창을 닫을게요.");
          setTimeout(function () { window.close(); setTimeout(function () { msg("앱에서 로그인이 끝났어요.<br><b>이 탭은 닫아도 돼요.</b>"); }, 400); }, 600);
          return;
        }
        if (Date.now() - started > 3 * 60 * 1000) { msg('앱이 열리지 않았나요? <b>앱 열기</b>를 다시 눌러 보세요.<br>로그인이 끝났다면 이 탭은 닫아도 돼요.'); return; }
        setTimeout(poll, 1500);
      };
      if (nonce) setTimeout(poll, 1500);
    }
  }
  if (handoffMode) return;

  const isWebView = APP === "android" || APP === "desktop" || APP === "desktop-code";
  // Chrome 확장 사이드 패널은 iframe 이라 구글이 로그인 화면을 막는다 → 부모(확장)에게 "실제 탭으로 열어 달라"고 요청하고,
  // 로그인 후 돌아온 code 를 postMessage 로 받는다. (PKCE verifier 는 이 iframe 이 보관하므로 여기서만 세션으로 교환된다)
  const isChromeExt = APP === "chrome";
  const isExternalAuth = isWebView || isChromeExt;

  const isDesktopApp = APP === "desktop" || APP === "desktop-code";
  // Desktop 은 시스템 브라우저에서 사이트로 돌아온 뒤(위의 ②) 앱으로 넘긴다 → 로그인 창을 자동으로 닫을 수 있다
  const REDIRECT_TO = isDesktopApp
    ? (/^https:/.test(window.location.protocol) ? window.location.origin + window.location.pathname : "choimini://auth-callback")
    : isWebView
    ? "choimini://auth-callback"
    : window.location.origin + window.location.pathname;   // 확장은 웹과 같은 주소(Supabase 허용 목록에 이미 있음)

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: !isExternalAuth, // 일반 브라우저는 자동 감지, 웹뷰/확장은 수동 처리
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "choimini.auth." + APP,
    },
  });

  let currentUser = null;
  const readyCallbacks = [];

  /* ---------------- 로그인 게이트 ---------------- */
  function showLoginGate() {
    let gate = document.getElementById("choiminiLoginGate");
    if (!gate) {
      gate = document.createElement("div");
      gate.id = "choiminiLoginGate";
      gate.innerHTML =
        '<div class="clg-box">' +
        '  <div class="clg-logo">최</div>' +
        '  <h1>최미나이 · Choimini</h1>' +
        '  <p>계속하려면 Google 계정으로 로그인하세요.</p>' +
        '  <button id="clgGoogleBtn" class="clg-google">' +
        '    <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
        '    <span>Google로 로그인</span>' +
        '  </button>' +
        '  <div class="clg-or"><span>또는 이메일 로그인 링크</span></div>' +
        '  <div id="clgEmailStep1" class="clg-row">' +
        '    <input id="clgEmail" type="email" autocomplete="email" placeholder="이메일 주소 (학교 계정 가능)" />' +
        '  </div>' +
        '  <div class="clg-row">' +
        '    <button id="clgSendBtn" class="clg-mini" style="flex:1;padding:11px 8px">Supabase 메일로 받기</button>' +
        '    <button id="clgCustomBtn" class="clg-mini" style="flex:1;padding:11px 8px;background:#6366f1">커스텀 메일로 받기</button>' +
        '  </div>' +
        '  <div id="clgError" class="clg-error"></div>' +
        '</div>';
      document.body.appendChild(gate);
      document.getElementById("clgGoogleBtn").addEventListener("click", login);
      document.getElementById("clgSendBtn").addEventListener("click", function () { sendEmailCode(false); });
      document.getElementById("clgCustomBtn").addEventListener("click", function () { sendEmailCode(true); });
      document.getElementById("clgEmail").addEventListener("keydown", function (e) { if (e.key === "Enter") sendEmailCode(false); });
    }
    gate.style.display = "flex";
    document.documentElement.classList.add("choimini-locked");
  }

  function hideLoginGate() {
    const gate = document.getElementById("choiminiLoginGate");
    if (gate) gate.style.display = "none";
    document.documentElement.classList.remove("choimini-locked");
  }

  function gateError(msg) {
    const el = document.getElementById("clgError");
    if (el) el.textContent = msg || "";
  }

  /* ---------------- 이메일 인증번호 로그인 (Google 이 막힌 학교/회사 계정용) ---------------- */
  let pendingEmail = "";
  async function sendCustomMail(email) {
    const res = await fetch(SUPABASE_URL + "/functions/v1/custom-mail-login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email, redirectTo: location.origin + location.pathname }),
    });
    let d = {}; try { d = await res.json(); } catch (e) {}
    if (res.ok && d.ok) return;
    if (d.error === "not_configured") throw new Error("커스텀 메일이 아직 설정되지 않았어요");
    if (d.error === "cooldown") throw new Error("rate limit: 1분 뒤에 다시 시도해줘");
    throw new Error(d.error || ("HTTP " + res.status));
  }
  /* 메일을 보낸 뒤 그 메일 서비스(웹메일)를 바로 연다. 아는 서비스만, Android 는 제외(앱 연결이 제대로 안 될 수 있음) */
  const MAIL_WEB = [
    [/^(gmail\.com|googlemail\.com)$/, "Gmail", function (e) { return "https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(e); }],
    [/^naver\.com$/, "네이버 메일", function () { return "https://mail.naver.com/"; }],
    [/^(daum\.net|hanmail\.net)$/, "Daum 메일", function () { return "https://mail.daum.net/"; }],
    [/^kakao\.com$/, "카카오메일", function () { return "https://mail.kakao.com/"; }],
    [/^nate\.com$/, "네이트 메일", function () { return "https://mail.nate.com/"; }],
    [/^(outlook\.(com|kr)|hotmail\.(com|co\.kr)|live\.(com|co\.kr)|msn\.com)$/, "Outlook", function () { return "https://outlook.live.com/mail/"; }],
    [/^(yahoo\.(com|co\.kr)|ymail\.com)$/, "Yahoo 메일", function () { return "https://mail.yahoo.com/"; }],
    [/^(icloud\.com|me\.com|mac\.com)$/, "iCloud 메일", function () { return "https://www.icloud.com/mail"; }],
    [/^(proton\.me|protonmail\.com|pm\.me)$/, "Proton Mail", function () { return "https://mail.proton.me/"; }],
  ];
  function mailService(email) {
    const dom = String(email.split("@")[1] || "").toLowerCase();
    for (const m of MAIL_WEB) if (m[0].test(dom)) return { name: m[1], url: m[2](email) };
    return null;
  }
  const isAndroid = APP === "android" || /Android/i.test(navigator.userAgent || "");
  function openMailUrl(url, preWin) {
    if (APP === "desktop" || APP === "desktop-code") { // 데스크톱 앱: 시스템 브라우저로
      if (window.DesktopBridge && window.DesktopBridge.openAuth) { window.DesktopBridge.openAuth(url); return true; }
    }
    if (preWin && !preWin.closed) { try { preWin.location.href = url; return true; } catch (e) {} }
    const w = window.open(url, "_blank", "noopener");
    return !!w;
  }
  async function sendEmailCode(custom) {
    const email = (document.getElementById("clgEmail").value || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { gateError("이메일 주소를 확인해줘"); return; }
    const svc = isAndroid ? null : mailService(email);
    // 팝업 차단을 피하려고, 누른 순간(사용자 동작 안)에 빈 창을 먼저 연다 → 메일이 나가면 그 창을 메일함으로 보낸다
    let preWin = null;
    if (svc && APP === "web") { try { preWin = window.open("", "_blank"); if (preWin) { preWin.opener = null; preWin.document.title = "메일함 여는 중…"; preWin.document.body.innerHTML = '<p style="font-family:sans-serif;color:#555;padding:24px">메일을 보내는 중이에요… 잠시 후 ' + svc.name + " 이(가) 열려요.</p>"; } } catch (e) { preWin = null; } }
    const btn = document.getElementById(custom ? "clgCustomBtn" : "clgSendBtn"); btn.disabled = true; gateError("");
    try {
      if (custom) { await sendCustomMail(email); }
      else {
        const { error } = await supabase.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
      }
      pendingEmail = email;
      gateError("로그인 링크를 메일로 보냈어요. 같은 브라우저에서 메일의 링크를 눌러주세요. (스팸함도 확인)");
      if (svc) {
        const opened = openMailUrl(svc.url, preWin);
        const el = document.getElementById("clgError");
        if (el) {
          const a = document.createElement("a"); a.href = svc.url; a.target = "_blank"; a.rel = "noopener"; a.className = "clg-mail-link";
          a.textContent = (opened ? "↗ " + svc.name + " 다시 열기" : "↗ " + svc.name + " 열기");
          a.addEventListener("click", function (ev) { if (APP === "desktop" || APP === "desktop-code") { ev.preventDefault(); openMailUrl(svc.url); } });
          el.appendChild(document.createElement("br")); el.appendChild(a);
        }
      }
      setTimeout(function () { btn.disabled = false; }, 30000);
    } catch (e) {
      if (preWin) { try { preWin.close(); } catch (_) {} }
      btn.disabled = false;
      const m = String((e && e.message) || e);
      gateError(/rate|seconds|limit/i.test(m) ? "잠시 후 다시 시도해줘 (메일 발송 제한)" : "메일 전송 실패: " + m);
    }
  }
  /* ---------------- 로그인 / 로그아웃 ---------------- */
  async function login() {
    gateError("");
    // Android 앱: 기기에 등록된 구글 계정(Credential Manager)으로 바로 로그인 → 브라우저(삼성 인터넷 등)를 열지 않는다.
    // 네이티브가 ID 토큰을 받아 window.__choiminiHandleGoogleIdToken(token) 을 호출한다.
    if (APP === "android" && window.AndroidBridge) {
      const fns = ["requestGoogleIdToken", "signInWithGoogle", "googleSignIn", "requestGoogleSignIn", "startGoogleSignIn", "nativeGoogleLogin"];
      for (const fn of fns) {
        if (typeof window.AndroidBridge[fn] === "function") {
          // 네이티브가 실패/취소되면 __choiminiNativeGoogleFailed 를 호출해 브라우저 방식으로 대체한다.
          window.__choiminiNativeGoogleFailed = function () { loginBrowser(); };
          try { window.AndroidBridge[fn](); return; } catch (e) { console.warn("native google sign-in failed", fn, e); }
        }
      }
    }
    return loginBrowser();
  }

  async function loginBrowser() {
    gateError("");
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: REDIRECT_TO,
          skipBrowserRedirect: isExternalAuth, // 웹뷰/확장이면 자동 리다이렉트 막고 URL만 받는다
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;

      if (isChromeExt && data && data.url) {
        // 확장: 부모(사이드 패널)가 실제 탭으로 연다. (확장이 주소를 검증한다: Supabase authorize 만 허용)
        window.parent.postMessage({ source: "choimini-web", type: "open-auth", url: data.url }, "*");
      } else if (isWebView && data && data.url) {
        // 네이티브에게 시스템 브라우저로 열어달라고 위임
        if (window.AndroidBridge && window.AndroidBridge.openAuth) {
          window.AndroidBridge.openAuth(data.url);
        } else if (window.DesktopBridge && window.DesktopBridge.openAuth) {
          const viaSite = REDIRECT_TO.indexOf("https:") === 0;
          window.DesktopBridge.openAuth(viaSite ? window.location.origin + window.location.pathname + "?desktop_login=" + encodeURIComponent(data.url) : data.url);
        } else {
          window.open(data.url, "_blank");
        }
      }
      // 일반 브라우저면 signInWithOAuth가 알아서 리다이렉트함
    } catch (e) {
      console.error("login error", e);
      gateError("로그인에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
  }

  // Android 네이티브가 "기기에 이미 로그인된 구글 계정"으로 바로 받아온 ID 토큰을 넘길 때 호출.
  // (시스템 브라우저를 여는 기존 login() 흐름과 달리, Credential Manager로 기기 계정에서 바로 토큰을 받아오므로
  //  브라우저 창 전환 없이 그대로 세션을 만든다.)
  window.__choiminiHandleGoogleIdToken = async function (idToken) {
    try {
      const { error } = await supabase.auth.signInWithIdToken({ provider: "google", token: idToken });
      if (error) throw error;
      await bootstrapSession();
    } catch (e) {
      console.error("native google id token login error", e);
      gateError("자동 로그인에 실패했습니다. 아래 버튼으로 다시 시도해주세요.");
    }
  };

  // 네이티브(Android/Desktop)가 딥링크 수신 시 호출: choimini://auth-callback?code=...
  window.__choiminiHandleAuthCallback = async function (fullUrl) {
    try {
      const u = new URL(fullUrl);
      const code = u.searchParams.get("code");
      if (!code) throw new Error("no code in callback");
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      // 브라우저의 로그인 창에 "끝났으니 닫아도 돼" 라고 알린다
      const n = u.searchParams.get("n");
      if (n) { try { await supabase.rpc("handoff_mark", { p_nonce: n }); } catch (e) { console.warn("handoff_mark", e); } }
      await bootstrapSession();
    } catch (e) {
      console.error("auth callback error", e);
      gateError("로그인 처리에 실패했습니다.");
    }
  };

  // 확장이 로그인 탭에서 받아 온 code 전달 (choimini://auth-callback?code=...). 부모 창 + 확장 origin 에서 온 것만 처리.
  if (isChromeExt) {
    window.__choiminiChromeAuthListener = true;   // 확장이 주입한 스크립트(nocf.js)가 같은 메시지를 중복 처리하지 않게 표시
    window.addEventListener("message", function (e) {
      const d = e.data;
      if (e.source !== window.parent || !/^chrome-extension:/.test(e.origin)) return;
      if (!d || d.source !== "choimini-ext") return;
      if (d.type === "auth-callback" && typeof d.url === "string") window.__choiminiHandleAuthCallback(d.url);
      else if (d.type === "auth-error") gateError("로그인에 실패했습니다: " + String(d.message || "").slice(0, 120));
    });
  }

  /* ---------------- 로그인 상태 알림 ----------------
     앱/확장이 "로그인해야만" 코드 실행·페이지 제어를 켜도록, 상태가 바뀔 때마다 알려준다.
     (사이트는 신뢰 대상이 아니라 "보고자"일 뿐이고, 실제 차단은 각 앱/확장이 한다.) */
  const authListeners = [];
  function announceAuth() {
    const loggedIn = !!currentUser;
    try { if (window.DesktopBridge && window.DesktopBridge.reportAuth) window.DesktopBridge.reportAuth(loggedIn); } catch (e) {}
    try { if (window.AndroidBridge && window.AndroidBridge.reportAuth) window.AndroidBridge.reportAuth(loggedIn); } catch (e) {}
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: "choimini-web", type: "auth", loggedIn: loggedIn }, "*"); } catch (e) {}
    authListeners.slice().forEach(function (cb) { try { cb(loggedIn); } catch (e) { console.error(e); } });
    try { window.dispatchEvent(new CustomEvent("choimini-auth", { detail: { loggedIn: loggedIn } })); } catch (e) {}
  }

  async function logout() {
    await supabase.auth.signOut();
    currentUser = null;
    showLoginGate();
    announceAuth();
  }

  /* ---------------- 세션 부트스트랩 ---------------- */
  async function bootstrapSession() {
    try { // 커스텀 메일 로그인 링크(?token_hash=...&type=magiclink)
      const q = new URLSearchParams(location.search);
      const th = q.get("token_hash"), ty = q.get("type");
      if (th && ty === "magiclink") {
        const { error } = await supabase.auth.verifyOtp({ token_hash: th, type: "magiclink" });
        q.delete("token_hash"); q.delete("type");
        history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
        if (error) console.warn("custom mail login failed", error.message);
      }
    } catch (e) { console.warn(e); }
    const { data } = await supabase.auth.getSession();
    const session = data && data.session;
    if (!session || !session.user) {
      currentUser = null;
      showLoginGate();
      announceAuth();
      return false;
    }
    currentUser = session.user;
    hideLoginGate();
    announceAuth();

    // 구버전 device 잔액 1회 이관 (있을 때만)
    try {
      const deviceId = localStorage.getItem("choimini.deviceId");
      if (deviceId && !localStorage.getItem("choimini.deviceClaimed")) {
        await supabase.rpc("claim_device_balance", { p_device_id: deviceId });
        localStorage.setItem("choimini.deviceClaimed", "1");
      }
    } catch (e) { /* devices 테이블 없거나 실패해도 무시 */ }

    // 준비 콜백 실행 (기존 앱 init 연결)
    readyCallbacks.splice(0).forEach(function (cb) {
      try { cb(currentUser); } catch (e) { console.error(e); }
    });
    return true;
  }

  /* ---------------- 토큰 API (기존 코드에서 호출) ---------------- */
  async function getBalance() {
    const { data, error } = await supabase.rpc("user_get_balance");
    if (error) throw error;
    return Number(data) || 0;
  }

  // amount = 이번 요청의 비용 (배수 없음: 모든 앱에서 동일)
  async function spend(baseAmount) {
    const amount = Math.round(Number(baseAmount));
    const { data, error } = await supabase.rpc("user_spend", { p_amount: amount });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row.ok, balance: Number(row.balance) || 0, charged: amount };
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }

  // 광고 보상용 무료 코드 사용 (고정 코드표에 없을 때 fallback으로 호출)
  async function redeemFreeCode(code) {
    const { data, error } = await supabase.rpc("user_free_code_redeem", { p_code: code });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row.ok, message: row.message, balance: Number(row.balance) || 0 };
  }

  /* ---------------- 광고 보상 RPC (Edge Function 불필요, JWT로 직접 호출) ---------------- */
  const ads = {
    async start() {
      const { data, error } = await supabase.rpc("ad_session_start");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const st = await this.status(row.session_id);
      return { sessionId: row.session_id, expiresAt: row.expires_at, progress: st };
    },
    async status(sessionId) {
      const { data, error } = await supabase.rpc("ad_session_status", { p_session_id: sessionId });
      if (error) throw error;
      return data || [];
    },
    async markStart(sessionId, adId) {
      const { data, error } = await supabase.rpc("ad_progress_mark_start", { p_session_id: sessionId, p_ad_id: adId });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    async markComplete(sessionId, adId) {
      const { data, error } = await supabase.rpc("ad_progress_mark_complete", { p_session_id: sessionId, p_ad_id: adId });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    async generateCode(sessionId) {
      const { data, error } = await supabase.rpc("generate_free_code", { p_session_id: sessionId });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
  };

  /* ---------------- 공개 API ---------------- */
  window.ChoiminiAuth = {
    app: APP,
    // 모든 앱(Android / Desktop / Chrome 확장)에서 true → Cloudflare Turnstile 등을 렌더링하지 말 것
    skipCloudflare: function () { return APP !== "web" || !!window.CHOIMINI_SKIP_CLOUDFLARE; },
    // 로그인 상태가 바뀔 때마다 콜백 (즉시 1회 호출 포함). 반환값: 해제 함수
    onAuthChange: function (cb) { authListeners.push(cb); try { cb(!!currentUser); } catch (e) {} return function () { const i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1); }; },
    supabase: supabase,
    login: login,
    logout: logout,
    getUser: function () { return currentUser; },
    isLoggedIn: function () { return !!currentUser; },
    onReady: function (cb) { if (currentUser) cb(currentUser); else readyCallbacks.push(cb); },
    getBalance: getBalance,
    spend: spend,
    getAccessToken: getAccessToken,
    redeemFreeCode: redeemFreeCode,
    ads: ads,
  };

  // 세션 변화 감지 (토큰 만료/갱신 등)
  supabase.auth.onAuthStateChange(function (_event, session) {
    if (session && session.user) {
      currentUser = session.user;
      hideLoginGate();
    } else {
      currentUser = null;
      showLoginGate();
    }
    announceAuth();
  });

  // 진입점: 로그인 안 되어 있으면 게이트, 되어 있으면 앱 시작
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapSession);
  } else {
    bootstrapSession();
  }
})();
