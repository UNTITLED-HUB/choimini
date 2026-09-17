!function(){
  "use strict";

  /*
    jCAPTCHA V2
    - 사람이 아무것도 누르지 않아도 자동으로 검사가 진행되는 클라우드플레어 스타일 위젯입니다.
    - 검사 내용: 현재 접속 시간이 차단 시간대에 해당하는지만 확인합니다 (실제 봇 탐지는 하지 않음).
    - 요일별 차단 시간대는 아래 BLOCK_RULES에서 수정하세요. 시간은 접속하는 사람의 "브라우저 로컬 시간" 기준입니다.
  */

  // 요일: 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토
  // 각 규칙은 [시작시, 시작분, 종료시, 종료분] (양 끝 포함)
  const BLOCK_RULES = {
    1: [[8, 40, 14, 30]], // 월
    2: [[8, 40, 14, 30]], // 화
    3: [[8, 40, 13, 50]], // 수
    4: [[8, 40, 14, 30]], // 목
    5: [[8, 40, 14, 30]], // 금
  };

  // 차단 시간대라도 이 코드를 입력하면 강제로 통과시키는 언락 코드.
  // 입력창은 별도로 없고, 검사 중(차단 여부 판정 전)에 사용자가 이 문자열을 그대로
  // 키보드로 타이핑하면(포커스된 입력 요소가 없어도 감지됨) 통과 처리됩니다.
  const UNLOCK_CODE = "CODE_UNLOCK_SITE_0716";

  const TEXT = {
    checking_title: "사람인지 확인하는 중...",
    checking_sub: "이 사이트는 악의적인 사용자로부터 보호합니다. 확인 후 연결됩니다.",
    blocked_title: "접속이 제한되었습니다",
    blocked_sub: "이 사이트는 현재 시간대에 접속할 수 없습니다. 잠시 후 다시 시도해주세요.",
    success_title: "확인 완료.. 연결중",
    success_sub: "",
  };

  function isBlockedNow(date) {
    const now = date || new Date();
    const rules = BLOCK_RULES[now.getDay()];
    if (!rules) return false;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return rules.some(([sh, sm, eh, em]) => {
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      return nowMin >= start && nowMin <= end;
    });
  }

  class JCaptchaV2 {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.init();
    }

    init() {
      this.injectStyles();
      this.render();
      this._unlocked = false;
      this._typedBuf = "";
      // 검사 중(결과가 나오기 전)에 페이지 아무 곳에서나 UNLOCK_CODE를 그대로 타이핑하면
      // 차단 시간대여도 강제로 통과시킵니다. 입력창 포커스가 필요 없는 전역 키 리스너 방식.
      this._onKeydown = (e) => {
        if (this._resolved || this._unlocked) return;
        if (!e.key || e.key.length > 1) return; // 일반 문자만 누적 (Shift, Enter 등 제외)
        this._typedBuf = (this._typedBuf + e.key).slice(-UNLOCK_CODE.length);
        if (this._typedBuf === UNLOCK_CODE) {
          this._unlocked = true;
          if (this._timer) clearTimeout(this._timer);
          this.showSuccess();
        }
      };
      document.addEventListener("keydown", this._onKeydown);
      // 실제 클라우드플레어처럼, 잠깐의 "검사 중" 연출 후 결과를 표시합니다.
      const delay = this.opts.checkDelayMs != null ? this.opts.checkDelayMs : 1000 + Math.random() * 700;
      this._timer = setTimeout(() => this.runCheck(), delay);
    }

    injectStyles() {
      if (document.getElementById("jcaptcha-v2-styles")) return;
      const style = document.createElement("style");
      style.id = "jcaptcha-v2-styles";
      style.textContent = `
    #jcaptcha-v2-wrapper {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      width: 300px; margin: 0 auto; user-select: none;
    }
    .jcv2-box {
      border: 1px solid #d9d9d9; border-radius: 8px;
      box-shadow: 0 1px 6px rgba(0,0,0,0.08); background: #fff;
      display: flex; align-items: center; gap: 12px;
      padding: 16px; box-sizing: border-box;
    }
    .jcv2-badge {
      width: 28px; height: 28px; flex-shrink: 0;
      border: 2px solid #d9d9d9; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; font-weight: 800; color: #fff;
      transition: background .25s, border-color .25s;
      position: relative;
    }
    .jcv2-badge .jcv2-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #d9d9d9; border-top-color: #4285f4;
      animation: jcv2-spin .8s linear infinite;
    }
    .jcv2-badge.success { background: #34a853; border-color: #34a853; }
    .jcv2-badge.error { background: #ea4335; border-color: #ea4335; }
    @keyframes jcv2-spin { to { transform: rotate(360deg); } }
    .jcv2-text { flex: 1; min-width: 0; }
    .jcv2-text strong { display: block; font-size: 13px; font-weight: 700; color: #222; }
    .jcv2-text small { display: block; font-size: 11px; color: #888; margin-top: 3px; line-height: 1.4; }
    .jcv2-footer { text-align: right; font-size: 9px; color: #bbb; margin-top: 8px; }
      `;
      document.head.appendChild(style);
    }

    render() {
      this.container.innerHTML = `
        <div id="jcaptcha-v2-wrapper">
          <div class="jcv2-box">
            <div class="jcv2-badge" id="jcv2-badge"><div class="jcv2-spinner"></div></div>
            <div class="jcv2-text">
              <strong id="jcv2-title">${TEXT.checking_title}</strong>
              <small id="jcv2-sub">${TEXT.checking_sub}</small>
            </div>
          </div>
          <div class="jcv2-footer">jCAPTCHA V2</div>
        </div>
      `;
      this.el = {
        badge: this.container.querySelector("#jcv2-badge"),
        title: this.container.querySelector("#jcv2-title"),
        sub: this.container.querySelector("#jcv2-sub"),
      };
    }

    runCheck() {
      if (this._resolved) return; // 언락 코드로 이미 통과 처리된 경우 시간 판정을 건너뜀
      if (isBlockedNow()) {
        this.showBlocked();
      } else {
        this.showSuccess();
      }
    }

    showBlocked() {
      this._resolved = true;
      document.removeEventListener("keydown", this._onKeydown);
      this.el.badge.innerHTML = "✗";
      this.el.badge.classList.add("error");
      this.el.title.textContent = TEXT.blocked_title;
      this.el.sub.textContent = TEXT.blocked_sub;
      window.jcaptchaV2OnBlocked &&
        window.jcaptchaV2OnBlocked({ blocked: true, reason: "time_restricted", timestamp: Date.now() });
    }

    showSuccess() {
      this._resolved = true;
      document.removeEventListener("keydown", this._onKeydown);
      this.el.badge.innerHTML = "✓";
      this.el.badge.classList.add("success");
      this.el.title.textContent = TEXT.success_title;
      this.el.sub.textContent = TEXT.success_sub;
      const token = "jcaptchav2_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
      setTimeout(() => {
        window.jcaptchaV2OnSuccess &&
          window.jcaptchaV2OnSuccess({
            success: true,
            token: token,
            unlocked: this._unlocked === true,
            timestamp: Date.now(),
          });
      }, 500);
    }
  }

  function initAll() {
    document.querySelectorAll("[data-jcaptcha-v2]").forEach((el) => {
      new JCaptchaV2(el);
    });
  }

  "loading" === document.readyState
    ? document.addEventListener("DOMContentLoaded", initAll)
    : initAll();

  window.JCaptchaV2 = JCaptchaV2;
  window.__jcaptchaV2IsBlockedNow = isBlockedNow; // 디버깅/테스트용
}();
