# Steam 日报

每天北京时间 04:00 开始采集前一天的游戏发售、近期首次发现的商品页和 Demo；未完成时每小时自动续采。使用 GitHub Actions 和 GitHub Pages，采集不依赖个人电脑开机。

网页按日期浏览近 30 天，支持按好评率排序、标签筛选、名称搜索和只看 Demo。项目包含本机版和云端版。

部署步骤见 [CLOUD-SETUP.md](CLOUD-SETUP.md)，本机操作见 [outputs/README.md](outputs/README.md)。

```sh
node --test work/history.test.mjs work/cloud.test.mjs
node cloud/build.mjs
```

Steam 限流、第三方服务故障或 GitHub 调度延迟时，日报可能部分完成。程序保留成功结果、标明缺漏并重试，不承诺全量搜索覆盖或绝对可用性。Steam 没有公开的完整商品页创建时间历史；新发现不等于当天新建。
