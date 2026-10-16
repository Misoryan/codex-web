export function patchContextUsageButton(source) {
  const start = source.indexOf('function g6e(e) {');
  const end = source.indexOf('\nfunction ', start + 10);
  if (start < 0 || end < 0) throw Error('Context usage component changed');
  let component = source.slice(start, end);
  if (component.includes('data-context-usage-button')) return source;
  const before = '(b = (0, UH.jsx)(`span`, {\n        "aria-label": v,';
  if (!component.includes(before)) throw Error('Context usage trigger changed');
  component = component.replace(before, '(b = (0, UH.jsx)(`button`, {\n        type: `button`,\n        "data-context-usage-button": true,\n        "aria-label": v,');
  component = component.replace('        role: `img`,\n', '');
  component = component.replace('  if (n.percent == null)', `  const [touchOpen, setTouchOpen] = (0, Z().useState)(undefined);
  const pressedOpen = (0, Z().useRef)(false);
  (0, Z().useEffect)(() => {
    if (!touchOpen) return;
    const dismiss = event => {
      if (!event.target.closest?.('[data-context-usage-button]')) setTouchOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [touchOpen]);
  if (n.percent == null)`);
  const tail = component.indexOf('  let x;\n  return (');
  if (tail < 0) throw Error('Context usage tooltip changed');
  component = component.slice(0, tail) + `  return (0, UH.jsx)(He, {
    tooltipContent: _, side: \`top\`, align: \`center\`, sideOffset: 4,
    open: touchOpen, onOpenChange: setTouchOpen,
    onPointerDown: () => { pressedOpen.current = touchOpen === true; },
    onClick: () => setTouchOpen(!pressedOpen.current),
    children: b,
  });
}
`;
  return source.slice(0, start) + component + source.slice(end);
}
