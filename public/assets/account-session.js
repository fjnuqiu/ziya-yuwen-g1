export const AUTH_STORAGE_PREFIX = 'chinese-literacy-g1:auth:v1:';

export function createAccountClient({ createClient, url, key, storage }) {
  if (!url || !key) throw new Error('请先配置语文账号服务。');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(endpoint.hostname)) throw new Error('账号服务地址不正确。');
  if (!key.startsWith('sb_publishable_')) throw new Error('请使用浏览器专用的 publishable key。');
  const client = createClient(endpoint.origin, key, {
    auth: { storageKey: `${AUTH_STORAGE_PREFIX}${endpoint.hostname}`, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, ...(storage ? { storage } : {}) },
  });
  const listeners=new Set();let recovering=false;
  // Capture password recovery before curriculum downloads finish and before the
  // UI subscribes. The SDK may consume the redirect immediately on creation.
  client.auth.onAuthStateChange((event,session)=>{
    if(event==='PASSWORD_RECOVERY')recovering=true;
    if(event==='SIGNED_OUT')recovering=false;
    for(const callback of listeners)setTimeout(()=>callback(event,session),0);
  });
  return {
    client,
    get recovering(){return recovering;},
    namespace: `email:${endpoint.hostname}`,
    // This cached session selects the UI/cache only. Supabase verifies JWTs and
    // auth.uid() for every database request; the client never supplies ownership.
    async current() { const {data,error}=await client.auth.getSession(); if(error)throw error; return data.session; },
    watch(callback) { listeners.add(callback);return{unsubscribe(){listeners.delete(callback);}}; },
    async signIn(email,password) { const {error}=await client.auth.signInWithPassword({email:email.trim(),password});if(error)throw error; },
    async signUp(email,password,redirectTo) { const {data,error}=await client.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:redirectTo}});if(error)throw error;return data.session; },
    async reset(email,redirectTo) { const {error}=await client.auth.resetPasswordForEmail(email.trim(),{redirectTo});if(error)throw error; },
    async updatePassword(password) { const {error}=await client.auth.updateUser({password});if(error)throw error;recovering=false; },
    // A sign-out in Chinese must never terminate sessions in another app/device.
    async signOut() { const {error}=await client.auth.signOut({scope:'local'});if(error)throw error; },
  };
}

export function accountError(error) {
  const code=error?.code||'', message=error?.message||'';
  if(/invalid_credentials|invalid login credentials/i.test(code+' '+message))return '邮箱或密码不正确，请检查后再试。';
  if(/email_not_confirmed/i.test(code))return '请先打开邮箱中的确认邮件，再回来登录。';
  if(/over_.*rate_limit|rate limit/i.test(code+' '+message))return '操作有些频繁，请稍等一会儿再试。';
  if(/weak_password|password/i.test(code))return '请使用至少 8 位密码，包含字母和数字。';
  if(/signup_disabled/i.test(code))return '暂未开放注册，请使用已经创建的语文账号。';
  if(/fetch|network|timeout/i.test(message))return '暂时连接不上账号服务，请检查网络后再试。';
  return '操作暂未完成，请稍后重试。';
}
