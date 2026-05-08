# TODO

## 待办事项

### [x] 支付成功后主动确认并触发实例创建

参考 `OpenClaw Launch V1` 的实现方式：不要让实例创建强依赖 Creem Dashboard Webhook。主链路应通过支付成功回跳后的主动确认完成；webhook 只作为补偿链路。

**目标流程：**
1. 创建 Creem checkout 时，将 `success_url` 指向 `/console?order=<order_id>&guest_token=<token>` 或 `/checkout?checkout=success&order=<order_id>&guest_token=<token>`。
2. Creem 回跳时带回 `checkout_id` / `request_id` 等参数。
3. 前端检测到支付回跳参数后，调用后端确认接口，例如 `POST /api/orders/:id/creem-confirm` 或 `POST /api/checkout/creem-confirm`。
4. 后端使用服务端 Creem API 查询 checkout 状态，确认 `completed` / `paid` 后更新订单为 `paid`。
5. 订单确认支付后立即调用 Runtime Server 创建用户实例。
6. console 页面轮询订单和实例状态，直到实例变为 `running` 并显示入口。
7. webhook 保留为补偿链路：如果用户支付完成但没有成功回跳，也能异步补触发实例创建。
8. console-data 查询时可增加一次主动对账：pending 订单如存在 `creem_checkout_id`，则向 Creem 查询并补确认。

**Webhook 补偿链路：**
- **URL**: `https://mirofish.best/api/webhooks/creem`
- **事件**: `checkout.completed`
- **Signing Secret**: 使用环境变量 `CREEM_WEBHOOK_SECRET` 管理，不要写入 TODO 或代码。

> 主链路完成后，即使暂时没有配置 webhook，用户支付成功并正常回跳时也应能自动创建实例；webhook 用于兜底处理未回跳、页面关闭、网络中断等异常场景。

**实现状态：**
- 已新增 `/api/checkout/creem-confirm`，支付回跳后由前端主动确认。
- 已将支付确认、webhook 补偿、console 主动对账统一到共享服务层。
- 已支持 `guest_token` 游客入口访问 console，并将支付成功入口保存到本地浏览器。

---

### [x] 将首页 Sign In 改为真正的登录 / 注册入口

当前首页 `Sign In` 按钮还是占位行为，后续需要改成可用的用户登录 / 注册入口，用于支持已支付用户找回自己的实例。

**建议实现：**
1. 首页 `Sign In` 点击后进入登录 / 注册流程，而不是跳转到 pricing。
2. 支持正常邮箱 + 密码登录注册。
3. 登录后进入实例 Dashboard，展示该用户已购买 / 已创建的 MiroFish 实例。
4. 对游客支付用户，允许用同浏览器 `guest_token` 继续访问，并在登录后绑定订单。
5. 与后续 `guest_token`、订单用户归属校验打通。

**实现状态：**
- 首页 `Sign In` 已改为 `/auth/`。
- 已新增邮箱 + 密码登录 / 注册页面和 API。
- 登录后进入 `/dashboard/` 查看实例。
- 若浏览器本地保存过实例入口，首页按钮会优先显示 `Continue`。

---

### [x] 第二阶段：实现正式支付与实例找回体验

同时支持游客支付和登录后支付。游客支付完成后自动形成可找回的轻量用户身份；已登录用户支付完成后，订单和实例直接绑定到当前账号，避免用户回到首页、换设备或清缓存后找不到已创建实例。

**目标效果：**
- 游客可以直接从首页 `Start Now` 进入支付。
- 已登录用户可以直接购买套餐，支付完成后实例自动归属到当前账号。
- 支付成功后自动创建实例，并进入实例状态页 / 控制台。
- 系统保存用户账号 / 支付邮箱、订单、实例之间的关联。
- 用户以后通过首页 `Sign In` 登录账号，查看已绑定实例；同浏览器游客订单可在登录后绑定账号。
- 登录后进入 Dashboard，查看当前账号下的所有已购买 / 已创建实例，以及当前浏览器可绑定的游客订单。

