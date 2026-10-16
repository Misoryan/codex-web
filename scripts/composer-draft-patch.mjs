import ts from 'typescript';

function replaceFunction(source, name, edit) {
  const ast=ts.createSourceFile('bundle.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  if(!node)throw Error('Composer function missing: '+name);
  return source.slice(0,node.getStart(ast))+edit(node.getText(ast))+source.slice(node.end);
}
function once(source,from,to){
  if(source.includes(to))return source;
  if(source.split(from).length!==2)throw Error('Composer patch anchor changed: '+from);
  return source.replace(from,to);
}
export function patchDraftPersistence(source){
  source=replaceFunction(source,'ARt',s=>once(s,'  (qRt(null), n?.preservePendingPublishes || ORt(), (kI += 1));',`  if ($Rt === t) {
    for (const key of new Set([...TI.keys(), ...Object.keys(e)])) URt(key, e[key], key === "sidebar-custom-sections-v3" ? n?.savedCustomSectionOperationIds : void 0);
    return;
  }
  (qRt(null), n?.preservePendingPublishes || ORt(), (kI += 1));`));
  return replaceFunction(source,'URt',s=>once(s,'r?.recordUpdate != null && t !== void 0','r?.recordUpdate != null'));
}
export function patchDraftSubmission(source) {
  return replaceFunction(source,'Put',body=>{
    if(body.includes('codexSubmissionAccepted'))return body;
    body=once(body,'    try {\n      let n = await wt(),','    let codexSubmissionAccepted = false;\n    try {\n      let n = await wt(),');
    body=once(body,'        (yt?.(!0),\n          (yt = void 0),','        (codexSubmissionAccepted = true, yt?.(!0),\n          (yt = void 0),');
    body=once(body,'        (yt?.(!0),\n        (yt = void 0),','        (codexSubmissionAccepted = true, yt?.(!0),\n        (yt = void 0),\n        !ht && !ke && u(dt),');
    body=once(body,'        !ht && !ke && u(dt));','        void 0);');
    body=once(body,'    } catch (t) {\n      let n = t instanceof DOMException',`    } catch (t) {
      if(codexSubmissionAccepted) {
        st.warning('Post-submit UI update failed after message acceptance',{safe:{},sensitive:{error:t}});
        return;
      }
      let n = t instanceof DOMException`);
    return body;
  });
}

export function patchMinifiedDrafts(source,kind){
  const ast=ts.createSourceFile('bundle.js',source,99,true,ts.ScriptKind.JS);
  const functions=ast.statements.filter(ts.isFunctionDeclaration);
  if(kind==='initial'){
    const receive=functions.find(n=>n.getText(ast).includes('?.recordUpdate!=null&&')&&n.getText(ast).length<700);
    const sync=functions.find(n=>n.getText(ast).includes('.clear(),Object.entries(')&&n.getText(ast).length<600);
    if(!receive||!sync)throw Error('Minified persistence anchors changed');
    const rx=receive.getText(ast),sx=sync.getText(ast);
    const [state,publish]=sync.parameters.map(p=>p.name.getText(ast));
    const store=sx.match(/\.clear\(\),Object\.entries\([^)]*\)\.forEach\([^]*?([\w$]+)\.set\(/)?.[1];
    const writer=sx.match(/\),([\w$]+)=[\w$]+,[\w$]+\.forEach/)?.[1];
    if(!store||!writer)throw Error('Minified store anchors changed');
    source=source.replace(sx,sx.replace('{',`{if(${writer}===${publish}){for(const key of new Set([...${store}.keys(),...Object.keys(${state})]))${receive.name.text}(key,${state}[key]);return;}`));
    return source.replace(rx,rx.replace(/(\?\.recordUpdate!=null)&&[\w$]+!==void 0/,'$1'));
  }
  const node=functions.find(n=>n.getText(ast).includes('submit_preparation_failed')&&n.getText(ast).includes('Failed to update queued messages after sending'));
  if(!node)throw Error('Minified submit anchor missing');
  let text=node.getText(ast);
  const tail=text.match(/await ([\w$]+)\(\),([\w$]+)\?\.\(!0\),\2=void 0,([\w$]+)\|\|([\w$]+)\(\)/);
  const logger=text.match(/([\w$]+)\.warning\("Failed to update queued messages after sending"/);
  if(!tail||!logger)throw Error('Minified acceptance anchors changed');
  const [,post,retain,cleared,clear]=tail;
  const start=text.lastIndexOf(';try{let ');
  if(start<0)throw Error('Minified submit try missing');
  text=text.slice(0,start)+text.slice(start).replace(';try{let ',';let codexSubmissionAccepted=false;try{let ');
  text=once(text,`${retain}?.(!0),${retain}=void 0,${clear}()`,`codexSubmissionAccepted=true,${retain}?.(!0),${retain}=void 0,${clear}()`);
  const marker=text.indexOf('"[composer] Recorded submitted Computer Use app mentions"');
  const acceptance=text.lastIndexOf('if(',marker);
  if(marker<0||acceptance<start)throw Error('Minified accepted branch missing');
  text=text.slice(0,acceptance)+`codexSubmissionAccepted=true;${retain}?.(!0);${retain}=void 0;if(!${cleared})${clear}();`+text.slice(acceptance);
  text=once(text,tail[0],`await ${post}()`);
  const catcher=text.lastIndexOf('catch('),brace=text.indexOf('{',catcher),error=text.slice(catcher+6,brace-1);
  text=text.slice(0,brace+1)+`if(codexSubmissionAccepted){${logger[1]}.warning("Post-submit UI update failed after message acceptance",{safe:{},sensitive:{error:${error}}});return;}`+text.slice(brace+1);
  return source.slice(0,node.getStart(ast))+text+source.slice(node.end);
}
