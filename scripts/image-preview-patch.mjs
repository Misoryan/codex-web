import fs from 'node:fs';
import ts from 'typescript';
const clipboard=fs.readFileSync(new URL('../src/browser/image-clipboard.js',import.meta.url),'utf8');
export function patchImagePreviewInitial(source) {
  if(source.includes('codex-web-image-dialog-copy-v2'))return source;
  const ast=ts.createSourceFile('images.js',source,99,true,ts.ScriptKind.JS),edits=[];
  const functions=ast.statements.filter(ts.isFunctionDeclaration);
  const one=(items,label)=>{if(items.length!==1)throw Error(`Image anchor changed: ${label} (${items.length})`);return items[0];};
  const find=(needle)=>one(functions.filter(n=>n.getText(ast).includes(needle)),needle);
  const nodes=(root,predicate)=>{const result=[];const visit=n=>{if(predicate(n))result.push(n);ts.forEachChild(n,visit)};visit(root);return result;};
  const text=n=>n.getText(ast);
  const replace=(n,value)=>edits.push({start:n.getStart(ast),end:n.end,text:value});
  const imgs=n=>nodes(n,c=>ts.isCallExpression(c)&&c.arguments[0]&&ts.isStringLiteralLike(c.arguments[0])&&c.arguments[0].text==='img');
  const prop=(n,name)=>one(nodes(n,c=>ts.isPropertyAssignment(c)&&c.name.getText(ast)===name),name);
  const preview=find('imagePreviewDialog.zoomIn'),attachment=find('imageAttachment.removeAriaLabel'),markdown=find('markdown.imagePreviewButton');
  const image=one(imgs(preview),'dialog image');
  const wrap=(image,src)=>`${text(image.expression)}(codexWebImageMenu,{src:${src},children:${text(image)}})`;
  const previewSrc=one(preview.parameters[0].name.elements.filter(n=>n.propertyName?.text==='src'),'preview source').name.getText(ast);
  replace(image,wrap(image,previewSrc));
  const thumb=one(imgs(attachment),'attachment image');replace(thumb,wrap(thumb,text(prop(thumb.arguments[1],'src').initializer)));
  const oldMenu=one(nodes(markdown,n=>ts.isConditionalExpression(n)&&ts.isCallExpression(n.whenFalse)&&text(n.whenFalse).includes('getItems:')),'markdown menu');
  const src=text(prop(one(imgs(markdown),'markdown image').arguments[1],'src').initializer);
  replace(oldMenu,`us().createElement(codexWebImageMenu,{src:${src},getItems:${text(prop(oldMenu.whenFalse,'getItems').initializer)},children:${text(oldMenu.whenTrue)}})`);
  const entry=one(functions.filter(n=>n.name?.text==='nll'),'image entrypoint');
  const at=entry.body.getStart(ast)+1;
  edits.push({start:at,end:at,text:`\nif(!a||n==='image_click'){bf(e,CodexWebImageDialog,{scope:e,options:c,...s,title:o});return true;}\n`});
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source+`
const codexWebImagePreviewVersion='codex-web-image-dialog-copy-v2';
${clipboard}
function codexWebImageMenu({src,getItems,children}) {
  const scope=Di(q),intl=zd();
  const failed=()=>scope.get(lc).danger(intl.formatMessage({id:'codex.localConversation.image.contextMenu.copyFailure',defaultMessage:'Could not copy image'}));
  const add=items=>items.some(item=>item.id==='copy-image')?items:[...items,{id:'copy-image',message:{id:'codex.localConversation.generatedImage.contextMenu.copyImage',defaultMessage:'Copy image'},enabled:typeof ClipboardItem==='function'&&typeof navigator.clipboard?.write==='function',onSelect:()=>{try{codexWebCopyImage(fetch(src,{referrerPolicy:'no-referrer'}).then(r=>{if(!r.ok)throw Error('Could not read image for clipboard copy');return r.blob()})).catch(failed)}catch{failed()}}}];
  return us().createElement(jc,{disableNative:true,getItems:()=>{const items=getItems?.()??[];return typeof items.then==='function'?items.then(add):add(items)},children});
}
function CodexWebImageDialog({scope,options,onClose,...image}) {
  sll();
  const intl=zd();
  return us().createElement(xel,{...image,open:true,imageReferrerPolicy:image.referrerPolicy,onOpenChange:open=>{if(!open)onClose()},editButton:image.readOnly?undefined:{ariaLabel:intl.formatMessage({id:'codex.imagePreview.editImage',defaultMessage:'Edit image'}),icon:us().createElement(oll,{className:'icon-xs'}),onClick:()=>{if(nll(scope,{...image,entrypoint:'lightbox_edit_button',openInEditor:true},{...options,layout:{mode:'full'}}))onClose()}}});
}
`;
}
if(process.argv[1]?.endsWith('image-preview-patch.mjs')) {
 const file='scratch/asar/webview/assets/app-initial-6350d04672d0.js';fs.writeFileSync(file,patchImagePreviewInitial(fs.readFileSync(file,'utf8')));
}
