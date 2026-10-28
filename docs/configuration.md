# 运行配置

## 服务与 CLI

`npm run server -- --host 127.0.0.1 --port 8214` 启动服务。`CODEX_CLI_PATH` 指向已安装的 Codex CLI；未设置时使用 `PATH` 中的 `codex`。沿用 Codex CLI 本身的登录方式和用户目录，仓库不包含账号配置。

Windows 后台启动可以执行 `./start.ps1 -Port 8214`，通过 `./stop.ps1` 停止该 checkout 启动的进程。该脚本默认从已安装的 Desktop 提取完整 CLI 辅助程序到私有运行目录，避免 Desktop 更新删除正在使用的可执行文件；也可以显式设置 `CODEX_CLI_PATH`。不要将端口改为已有服务正在使用的值。

当前 Desktop 对应的 CLI 基线为 `0.162.0-alpha.17.2`。升级时需要一并核对协议和辅助程序。

## Sub2API 用量面板

该功能可选。未配置时面板关闭。需要启用时，在宿主机创建 `runtime/private/sub2api-usage.json`：

```json
{
  "baseUrl": "https://api.example.com",
  "adminKey": "REPLACE_ON_THE_HOST",
  "userId": 1
}
```

管理凭据只由后端读取，不写入前端资源。更换服务运行目录时，需要将此私有文件一起部署，并在启动后检查 `/__backend/sub2api/usage?range=today` 的 `enabled` 与 `report`。不要把实际配置复制到文档或示例文件。

## 本机头像

本机直连客户端从 `runtime/private/local-profile.json` 读取安装使用者的 GitHub 用户名：

```json
{ "github": "YOUR_GITHUB_LOGIN" }
```

本机 `/maa/api/auth/me` 仅向直接访问回环地址的客户端提供该身份，拒绝代理和跨站请求。公网网关须将 `/maa/api/auth/me` 路由到网站自己的认证服务，返回当前登录用户；不能将本机身份作为网站登录凭据。用户名及头像不打包进前端资源。

## 网络、浏览器和临时文件

Full 与 Lite 固定使用新版导航栏和设置布局。控制该布局的上游灰度开关不参与本地评估；其他功能仍使用各自的评估结果。

浏览器面板使用宿主机的 Chrome/Chromium 和现有 Playwright 依赖。构建、检查和运行产物写入仓库的 `runtime/` 与 `scratch/`，均已忽略。部署网关和隧道由操作者在仓库外配置。
