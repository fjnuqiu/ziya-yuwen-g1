import { accountError } from './account-session.js';
const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountAccountGate(root,{account,configurationError='',mode='login',onPasswordChanged=()=>{}}) {
  const abort=new AbortController(); let currentMode=mode, busy=false;
  function render(message='',isError=false) {
    const signup=currentMode==='signup',reset=currentMode==='reset',recovery=currentMode==='recovery';
    root.innerHTML=`<main class="account-page"><section class="account-story"><a class="brand" href="#"><img src="favicon.svg" width="48" height="48" alt=""><span><span class="brand-name">字芽</span><span class="brand-subtitle">一点一点，长出本领</span></span></a><p class="eyebrow">一年级上册 · 语文陪学</p><h1>每天一点点，<br>把学过的<br><em>变成记住的。</em></h1><p class="account-intro">读一读，写一写，再合上答案试一试。<br>手机学到哪，电脑就从哪里接着学。</p><div class="account-steps"><span>01 先学习</span><span>02 再小测</span><span>03 隔天复测</span></div><span class="account-badge">每天约 20 分钟 · 按课本顺序</span></section><section class="account-card" aria-labelledby="account-title"><p class="eyebrow">家长账号</p><h2 id="account-title">${recovery?'设置新密码':signup?'创建语文账号':reset?'找回密码':'欢迎回到字芽'}</h2><p>${recovery?'新密码只用于这套语文账号。':signup?'建议由家长保管账号，手机和电脑使用同一个账号。':reset?'输入注册邮箱，我们会发送重设密码的邮件。':'登录一次，学习进度自动保存。'}</p><form id="account-form">${recovery?'':`<label>邮箱<input name="email" type="email" inputmode="email" autocomplete="username" required placeholder="家长的邮箱地址" ${configurationError?'disabled':''}></label>`}${reset?'':`<label>密码<div class="password-field"><input name="password" type="password" autocomplete="${signup||recovery?'new-password':'current-password'}" required ${signup||recovery?'minlength="8"':''} placeholder="${signup||recovery?'至少 8 位，建议包含字母和数字':'输入密码'}" ${configurationError?'disabled':''}><button type="button" data-account="show-password" aria-label="显示密码" aria-pressed="false">显示</button></div></label>`}<p id="account-feedback" role="status" aria-live="polite" class="account-feedback ${isError||configurationError?'error':''}">${esc(configurationError||message)}</p><button class="button primary large" type="submit" ${configurationError?'disabled':''}>${recovery?'保存新密码':signup?'创建账号':reset?'发送重设邮件':'登录并继续学习'}</button></form>${recovery?'':`<div class="account-links">${currentMode==='login'?'<button type="button" data-account="signup">第一次来，创建账号</button><button type="button" data-account="reset">忘记密码</button>':'<button type="button" data-account="login">返回登录</button>'}</div>`}<div class="account-privacy"><strong>这是孩子的独立语文空间</strong><p>语文的学习安排、小测和错题单独保存。无需 ChatGPT 账号。</p></div></section></main>`;
  }
  root.addEventListener('click',event=>{
    const action=event.target.closest('[data-account]')?.dataset.account;
    if(!action||busy)return;
    if(action==='show-password'){
      const field=root.querySelector('[name=password]');if(!field)return;
      const shown=field.type==='password';field.type=shown?'text':'password';event.target.textContent=shown?'隐藏':'显示';event.target.setAttribute('aria-label',shown?'隐藏密码':'显示密码');event.target.setAttribute('aria-pressed',String(shown));
    }else{currentMode=action;render();root.querySelector('input')?.focus();}
  },{signal:abort.signal});
  root.addEventListener('submit',async event=>{
    if(event.target.id!=='account-form')return;event.preventDefault();if(busy||!account)return;
    const form=event.target,data=new FormData(form),feedback=root.querySelector('#account-feedback');
    const email=String(data.get('email')||''),password=String(data.get('password')||'');
    busy=true;form.querySelector('button[type=submit]').disabled=true;feedback.textContent='正在连接…';feedback.classList.remove('error');
    const redirectTo=new URL('./',location.href).href;
    try{
      if(currentMode==='login')await account.signIn(email,password);
      else if(currentMode==='signup'){const session=await account.signUp(email,password,redirectTo);if(!session)render('请查收确认邮件，确认邮箱后即可登录。');}
      else if(currentMode==='reset'){await account.reset(email,redirectTo);render('如果该邮箱已注册，会收到重设密码的邮件。');}
      else{await account.updatePassword(password);onPasswordChanged();}
    }catch(error){if(!abort.signal.aborted){feedback.textContent=accountError(error);feedback.classList.add('error');}}
    finally{busy=false;if(!abort.signal.aborted){const button=root.querySelector('button[type=submit]');if(button)button.disabled=!!configurationError;}}
  },{signal:abort.signal});
  render();return()=>abort.abort();
}
