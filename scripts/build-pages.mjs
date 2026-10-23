import { build, loadEnv } from 'vite';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { createAccountClient } from '../public/assets/account-session.js';
const env={...loadEnv('production',process.cwd(),'VITE_ZIYA_'),...process.env};
// Fail closed: a published package must never point silently to the English DB.
createAccountClient({createClient:()=>({auth:{onAuthStateChange(){}}}),url:env.VITE_ZIYA_SUPABASE_URL,key:env.VITE_ZIYA_SUPABASE_PUBLISHABLE_KEY});
if(new URL(env.VITE_ZIYA_SUPABASE_URL).hostname==='edqiejhbdnjtknjmxjhj.supabase.co')throw Error('请为语文配置独立的 Supabase 项目，不能使用英语数据库。');
process.env.VITE_ZIYA_SUPABASE_URL=env.VITE_ZIYA_SUPABASE_URL;
process.env.VITE_ZIYA_SUPABASE_PUBLISHABLE_KEY=env.VITE_ZIYA_SUPABASE_PUBLISHABLE_KEY;
await build({configFile:'vite.account.config.mjs'});
await writeFile('dist-pages/.nojekyll','');
await rm('dist-pages/local-preview.html',{force:true});
// Remove the legacy unbundled entry: the account build has one guarded entry.
await rm('dist-pages/assets/app.js',{force:true});
const index=await readFile('dist-pages/index.html','utf8');
if(index.includes('signin-with-chatgpt')||!index.includes('data-auth-mode="email"'))throw Error('发布包的登录入口不正确。');
console.log('独立邮箱登录版已生成：dist-pages/');
