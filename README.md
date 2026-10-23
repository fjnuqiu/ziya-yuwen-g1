# 字芽 · 一年级语文

独立的语文陪学网站，默认每天 20 分钟。按课本顺序学习拼音和汉字，再通过纸笔小测、开口认读和间隔复测检验掌握情况。

## 使用

家长注册自己的语文邮箱账号，手机和电脑使用同一账号。老师进度、学习安排、已学项目和小测结果自动同步；临时断网时先保存在本机。换设备前请确认显示“已同步”。语文使用独立的 Supabase 项目，与英语数据分开。

参考人教社当前《语文一年级上册》官方电子版。共 40 个课次与语文园地，280 个会认字字形、100 个会写字、63 个基础拼音项目，另有自编巩固练习。具体印次和课堂要求以学校课本为准。

- [按课序学习清单](docs/一年级上册-按课序学习清单.md)
- [教材核验说明](docs/curriculum-verification.md)

## 开发和部署

使用 Node.js 22.13 或以上，运行 `npm ci`、`npm test`、`npm run dev`。

在一个独立的 Supabase Free 项目依次应用 `supabase/001_ziya_progress.sql` 和 `supabase/002_ziya_curriculum.sql`。在 GitHub Actions 变量或未追踪的本地环境配置 `VITE_ZIYA_SUPABASE_URL` 和 `VITE_ZIYA_SUPABASE_PUBLISHABLE_KEY`。只能使用公开的 publishable key，不能将 secret key、service role 或管理令牌放入网页。

Supabase Auth 的网站地址与重定向地址需要包含 Pages 的完整仓库路径及末尾斜线。Pages 发布源使用 GitHub Actions，工作流会执行测试和 `npm run build:pages`，无配置时会停止构建。

源码只含网站程序、公开教材项目清单和自编练习，不含真实账号、成绩或浏览器记录。数据库通过登录身份和行级权限隔离记录；公开网页源码不会使学习记录公开。

第三方字体与笔顺资源的许可证见 `public/assets/vendor/`。旧网址的语文进度可先导出，再在新网址的家长设置导入；导入会合并学习记录。
