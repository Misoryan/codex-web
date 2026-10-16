# 维护与更新

`origin` 指向本 fork，`upstream` 指向 `0xcaff/codex-web`。定制代码在 `main` 维护，功能修改使用单独分支和 PR。

```sh
git remote add upstream https://github.com/0xcaff/codex-web.git
git fetch upstream
git switch -c sync/upstream
git merge upstream/main
npm ci
npm run build
npm test
npm run test:desktop
npm run audit:privacy -- --history
git push -u origin sync/upstream
```

首次配置 remote 时执行 `git remote add`；已配置的 checkout 从 `git fetch` 开始。处理冲突时保留定制功能的行为契约，并使用构建后的 Full/Lite 运行现有验收。上游新增修复应逐项评估，本次源码导入以当前维护版本为准，不代表逐项采纳了上游同日的全部改动。

## 本地修改

优先在本仓库的干净分支修改、验证并提交，再将已审核源码部署到运行目录。不要把旧运行目录的 `.git`、本地提交历史、`runtime/` 或 `scratch/` 推送到本 fork。

如果修复先发生在另一个 checkout，只复制涉及的源码和补丁到功能分支，检查 `git diff` 后重新构建。禁止直接复制整个运行目录。部署地址、网关认证、账号和密钥留在宿主机或独立部署配置中。

首次提交前设置 GitHub noreply 邮箱，并启用本地检查：

```sh
git config user.email YOUR_GITHUB_NOREPLY_EMAIL
npm run hooks:install
```

安装 [Gitleaks](https://github.com/gitleaks/gitleaks) 后，`pre-commit` 检查暂存内容，`pre-push` 检查源码和可达历史。可以通过 `GITLEAKS_PATH` 指定可执行文件路径。GitHub CI 会重复检查，合并前等待 Windows、Linux 构建和验收完成。

## 发布

先在独立 checkout 构建，保留源码提交号和产物哈希。Full/Lite 必须来自同一次构建。切换静态资源后读回部署文件的哈希；后端更新需要单独安排维护时间，避免中断正在运行的会话。

仓库只发布源码、补丁和通用文档。不要上传本机截图、会话录屏、日志、浏览器配置、提取后的 Desktop 应用、CLI 二进制或字体文件。浏览器自动化验收使用独立 fixture，不向真实会话发送消息或处理审批。
