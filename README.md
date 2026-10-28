# Codex Web

A self-hosted browser bridge for Codex Desktop, with Full/Lite interfaces, mobile PWA support and resumable sessions.

基于 [0xcaff/codex-web](https://github.com/0xcaff/codex-web) 的维护分支。后端运行在自己的电脑上，可通过浏览器访问 Desktop 界面。当前 Desktop 版本锁定为 `26.1007.30912`。

## 本分支的功能

- Full 和 Lite 两种界面；Lite 减少非会话初始化工作。
- 手机 PWA、侧栏与工具面板布局、上传与图片预览。
- WebSocket 断线续接、命令去重、独立标签页与会话生命周期管理。
- 历史分页、已回答问题状态、子代理历史与标题、发送后草稿处理。
- 浏览器面板、可视化沙箱、可选 Sub2API 用量面板。
- 浏览器本机剪贴板、MCP App 与 Code Review、后台自动化调度。
- 启动预加载与功能配置、不可变静态资源发布、原生订阅与有界日志管理。
- Windows 启停脚本，以及源码和 Git 历史的发布前隐私检查。

手机设置在 768px 及以下使用分类列表和独立详情页。点击分类进入详情，左上角返回分类；搜索、分类行和表单复用 Desktop 组件。桌面保留双栏布局。

公开仓库只包含项目源码、补丁和通用文档。构建时从官方地址下载 Desktop 归档并在本机应用补丁。

## 安装与运行

需要 Node.js 22.12 以上、Git、curl，以及已登录的 Codex CLI。浏览器面板和浏览器验收使用 Chrome/Chromium。

```sh
git clone https://github.com/Misoryan/codex-web.git
cd codex-web
npm ci
npm run build
codex login --device-auth
npm run server -- --host 127.0.0.1 --port 8214
```

打开 [Full](http://127.0.0.1:8214/) 或 [Lite](http://127.0.0.1:8214/lite/)。`CODEX_CLI_PATH` 可以指定 Codex CLI 的可执行文件；否则使用 `PATH` 中的 `codex`。

Windows 后台运行：

```powershell
./start.ps1 -Port 8214
./stop.ps1
```

构建归档缓存在 `runtime/cache/`，每次准备时校验 SHA-256。已有归档可以通过 `HOSTED_CODEX_APP_ZIP` 指定。`npm ci` 只安装依赖；`npm run build` 会重建 `scratch/`，不要在那里保存自己的文件。

## 验证

```sh
npm run build:server
npm test
npm run test:desktop
```

`npm test` 验证服务端续接、配置缓存、用量接口和隔离的浏览器连接。`test:desktop` 需要已完成 Full/Lite 构建，验证实际补丁后的历史、问题状态和 PWA 资源行为。测试使用独立 fixture，不连接现有服务。

安装 [Gitleaks](https://github.com/gitleaks/gitleaks) 后执行隐私检查：

```sh
npm run audit:privacy -- --history
npm run hooks:install
```

GitHub CI 检查隐私，并在 Windows 与 Linux 上构建、运行验收。初次公开版本的审核范围和限制见 [公开前审查](docs/publication-review.md)。

## 维护

后续定制和上游同步流程见 [维护与更新](docs/maintenance.md)。Desktop 版本升级见 [UPGRADING.md](UPGRADING.md)，运行参数和可选统计功能见 [配置](docs/configuration.md)。

浏览器能力见 [客户端能力](docs/client-capabilities.md)，代码审查见 [Code Review](docs/code-review.md)，后台任务见 [自动化](docs/automations.md)。启动和资源发布见 [启动初始化](ops/STARTUP-INITIALIZATION.md) 与 [静态资源缓存](ops/STATIC-ASSET-CACHING.md)，运行故障处理见 [可靠性边界](docs/runtime-reliability.md)。

## 安全与许可

服务能以宿主进程的权限运行命令和访问文件。远程访问需要可信网络或带认证的代理，同时保护 WebSocket 路由；详见 [SECURITY.md](SECURITY.md)。

项目代码沿用上游声明的 MIT 许可，保留上游历史和署名。Codex Desktop、提取后的应用和第三方资源受各自条款约束，详见 [NOTICE](NOTICE)。本项目由社区维护。