**建议实现：**
1. 创建游客身份：支付前生成 `guest_id`，并写入 cookie / localStorage。
2. 支付订单补充字段：保存 `user_id`、`customer_email`、`creem_customer_id`、`guest_id`。
3. 游客访问令牌：支付前生成 `guest_token`，写入 HttpOnly cookie，并在支付回跳链接中带回。
4. console 支持 `/console?order=<order_id>&guest_token=<token>` 查询订单和实例。
5. 支付成功后保存本地入口，主页显示“继续进入我的实例”。
6. 支付完成后向支付邮箱发送实例入口邮件。
7. 首页 `Sign In` 支持邮箱 + 密码登录注册。
8. 已登录支付时，将 checkout、订单、实例绑定到当前 `user_id`。
9. 新增实例 Dashboard，登录后按账号展示实例列表，并提示可绑定的游客订单。
10. 增加实例归属校验，避免仅凭可猜字段访问实例。
11. 支持管理员重新生成访问链接、补发实例入口邮件。

**实现状态：**
- 已新增账号密码、session、guest_id 数据模型，并保留旧 `claim_token_hash` 字段兼容历史入口。
- 已登录用户支付时订单绑定 `user_id`；游客支付时绑定 `guest_id` / `guest_token`。
- webhook / 主动确认会保存支付邮箱和 customer id。
- `/dashboard/` 可按账号展示订单和实例，并展示当前浏览器 `guest_token` 可绑定的游客订单。
- 管理员补发入口仍需后续管理后台支持。

---

### [x] 创建 MiroFish 模版包

从开源项目构建模版包，后续新建用户实例时直接解压使用。

**步骤：**
1. 在服务器上 clone 源码：`git clone https://github.com/666ghj/MiroFish`
2. 安装依赖：`npm install` + `uv sync`
3. 配置 `.env`，验证服务正常启动（前端 + 后端均可访问）
4. 清理用户数据（`.env`、`data/`、`memory/`、`tasks/`、`logs/`）
5. 打包：`tar -czf mirofish-template-<date>.tar.gz .`
6. 上传到服务器 `/data/mirofish/prod/templates/`

---

### [ ] 实现实例自动部署（Runtime Server）

支付确认后自动在 VPS 上创建 MiroFish 实例。

**依赖**：模版包已就绪、VPS 已安装 Docker + Docker Compose。

**流程**：支付回跳主动确认 / webhook 补偿 / console 主动对账 → Cloudflare Worker 更新 D1 → 调用 VPS Runtime Server API → 解压模版包 → 启动容器 → 健康检查 → 更新 `mf_instances.status = running`

---

### [ ] 排查支付成功回跳后的确认耗时

**现象：**
- 测试支付完成后，`/checkout?checkout=success...` 页面显示“Payment completed! Your MiroFish workspace is being prepared.”前，支付确认阶段耗时接近 5 秒。

**待排查方向：**
1. 前端 `confirmCheckoutReturn()` 调用 `/api/checkout/creem-confirm` 的实际耗时。
2. 后端 `confirmCreemCheckoutAndProvision()` 中 Creem checkout 状态查询耗时。
3. `provisionPaidOrder()` 是否同步等待 Runtime Server 创建实例，导致支付确认接口被实例创建耗时拖慢。
4. 优化方向：支付确认接口只完成“确认支付 + 写入订单/实例 queued/creating”，实例创建改为异步触发或后台补偿，前端立即进入 console 轮询状态。

---

### [ ] 增加用户实例 LLM Token 用量统计

在 Runtime Server 的 LLM 代理层统计所有用户实例调用 LLM 的 token 消耗，便于后续成本核算、用户用量分析和异常消耗排查。

**背景：**
- 当前用户实例通过 Runtime Server 的 `/v1` 代理访问平台 LLM。
- 现有日志没有保存 `prompt_tokens`、`completion_tokens`、`total_tokens`。
- 已完成的推演无法准确回溯 token 消耗，只能去上游模型平台后台查总账单。

**建议实现：**
1. 在 Runtime Server 的 LLM 代理响应中解析上游返回的 `usage` 字段。
2. 记录 `instance_id`、`model`、`request_path`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`created_at`。
3. 将统计数据写入本地日志或数据库，后续可同步到 D1。
4. 增加按实例、按时间范围汇总 token 用量的查询接口。
5. 注意兼容非流式和流式响应；如果流式响应拿不到 usage，需要记录请求次数并标记 `usage_unavailable`。
