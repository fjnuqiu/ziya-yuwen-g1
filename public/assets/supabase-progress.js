import { APP_ID, initialState, mergeStates, normalizeState, validateSettingsPatch } from './sync-model.js';

function fail(error) {
  const login=['PGRST301','PGRST302','42501'].includes(error?.code)||error?.status===401;
  const message=login?'登录已过期，请重新登录这个语文账号。':error?.code==='PGRST202'||error?.code==='42P01'?'语文同步服务尚未完成配置，本机记录会保留。':'同步暂未完成，本机记录会保留，请稍后重试。';
  throw Object.assign(new Error(message),{login});
}

/** Adapts the existing durable outbox to an isolated Supabase project. */
export function makeSupabaseProgressFetcher({client,ownerId,knownIds}) {
  const unpack=row=>({app:APP_ID,userId:ownerId,state:normalizeState(row?.state||initialState(),knownIds),revision:Number(row?.revision||0),updatedAt:row?.updated_at||null});
  async function read(signal){
    const {data,error}=await client.from('ziya_progress').select('state,revision,updated_at').eq('user_id',ownerId).abortSignal(signal).maybeSingle();
    if(error)fail(error);return unpack(data);
  }
  const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  return async (_path,options={})=>{
    if(!options.method||options.method==='GET')return response(await read(options.signal));
    const body=JSON.parse(options.body);
    if(body.app!==APP_ID||!/^[A-Za-z0-9-]{16,80}$/.test(body.requestId))throw Error('语文同步请求格式不正确。');
    const delta=normalizeState(body.state,knownIds),patch=validateSettingsPatch(body.settingsPatch);
    const initial=body.initialSettings?validateSettingsPatch(body.initialSettings):{};
    let remote=await read(options.signal);
    for(let n=0;n<8;n++){
      const next=mergeStates(remote.state,delta,{...(remote.revision===0?initial:{}),...patch},knownIds);
      // Ownership comes from the verified JWT. The expected account is only a
      // guard: a token change during this request must not move A's data into B.
      const {data,error}=await client.rpc('ziya_commit_progress',{p_account_id:ownerId,p_request_id:body.requestId,p_expected_revision:remote.revision,p_state:next}).abortSignal(options.signal);
      if(error)fail(error);
      if(data.user_id!==ownerId)throw Object.assign(new Error('账号已变化，请重新登录。'),{login:true});
      remote=unpack(data);
      if(!data.conflict)return response(remote);
    }
    throw Error('另一台设备也在保存，请稍后自动重试。本机记录已保留。');
  };
}
