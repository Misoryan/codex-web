# 浏览器中的代码审查

构建步骤使用运行 Codex Web 的 Node 启动内置 Code Review 插件，并为改过的插件定义生成新的版本与 bundle 标识。原生宿主沿用同一 Node 运行时，避免提取的桌面包依赖其他平台的可执行文件或 shell。

MCP App 通过 `/__backend/mcp-app-documents` 创建临时 HTTP 文档。正常 HTTP 地址支持 Code Review 的页面路由；响应的 CSP sandbox 与 iframe 都只允许 scripts/forms，不允许 same-origin。应用不能读取主页面的 DOM、Cookie 或存储。文档只存于进程内存，关闭应用时删除，未关闭的记录十五分钟后过期，总量限制为 32 MiB。网关应将该路径路由到 Codex Web 后端。

应用的偏好存储由浏览器容器按应用地址分别保存。应用只能操作自己的偏好，不能访问宿主 localStorage。表单原生导航仍被 CSP 禁止，工具操作通过 MCP App SDK 处理。

Code Review 使用后端 GitHub CLI 的真实授权身份，通过 GitHub API 查询账号及仓库权限。浏览器关闭 GitHub 服务和连接器身份发现实验开关（`223049465`、`1892621033`），让原生插件及宿主侧栏使用已有的 GitHub CLI 路径，不依赖 ChatGPT 登录。网页用户共享该后端身份；网页显示的用户名不作为 GitHub 凭据。需要在后端执行 `gh auth login` 完成授权，再在 Code Review 中重新检查。

浏览器沙箱将 `ui/openai/first-party-plugin-bridge` 请求转交原生宿主，并通过 `notifyMcpAppsMcpNotification` 把宿主通知送回应用。这条双向通道负责账号、PR 侧栏列表及选择操作的同步；仅工具调用成功不能证明侧栏可用。沙箱继续保持不透明来源，不开放主页面 DOM 或存储。

Code Review 的收藏、最近访问与侧栏快照按后端 GitHub CLI 返回的主机名和账号划分，不再要求 ChatGPT 账号 ID。这个作用域只负责界面状态隔离，GitHub 权限仍由后端授权决定。

插件将成功读取的 GitHub CLI 身份复用三十秒，并合并同时发生的账号读取；点击重新检查账号时立即重新读取。PR 内容、检查结果和合并状态沿用原生插件的读取与失效规则。每次写操作都重新核对真实账号，同一操作内复用该结果。合并沿用 GitHub CLI 的 `--match-head-commit` 校验，直接执行合并，删除重复的安装与授权预检。账号发现中的 CLI 检测和用户查询并行执行。`scripts/test-code-review-performance.cjs` 通过真实 MCP 插件入口和隔离 CLI 验证并发、过期、账号切换、授权失效及合并失败；不会操作真实 PR。

打开 PR 时，合并状态与摘要并行读取。手动 Merge 只有在摘要、合并状态的 head/base 相同，且同一 head 的元数据明确确认写权限后才启用。性能验收以手动 Merge 菜单项通过浏览器可点击性检查为终点；外层下拉按钮可用不代表手动合并可用。`scripts/test-code-review-merge-readiness.cjs` 在真实插件界面验证并行读取，以及权限未返回、无写权限、版本不一致、草稿、冲突和读取失败时禁止合并。

优先读取摘要、权限和合并状态，三项完成后再发起正文、审查和评论读取；摘要可用后立即显示详情页头部，其余内容各自显示加载状态。GitHub 确认合并成功后立即结束确认操作，旧 PR 和列表在后台刷新。同账号、同仓库其他 PR 的摘要和合并状态会标为过期，并暂时禁止手动合并；下次打开时重新检查新 base。`scripts/test-code-review-sequential-merges.cjs` 用真实界面连续合并三个隔离 PR，验证慢正文、慢评论、慢刷新不阻塞操作，已缓存的下一个 PR 必须重新检查，并验证合并失败后保留错误和重试入口。

构建为 Code Review 的 JS/CSS 资源 URI 加入完整 SHA-256。浏览器沙箱按应用来源和内容地址复用这些公开静态资源，并核对返回内容的哈希，避免每次切换 PR 都通过 MCP 重传整套脚本和样式。哈希变化会读取新资源，失败不缓存；工具结果、PR 内容和未版本化资源不参与复用。`scripts/test-code-review-resources.cjs` 通过真实 MCP App SDK 与沙箱验证这些边界。插件版本摘要覆盖服务端、界面脚本及 HTML，静态资源更新会生成新插件版本。

页面加载成功后，GitHub CLI 尚未安装或授权时显示对应提示。页面验收不代表已完成真实 PR 读取、提交审查或合并。

运行 `npm run build:server`、`node scripts/test-mcp-app-sandbox.cjs` 与 `node scripts/test-code-review-ui.cjs` 验证文档边界、沙箱行为和固定桌面包中的原版审查页面。正常服务与桌面测试分别使用 `npm test`、`npm run test:desktop`。
