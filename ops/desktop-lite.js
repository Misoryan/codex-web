// Keep chat, Scheduled, and activity available; block unsupported native actions.
(() => {
 const disabled=new Set(['Pull requests','Plugins','Toggle bottom panel','Open help menu','拉取请求','插件','切换底部面板','帮助']);
 const nonChat=/^(?:Start voice|Start dictation|Dictate|Open (?:terminal|diff|file editor)|Show (?:diff|terminal)|Commit changes|Create pull request|语音输入|开始语音|开始听写|打开终端|查看差异)/i;
 const blocked=event=>{const target=event.target instanceof Element?event.target.closest('button,[role="button"],[role="menuitem"]'):null;if(!target)return;const label=target.getAttribute('aria-label')||target.textContent?.trim()||'';if(disabled.has(label)||nonChat.test(label)){event.preventDefault();event.stopImmediatePropagation();}};
 document.addEventListener('pointerdown',blocked,true);
 document.addEventListener('click',blocked,true);
 document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')blocked(event)},true);
})();
