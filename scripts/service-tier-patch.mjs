import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const marker='codex-web-magpie-gpt-standard-fast-v3';
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
    const isGateway=auth?.authMethod==='apikey'&&codexWebIsMagpie(config);
    const eligible=isGateway||auth?.authMethod==='chatgpt'||auth?.authMethod==='personalAccessToken';
    const {data:requirements,isPending}=Zs(Hd,{authMethod:auth?.authMethod??null,hostId});
    const isLoading=!!auth?.isLoading||(auth?.authMethod==='apikey'&&configLoading)||(eligible&&isPending);
    const serviceTierAccess=us().useMemo(()=>eligible&&!isLoading&&requirements!=null ? (isGateway?{...oee(requirements),ultrafast:false,codexMagpie:true}:oee(requirements)):null,[eligible,isLoading,requirements,isGateway]);
    return {serviceTierAccess,isLoading};
  }`);
  edit('bga',()=>`async function bga(scope,hostId,config,knownAuth) {
    const auth=knownAuth??await _ga(scope,hostId);
    const gateway=auth==='apikey'&&codexWebIsMagpie(config);
    if(auth!=='chatgpt'&&auth!=='personalAccessToken'&&!gateway)return null;
    const requirements=await KPe(scope,hostId,{priority:'critical'});
    scope.query.setData(Hd,{authMethod:auth,hostId},requirements);
    const access=oee(requirements);
    return gateway?{...access,ultrafast:false,codexMagpie:true}:access;
  }`);
  edit('kJ',()=>`async function kJ(scope,hostId,model,override) {
    try {
      const auth=await _ga(scope,hostId);
      let config;
      if(auth==='apikey')config=hm((await HLi(scope,hostId,{includeLayers:false,cwd:null},{priority:'critical'})).config);
      const gateway=auth==='apikey'&&codexWebIsMagpie(config);
      if(gateway&&!codexWebIsGptModel(model??config.model))return null;
      const access=await bga(scope,hostId,config,auth);
      if(override!==undefined)return codexWebLimitServiceTier(RZe(null,override,access),gateway);
      const preference=scope.get(iHe,hostId);
      if(preference.type!=='fromConfig')return codexWebLimitServiceTier(RZe(null,dJe(preference,null),access),gateway);
      config??=hm((await HLi(scope,hostId,{includeLayers:false,cwd:null},{priority:'critical'})).config);
      const tier=RZe(config.service_tier==null?await xga(scope,hostId,model??config.model):null,config.service_tier,access);
      return codexWebLimitServiceTier(tier,gateway);
    } catch(error) {gr.error('Failed to read service tier for request',{safe:{},sensitive:{error}});return null;}
  }`);
  edit('DWi',body=>{
    const from='let t = fVi(h?.models, o.model),';
    if(body.split(from).length!==2)throw Error('Service tier model selection changed');
    const selected='(k = A == null ? null : sve(t, A))';
    if(body.split(selected).length!==2)throw Error('Service tier request selection changed');
    return body.replace(from,'let t = codexWebServiceTierModel(fVi(h?.models,o.model),o.model,D?.codexMagpie===true),')
      .replace(selected,'(A = D?.codexMagpie===true ? (codexWebIsGptModel(o.model)?codexWebLimitServiceTier(A,true):null) : A), '+selected);
  });
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source+`
codexWebIsMagpie.patch='${marker}';
function codexWebIsMagpie(config) {
  if(config?.model_provider!=='custom')return false;
  const provider=config.model_providers?.custom;
  return provider?.wire_api==='responses'&&typeof provider.base_url==='string'&&provider.base_url.replace(/\\/+$/,'')==='http://127.0.0.1:3425/v1';
}
function codexWebIsGptModel(modelId) {return typeof modelId==='string'&&modelId.startsWith('gpt-');}
function codexWebLimitServiceTier(tier,gateway) {return !gateway?tier:tier==='fast'||tier==='priority'?'priority':null;}
function codexWebServiceTierModel(model,modelId,gateway) {
  if(!gateway)return model;
  const gpt=codexWebIsGptModel(model?.model??modelId);
  return {...model,model:model?.model??modelId,defaultServiceTier:gpt?codexWebLimitServiceTier(model?.defaultServiceTier,true):null,serviceTiers:gpt?[{id:'priority',name:'Fast'}]:[]};
}
`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const file=path.resolve(process.argv[2]??'scratch/asar/webview/assets/app-initial-6350d04672d0.js');
 await fs.writeFile(file,patchServiceTier(await fs.readFile(file,'utf8')));
}
