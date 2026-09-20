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
  const isWebView = APP === "android" || APP === "desktop" || APP === "desktop-code";
  // Chrome 확장 사이드 패널은 iframe 이라 구글이 로그인 화면을 막는다 → 부모(확장)에게 "실제 탭으로 열어 달라"고 요청하고,
  // 로그인 후 돌아온 code 를 postMessage 로 받는다. (PKCE verifier 는 이 iframe 이 보관하므로 여기서만 세션으로 교환된다)
  const isChromeExt = APP === "chrome";
  const isExternalAuth = isWebView || isChromeExt;

  const REDIRECT_TO = isWebView
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
        '  <div id="clgError" class="clg-error"></div>' +
        '</div>';
      document.body.appendChild(gate);
      document.getElementById("clgGoogleBtn").addEventListener("click", login);
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

  /* ---------------- 로그인 / 로그아웃 ---------------- */
  async function login() {
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
          window.DesktopBridge.openAuth(data.url);
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

  // 네이티브(Android/Desktop)가 딥링크 수신 시 호출: choimini://auth-callback?code=...
  window.__choiminiHandleAuthCallback = async function (fullUrl) {
    try {
      const u = new URL(fullUrl);
      const code = u.searchParams.get("code");
      if (!code) throw new Error("no code in callback");
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
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

  async function redeemGrant(code, amount, unlimited) {
    const { data, error } = await supabase.rpc("user_redeem_grant", {
      p_code: code, p_amount: amount, p_unlimited: !!unlimited,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return { already: !!row.already, balance: Number(row.balance) || 0 };
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
    redeemGrant: redeemGrant,
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
