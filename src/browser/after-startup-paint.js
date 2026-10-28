// Optional warmups start only after the composer has had a chance to paint.
export function afterStartupPaint(callback) {
 let observer, frame, idle, timer, queued = false, stopped = false;
 const stop = () => {
  stopped = true;
  observer?.disconnect();
  cancelAnimationFrame(frame);
  if (idle !== undefined) cancelIdleCallback(idle);
  clearTimeout(timer);
  window.removeEventListener('pagehide', stop);
 };
 const ready = () => {
  if (queued || stopped || !document.querySelector('[contenteditable=true]')?.getBoundingClientRect().height) return;
  queued = true;
  observer?.disconnect();
  frame = requestAnimationFrame(() => {
   frame = requestAnimationFrame(() => {
    const run = () => { if (!stopped) { stop(); callback(); } };
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, {timeout: 2000});
    else timer = setTimeout(run, 0);
   });
  });
 };
 observer = new MutationObserver(ready);
 observer.observe(document, {childList: true, subtree: true, attributes: true});
 window.addEventListener('pagehide', stop, {once: true});
 ready();
 return stop;
}
