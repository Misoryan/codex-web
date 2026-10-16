// Lossless per-connection state deltas. Native consumers still receive full snapshots.
type Envelope = {type:string;channel?:string;args?:any[];[key:string]:any};
export class PersistedStateEncoder {
 private previous: Record<string,string> | null = null;
 encode(message:Envelope):Envelope {
  const command=message.args?.[0];
  if(message.type!=="ipc-main-event"||command?.type!=="persisted-atom-sync"||!command.state)return message;
  const current:Record<string,string>=Object.create(null),changed:Record<string,unknown>=Object.create(null);
  for(const [key,value] of Object.entries(command.state)){
   current[key]=JSON.stringify(value);
   if(this.previous?.[key]!==current[key])changed[key]=value;
  }
  const previous=this.previous;this.previous=current;
  if(!previous)return message;
  const removed=Object.keys(previous).filter(key=>!Object.hasOwn(current,key));
  const {state,...metadata}=command;
  return {...message,args:[{...metadata,type:"lite-persisted-state-delta",changed,removed},...message.args!.slice(1)]};
 }
}
export class PersistedStateDecoder {
 private state:Record<string,unknown>|null=null;
 decode<T extends Envelope>(message:T):T {
  const command=message.args?.[0];
  if(message.type!=="ipc-main-event")return message;
  if(command?.type==="persisted-atom-sync")this.state=structuredClone(command.state);
  if(command?.type!=="lite-persisted-state-delta")return message;
  if(!this.state)throw Error("State delta before initial snapshot");
  const {changed,removed,...metadata}=command;
  for(const key of removed)delete this.state[key];
  for(const [key,value] of Object.entries(changed))Object.defineProperty(this.state,key,{value,writable:true,enumerable:true,configurable:true});
  return {...message,args:[{...metadata,type:"persisted-atom-sync",state:structuredClone(this.state)},...message.args!.slice(1)]};
 }
}
