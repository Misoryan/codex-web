# 架构

`scripts/prepare-desktop.mjs` 下载并校验固定版本的官方 Desktop 归档，只提取所需资源，再应用 `patches/` 和各功能补丁。提取结果位于 `scratch/`，不进入 Git。

`src/server/main.ts` 提供静态资源、上传接口和 WebSocket 桥，通过 `src/server/electron/` 模拟原生 Electron 接口并运行 Desktop 的宿主代码。`src/browser/shim.ts` 将 preload 通信连接到这个桥，并处理浏览器路由和文件选择。

`renderer-sessions.ts` 维护渲染器身份、连接代次、事件重放和命令去重。`resumable-bridge.ts` 处理浏览器重连和确认；`src/shared/` 提供配置与状态传输编码。`global-state-sync.ts` 同步宿主的持久状态。

`scripts/patch-webview.mjs` 组合会话、历史、工具和移动端补丁。`ops/build-mobile-pwa.mjs` 生成 Full 的 PWA 资源，`scripts/build-lite.mjs` 在相同源码上构建 Lite。`ops/` 中保留可复用的界面资源，私人部署与运维脚本不在仓库中。

浏览器面板由 Playwright 控制的宿主浏览器提供画面和输入通道。可视化内容运行在独立沙箱。Sub2API 的管理凭据仅由服务端读取，浏览器接收用量结果。

构建后的 Desktop 应用遵循其原有许可。公开 Git 仓库保存本项目代码与补丁。
