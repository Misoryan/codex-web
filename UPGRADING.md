# Desktop 版本升级

版本和归档校验值集中保存在 `desktop.json`。`scripts/prepare-desktop.mjs` 与 Nix 构建读取同一份版本信息。

先建立升级分支或独立 checkout，保存当前可部署版本。下载新的官方归档，独立核对 SHA-256 后更新 `desktop.json`。不要在现有服务的 `scratch/` 目录上尝试升级。

## 补丁适配

新的 Desktop 可能改变 bundle 文件名、压缩符号和原生组件结构。需要检查：

1. `patches/` 的上下文与目标文件。
2. `scripts/patch-webview.mjs` 的入口列表和各功能补丁的锚点。
3. `scripts/lite-startup-patches.mjs` 中 Lite 禁用的原生初始化任务。
4. preload 桥、app-host 通信和 CLI 协议版本。

补丁锚点不匹配时构建会失败。应重新定位当前版本的组件，更新补丁与现有验收，不保留旧版本的兼容分支。

从未修改的归档重新运行 `npm run build`，避免把上一次手动修改的提取文件当作源码。对原生补丁使用实际 diff，保留原项目与第三方版权说明。

## 验收与部署

```sh
npm ci
npm run build
npm test
npm run test:desktop
npm run audit:privacy -- --history
```

浏览器验收使用独立 fixture。还需要在隔离测试用户目录中检查 Full/Lite 加载、会话切换、发送草稿、断线续接、工具面板与移动端布局。涉及 CLI 时先核对 Desktop 所需协议版本和完整的 CLI 辅助程序。

部署前保留当前版本、源码提交号和资源哈希。静态文件与后端分别验收；真实手机表现需要实机确认，浏览器设备模拟只作为补充。
