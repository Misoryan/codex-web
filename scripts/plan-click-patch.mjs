export function patchPlanClick(source) {
  const start = source.indexOf('function jE(');
  const end = source.indexOf('function ', start + 12);
  if (start < 0 || end < 0) throw Error('Plan progress component changed');
  let component = source.slice(start, end);
  if (component.includes('data-plan-progress')) return source;
  const trigger = /\(0,\s*BE\.jsx\)\(`span`,\s*\{\s*className:\s*`-my-1\.5 inline-flex/;
  const content = /tooltipContent:\s*d,/;
  if (!trigger.test(component) || !content.test(component))
    throw Error('Plan progress trigger changed');
  component = component
    .replace(trigger, '(0, BE.jsx)(`button`, {type: `button`, "data-plan-progress": true, className: `-my-1.5 inline-flex')
    .replace(content, 'openOnClick: !0, tooltipContent: d,');
  return source.slice(0, start) + component + source.slice(end);
}
