const litePageReads=new WeakMap();
export function liteReadPage(service, query) {
 let reads=litePageReads.get(service);
 if(!reads){reads=new Map();litePageReads.set(service,reads);}
 const key=JSON.stringify(query);
 if(reads.has(key))return reads.get(key);
 const result=Promise.resolve().then(()=>service.readPage(query));
 reads.set(key,result);
 const remove=()=>{if(reads.get(key)===result)reads.delete(key);};
 result.then(remove,remove);
 return result;
}
