import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const marker='codex-web-ccswitch-standard-fast-v2';
export function patchServiceTier(source) {
  if(source.includes(marker))return source;
  const ast=ts.createSourceFile('tier.js',source,99,true,ts.ScriptKind.JS);
  const edits=[];
  function edit(name,transform){const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!fn)throw Error('Desktop service tier function changed: '+name);edits.push({start:fn.getStart(ast),end:fn.end,text:transform(fn.getText(ast))});}
  edit('KVi',()=>`function KVi(options) {
    NG();
    const defaultHost=G(Li), hostId=options?.hostId??defaultHost;
    const auth=BYe(hostId);
    const {data:config,isLoading:configLoading}=Zs(MG,{hostId});
    const isCcSwitch=auth?.authMethod==='apikey'&&codexWebIsCcSwitch(config);
    const eligible=isCcSwitch||auth?.authMethod==='chatgpt'||auth?.authMethod==='personalAccessToken';
    const {data:requirements,isPending}=Zs(Hd,{authMethod:auth?.authMethod??null,hostId});
    const isLoading=!!auth?.isLoading||(auth?.authMethod==='apikey'&&configLoading)||(eligible&&isPending);
    const serviceTierAccess=us().useMemo(()=>eligible&&!isLoading&&requirements!=null ? (isCcSwitch?{...oee(requirements),ultrafast:false,codexCcSwitch:true}:oee(requirements)):null,[eligible,isLoading,requirements,isCcSwitch]);
    return {serviceTierAccess,isLoading};
  }`);
  edit('bga',()=>`async function bga(scope,hostId,config,knownAuth) {
    const auth=knownAuth??await _ga(scope,hostId);
    const cc=auth==='apikey'&&codexWebIsCcSwitch(config);
    if(auth!=='chatgpt'&&auth!=='personalAccessToken'&&!cc)return null;
    const requirements=await KPe(scope,hostId,{priority:'critical'});
    scope.query.setData(Hd,{authMethod:auth,hostId},requirements);
    const access=oee(requirements);
    return cc?{...access,ultrafast:false,codexCcSwitch:true}:access;
  }`);
  edit('kJ',()=>`async function kJ(scope,hostId,model,override) {
    try {
      const auth=await _ga(scope,hostId);
      let config;
      if(auth==='apikey')config=hm((await HLi(scope,hostId,{includeLayers:false,cwd:null},{priority:'critical'})).config);
      const cc=auth==='apikey'&&codexWebIsCcSwitch(config);
      const access=await bga(scope,hostId,config,auth);
      if(override!==undefined)return codexWebLimitServiceTier(RZe(null,override,access),cc);
      const preference=scope.get(iHe,hostId);
      if(preference.type!=='fromConfig')return codexWebLimitServiceTier(RZe(null,dJe(preference,null),access),cc);
      config??=hm((await HLi(scope,hostId,{includeLayers:false,cwd:null},{priority:'critical'})).config);
      const tier=RZe(config.service_tier==null?await xga(scope,hostId,model??config.model):null,config.service_tier,access);
      return codexWebLimitServiceTier(tier,cc);
    } catch(error) {gr.error('Failed to read service tier for request',{safe:{},sensitive:{error}});return null;}
  }`);
  edit('DWi',body=>{
    const from='let t = fVi(h?.models, o.model),';
    if(body.split(from).length!==2)throw Error('Service tier model selection changed');
    return body.replace(from,'let t = codexWebServiceTierModel(fVi(h?.models,o.model),o.model,D?.codexCcSwitch===true),');
  });
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source+`
codexWebIsCcSwitch.patch='${marker}';
function codexWebIsCcSwitch(config) {
  if(config?.model_provider!=='custom')return false;
  const provider=config.model_providers?.custom;
  return provider?.wire_api==='responses'&&typeof provider.base_url==='string'&&provider.base_url.replace(/\\/+$/,'')==='http://127.0.0.1:15721/v1';
}
function codexWebLimitServiceTier(tier,cc) {return !cc?tier:tier==='fast'||tier==='priority'?'priority':null;}
function codexWebServiceTierModel(model,modelId,cc) {
  return !cc?model:{...model,model:model?.model??modelId,defaultServiceTier:codexWebLimitServiceTier(model?.defaultServiceTier,true),serviceTiers:[{id:'priority',name:'Fast'}]};
}
`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const file=path.resolve(process.argv[2]??'scratch/asar/webview/assets/app-initial-6350d04672d0.js');
 await fs.writeFile(file,patchServiceTier(await fs.readFile(file,'utf8')));
}
