# 发布与回滚

- 日期：2026-10-30；2026-11-01 按[审计](../dev/2026-11-audit.md)缩为步骤清单
- 相关：PR #29

## 为什么

插件内自更新已经禁用：Bot 的 Session 不能替换正在监管它的插件，而且 DSH 热重载时先停旧插件再装新插件，新插件装不上就会留下一个没有 DS Bot 的 Host。所以发布在场外的终端里做。

## 前提

DSH Desktop 的 profile 用 `link:` 指向一个**单独的发布 checkout**，它 detached 在某个已合并的提交上。不要让 Desktop 链到日常开发的工作区。

## 发布

1. **在发布前验证候选提交。**在一个干净的 checkout 里，于 `ds-bot/` 下跑 `npm ci`、`npm run harness`、`npm test`（要求自然退出）、`node scripts/build-client.mjs --check`、`npm run lint`。改了 host 的，还要跑 smoke。
2. **等工作停下来。**确认没有 Bot 正在跑回合，也没有任务正在开或正在关；侧栏全部空闲即可。
3. **完全退出 DSH Desktop。**Desktop 运行时不要改发布 checkout：热重载会在文件改到一半时重新加载插件。
4. **备份。**把 `<DSH_HOME>/bot/` 整个复制到一个私有目录（不进 Git），再记下发布 checkout 当前的提交，作为回滚目标。
5. **切换提交。**

   ```sh
   git -C <发布 checkout> fetch origin
   git -C <发布 checkout> checkout --detach <新提交>
   ```

   `client.js` 已经随源码提交，不需要再构建。
6. **重新打开 Desktop 一次，然后检查：**
   - 关于页显示的版本和提交符合预期；
   - 诊断里没有新的加载、存储或投递错误；
   - Bot、群、历史、记忆和任务都在；
   - 刷新一次页面，再跑一次无害的对话。

## 回滚

完全退出 Desktop，执行 `git -C <发布 checkout> checkout --detach <回滚目标>`，再重新打开一次并做同样的检查。

- 一般保留当前的 `state.json`，不要用备份覆盖。只有数据损坏时才恢复第 4 步的备份，而且要接受备份之后的工作会丢。
- `state.json` 里一旦出现过 v2 任务，回滚目标也必须是能读 v2 任务的版本，即 PR #31 之后的提交。

## 变更

- 2026-11-01：发布改为切换发布 checkout 的提交；删去包管理器的 remove/add 流程、junction 停放脚本和演练记录。原文见 git 历史。
