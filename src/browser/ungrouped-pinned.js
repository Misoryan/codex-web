// This folder only changes the browser sidebar presentation.
export function createUngroupedPinned(React, List, FolderRow, FolderClosed, FolderOpen) {
  const h = React.createElement;
  const storageKey = 'codex-web:ungrouped-pinned-open';
  return function UngroupedPinned(props) {
    const [open, setOpen] = React.useState(() => localStorage.getItem(storageKey) === 'true');
    const id = React.useId();
    const threads = props.keys.filter(key => props.conversationByKey.has(key));
    const projects = props.keys.filter(key => !props.conversationByKey.has(key));
    function list(keys) {
      const members = new Set(keys);
      return h(List, {...props, keys, onOrderChange: props.onOrderChange && (next => {
        let index = 0;
        props.onOrderChange(props.keys.map(key => members.has(key) ? next[index++] : key));
      })});
    }
    return h(React.Fragment, null,
      projects.length ? list(projects) : null,
      threads.length ? h('div', {'data-web-ungrouped-pinned':true},
        h(FolderRow, {
          'data-web-ungrouped-pinned-row': true,
          ariaExpanded: open,
          'aria-controls': id,
          icon: h(open ? FolderOpen : FolderClosed, {className:'icon-xs shrink-0'}),
          label: navigator.language.toLowerCase().startsWith('zh') ? '未分类置顶' : 'Ungrouped pinned',
          onPress:()=>{const next=!open;setOpen(next);localStorage.setItem(storageKey,String(next));},
        }),
        h('div',{id,hidden:!open,className:'pt-0.5 pb-2'},open?list(threads):null)) : null);
  };
}
