/* Desktop-only presentation. Host permissions and execution remain in Electron. */
(function(){
  'use strict';
  if(window.CHOIMINI_APP !== 'desktop' || !window.DesktopBridge) return;
  document.documentElement.classList.add('choimini-desktop');
  if(window.CHOIMINI_DESKTOP_CHROME === true){
    document.documentElement.classList.add('desktop-chrome');
    const bar = document.createElement('header');
    bar.className = 'desktop-titlebar' + (window.CHOIMINI_DESKTOP_PLATFORM === 'darwin' ? ' mac' : '');
    bar.setAttribute('aria-label','Choimini Desktop');
    bar.innerHTML = '<span>Choimini</span>';
    document.body.prepend(bar);
  }
  const empty = document.getElementById('emptyState');
  if(empty){
    const title = document.createElement('h2'); title.id='desktopWelcome'; title.textContent='어디서부터 시작할까요?';
    const sub=empty.querySelector('.empty-sub'); empty.insertBefore(title,sub);
    if(sub) sub.textContent='생각을 나누고, 내 컴퓨터의 작업을 이어가세요.';
  }
  const icons={
    openAccountBtn:['계정','<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>'],
    openSettingsBtn:['설정','<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>'],
    openRedeemBtn:['코드 사용','<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M9 5v14"/>'],
    openLiveBtn:['음성 대화','<path d="M5 9v6M9 5v14M13 8v8M17 3v18M21 9v6"/>'],
    openAdRewardBtn:['토큰 받기','<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>'],
    openStorageBtn:['작업공간','<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3z"/>']
  };
  Object.keys(icons).forEach(id=>{
    const b=document.getElementById(id); if(!b)return;
    b.innerHTML='<svg class="desktop-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[id][1]+'</svg><span>'+icons[id][0]+'</span>';
  });
  const newChat=document.getElementById('newChatBtn');if(newChat)newChat.textContent='＋ 새 대화';
})();
