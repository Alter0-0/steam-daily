# Steam 日报云端版

## 运行方式

云端版使用 GitHub Actions 采集，使用 GitHub Pages 展示。启用以后，你的电脑关机、休眠或没有打开 Codex，都不会停止云端任务。浏览器联网后打开云端网址即可，不需要启动本机服务。

任务计划在北京时间每天 04:00 生成前一天日报；每小时第 17 分钟检查一次，未完成则续采。GitHub 的调度可能延迟，04:00 是开始时间，不是保证生成完成的时间。Steam 宕机或限制请求时仍可能当天不完整，网页会显示“部分完成”或“待补采”。成功项目会保存，下一轮继续。

日报与详情缓存保存在仓库的 `daily-data` 分支，不依赖临时运行机器或会过期的缓存。部署失败也不会删除已经保存的日报。

## 为 xbjy0713 部署

计划使用公开仓库 `https://github.com/xbjy0713/steam-daily`。代码与日报数据会公开。上传清单仅含项目代码、说明、测试和历史日报，排除本机日志、备份、缓存、锁文件；不需要把任何密码或令牌放进代码。

1. 登录 GitHub，创建名为 `steam-daily` 的仓库，选择 **Public（公开）**。
2. 将准备好的项目上传到该仓库，默认分支使用 `main`。必须保留 `.github/workflows/daily.yml` 的目录层级；GitHub 不会自动解压上传的 ZIP。
3. 在仓库顶部点 **Settings**，左侧点 **Pages**。
4. 在 **Build and deployment** 的 **Source** 下拉框选择 **GitHub Actions**。
5. 点仓库顶部 **Actions**，左侧选择 **Steam Daily Cloud**，点 **Run workflow**，选择 `main` 后再次点 **Run workflow**。
6. 等待运行完成。在运行详情的 **Publish website** 中查看实际网址；只有这里成功才表示网站已部署。预计网址为 `https://xbjy0713.github.io/steam-daily/`，部署前不能当作已生效网址。
7. 打开实际网址，页面应显示“云端日报”。日期栏会保留近 30 天记录，未完整的日期会标明状态。

以后主要使用云端网址。本机 `127.0.0.1` 仍读取本机数据，不会自动同步云端。云端首次成功并验证后，可以停用本机 SteamDailyCollector 定时任务，避免重复采集；不会停用网页服务。

## 判断是否工作正常

- Actions 成功且网页显示前一天：采集和部署正常。
- Actions 失败但网页显示“部分完成”：云端已发布保存结果，下次任务继续。
- Actions 的错误位于 Configure/Publish Pages：先核对 Settings → Pages 是否选择 GitHub Actions。
- 显示权限错误：核对工作流未被账户或仓库策略禁用，且未禁止本仓库 `GITHUB_TOKEN` 的写入权限。
- 免费账户的额度、GitHub 故障、Steam 限制和公开仓库长期不活跃时停用定时任务，都可能影响调度。在 GitHub 通知或 Actions 中发现异常后应检查。这不是绝对可用性保证；更严格的时效要求需要持续运行的服务器和监控。

## 数据的准确范围

游戏和 Demo 按 Steam 当前返回的发售日期扫描，重复页或保护上限不能算完整成功。“新发现商品页”是本采集器首次看到的页面，Steam 搜索无法保证包含全部新建页；历史创建时间无法还原。Steam 未提供精确解锁时刻时，不能直接把其日期视为已校正到北京时间。

新逻辑只补采未完成日报，完整日报保留快照，不会随着测评变化反复改写。好评率未能读取时显示暂无，不代表零好评。

## 本地验证

在项目文件夹打开 PowerShell：

```powershell
node --test work/history.test.mjs work/cloud.test.mjs
node cloud/build.mjs
```

构建结果在 `site` 文件夹，仅作部署预览。自动采集真正启用必须完成 GitHub 配置并成功运行云端任务。
