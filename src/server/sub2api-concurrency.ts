export function createConcurrencyService(config: {baseUrl:string;adminKey:string}, http:typeof fetch=fetch, clock=Date.now) {
  type Snapshot = { observedAt:string; expiresAt:string; counts:Record<string,number> };
  let snapshot:Snapshot|null=null, retryAt=0, pending:Promise<Snapshot|null>|undefined;
  return {read():Promise<Snapshot|null> {
    if(clock()<retryAt)return Promise.resolve(snapshot);
    if(pending)return pending;
    pending=(async()=>{
      try {
        const response=await http(config.baseUrl.replace(/\/$/, '')+'/api/v1/admin/ops/user-concurrency',{
          headers:{'x-api-key':config.adminKey},redirect:'error',signal:AbortSignal.timeout(5000),
        });
        if(!response.ok)throw Error('Unavailable');
        const body=await response.json();const data=body.data;
        const observed=Date.parse(data?.timestamp);
        if(body.code!==0||data?.enabled!==true||!data.user||!Number.isFinite(observed)||Math.abs(clock()-observed)>60000)throw Error('Invalid snapshot');
        const counts:Record<string,number>={};
        for(const value of Object.values(data.user) as any[]){
          if(!Number.isSafeInteger(value.user_id)||value.user_id<=0||!Number.isSafeInteger(value.current_in_use)||value.current_in_use<0)throw Error('Invalid count');
          if(value.current_in_use>0)counts[String(value.user_id)]=value.current_in_use;
        }
        snapshot={observedAt:new Date(observed).toISOString(),expiresAt:new Date(observed+60000).toISOString(),counts};
      }catch{snapshot=null;}
      retryAt=clock()+60000;
      return snapshot;
    })().finally(()=>{pending=undefined;});
    return pending;
  }};
}
