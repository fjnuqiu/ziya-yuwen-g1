import { createClient } from '@supabase/supabase-js';
import { boot } from '../public/assets/app.js';
import { createAccountClient } from '../public/assets/account-session.js';

const url = import.meta.env.VITE_ZIYA_SUPABASE_URL;
const key = import.meta.env.VITE_ZIYA_SUPABASE_PUBLISHABLE_KEY;
let account, configurationError;
try { account = createAccountClient({ createClient, url, key }); }
catch { configurationError = '账号服务尚未连接，暂时不能登录。原来的学习记录仍保留在原网站。'; }
boot({ account, configurationError });
