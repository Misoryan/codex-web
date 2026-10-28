export function patchMobileSettings(source) {
  if (source.includes('function CodexWebMobileSettingsNavigation(')) return source;
  const anchor = 'sidebar: Ye,\n        children: q,';
  if (source.split(anchor).length !== 2) throw Error('Native settings shell changed');
  if (source.split('autoFocus: !0,').length !== 2) throw Error('Native settings search changed');
  source = source.replace('autoFocus: !0,', 'autoFocus: !matchMedia("(max-width: 768px)").matches,');
  source = source.replace(anchor, 'sidebar: (0, $.jsx)(CodexWebMobileSettingsNavigation, {onBack: we, children: Ye}),\n        children: q,');
  return source + `
function CodexWebMobileSettingsNavigation({onBack, children}) {
  const [detail, setDetail] = li.useState(false);
  const navigation = li.useRef(null);
  const back = li.useRef(null);
  const select = event => {
    if (!matchMedia('(max-width: 768px)').matches || !(event.target instanceof Element)) return;
    if (!event.target.closest('[data-settings-panel-slug], [data-list-navigation-item]')) return;
    if (event.target.closest('[disabled], [aria-disabled="true"]')) return;
    setDetail(true);
    requestAnimationFrame(() => back.current?.querySelector('button')?.focus({preventScroll: true}));
  };
  const goBack = () => {
    if (!detail) {onBack(); return;}
    setDetail(false);
    requestAnimationFrame(() => navigation.current?.querySelector('[aria-current="page"]')?.focus({preventScroll: true}));
  };
  const title = (0, $.jsx)(B, {id: 'settings.nav.title', defaultMessage: 'Settings', description: 'Title of the Settings sidebar'});
  return (0, $.jsxs)('div', {
    'data-codex-settings-view': detail ? 'detail' : 'list',
    className: 'contents',
    children: [
      (0, $.jsxs)('div', {
        'data-codex-settings-toolbar': true,
        ref: back,
        children: [
          (0, $.jsx)(vt, {
            'data-codex-settings-back': true,
            fullWidth: false,
            icon: (0, $.jsx)(Ne, {icon: {16: Pe, 20: De}}),
            label: detail ? title : (0, $.jsx)(B, {...Zr.back}),
            onClick: goBack,
          }),
          detail ? null : (0, $.jsx)('span', {className: 'font-medium text-default', children: title}),
        ],
      }),
      (0, $.jsx)('div', {
        'data-codex-settings-navigation': true,
        className: 'contents',
        ref: navigation,
        onClickCapture: select,
        children,
      }),
    ],
  });
}
`;
}
