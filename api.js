import {CONFIG} from './config.js?v=8a1736d6d9a8';
import {emptyState,validateRecord,nextDate,today} from './domain.js?v=8a1736d6d9a8';
const DEMO_KEY='myc-demo-v2';
export class ApiError extends Error {constructor(message,code){super(message);this.code=code;}}
export class MycApi {
  constructor(){this.token=null;this.demo=false;this.user='Carlos';this.expiry=0;}
  login(token,name){this.token=token;this.user=name;this.demo=false;try{this.expiry=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp*1000;}catch{this.expiry=0;}}
  logout(){this.token=null;this.expiry=0;this.demo=false;}
  demoLogin(){this.logout();this.demo=true;this.user='Carlos';if(!localStorage.getItem(DEMO_KEY))localStorage.setItem(DEMO_KEY,JSON.stringify(seed()));}
  demoState(){try{return JSON.parse(localStorage.getItem(DEMO_KEY))||emptyState();}catch{return emptyState();}}
  async request(action,payload={},binary=false){
    if(!navigator.onLine)throw new ApiError('Sin conexión. Conecta a internet para consultar o guardar cambios.','OFFLINE');
    if(!this.token||Date.now()>=this.expiry)throw new ApiError('Tu sesión ha caducado. Vuelve a entrar con Google.','UNAUTHORIZED');
    let response;try{response=await fetch(CONFIG.apiUrl+'/api',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+this.token},body:JSON.stringify({action,payload}),cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(30000)});}catch{throw new ApiError('No se pudo confirmar la operación. Reintenta: se conservará el mismo identificador para evitar duplicados.','NETWORK');}
    if(!response.ok){let error;try{error=await response.json();}catch{error={error:'El servidor no responde correctamente.'};}throw new ApiError(error.error,error.code);}
    if(binary)return response.blob();
    const result=await response.json();return result;
  }
  async authenticate(token){this.login(token,'');const result=await this.request('snapshot');this.user=result.user;return result.data;}
  async snapshot(){if(this.demo)return this.demoState();return (await this.request('snapshot')).data;}
  async mutate(p){
    if(!this.demo)return (await this.request('mutate',p)).data;
    const s=this.demoState();const list=s[p.table];const i=list.findIndex(r=>r.id===p.id);const old=list[i];
    if(old?.lastOperation===p.operationId)return {record:old,duplicate:true};
    if((old?.version||0)!==p.expectedVersion)throw new ApiError('El registro ha cambiado. Actualiza.','CONFLICT');
    let r;if(p.kind==='delete')r={...old,deleted:true};else if(p.kind==='completeTask')r=old.recurrence==='none'?{...old,done:true}:{...old,due:nextDate(old.due||today(),old.recurrence),lastCompletedAt:new Date().toISOString()};else r={...validateRecord(p.table,p.record),receiptId:old?.receiptId};
    if(p.receipt)r.demoReceipt='data:image/jpeg;base64,'+p.receipt.base64;
    else if(old?.demoReceipt)r.demoReceipt=old.demoReceipt;
    r={...r,id:p.id,version:(old?.version||0)+1,createdBy:old?.createdBy||this.user,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),updatedBy:this.user,lastOperation:p.operationId};
    if(i>=0)list[i]=r;else list.push(r);
    try{localStorage.setItem(DEMO_KEY,JSON.stringify(s));}catch{throw new ApiError('No queda espacio local para el ticket de prueba.','STORAGE');}
    return {record:r};
  }
  async receipt(id){if(this.demo){const r=this.demoState().expenses.find(e=>e.id===id);if(!r?.demoReceipt)throw new Error('No hay ticket en este ejemplo.');const [meta,encoded]=r.demoReceipt.split(',');const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));return new Blob([bytes],{type:'image/jpeg'});}return this.request('receipt',{id},true);}
  resetDemo(){localStorage.removeItem(DEMO_KEY);this.demoLogin();}
}
function seed(){return emptyState();}
