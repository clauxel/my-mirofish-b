# my_mirofish 第一版 SaaS 化方案

## 1. 产品定义

用户付费后获得：**一个托管的 MiroFish AI 预测工作区（Hosted Prediction Workspace），按套餐获得对应的模拟配额和功能权限**

```
一个付费订单 = 1 个可访问的 MiroFish 托管工作区 + 对应套餐的资源配额

Starter（$9/mo 年付，$108/年）
  - 100 次模拟/月，每次最多 50 个 agent
  - 基础预测报告，Text 文件种子上传
  - 无 API 访问，无变量注入，无优先处理

Pro（$14.50/mo 年付，$174/年，省 50%）
  - 500 次模拟/月，每次最多 500 个 agent
  - 高级结构化报告，PDF/MD/TXT 种子上传
  - 完整 REST API 访问，支持模拟中变量注入

Enterprise（$59/mo 年付，$708/年）
  - 无限模拟次数，无限 agent 数量
  - White-label 部署，On-premise / 私有云部署
  - 自定义 LLM 模型集成，专属成功工程师，SLA 支持
```

用户无需自己安装配置，无需提供 LLM API Key，打开控制台即可使用：种子上传 → 多智能体模拟 → 预测报告生成 → 交互对话。

---

## 2. 项目准入评估

**结论：需轻改造**

| 判断项 | 结论 | 依据 |
|--------|------|------|
| 可独立运行 | ✅ | 支持 `docker compose up -d` 一键启动 |
| 可多实例运行 | ⚠️ 需验证 | 无多租户设计，端口固定为 3000/5001，需通过 compose 参数覆盖 |
| 可配置端口 | ✅ | docker-compose 支持端口映射覆盖 |
| 可指定数据目录 | ⚠️ 需改造 | 数据目录路径未明确，需通过 volume 映射隔离 |
| 依赖全局状态 | ⚠️ 需验证 | Zep Cloud 是外部服务，需确认 session/memory 是否按 project 隔离 |
| 可注入密钥 | ✅ | 通过 `.env` 注入 `LLM_API_KEY` / `ZEP_API_KEY` |
| 可代理访问 | ✅ | 前端 HTTP 服务可通过 Nginx/Cloudflare Tunnel 代理 |
| 可观测 | ⚠️ 需补充 | 有 Docker logs，但无标准健康检查接口，需补 `/health` 端点 |
| License | ⚠️ 需注意 | AGPL-3.0 允许 SaaS 商业托管，但须向用户提供源码链接（原项目已公开，满足） |

**轻改造内容（最小化）：**
1. 后端补一个 `GET /health` 端点（Python，5 行代码）
2. 验证多个 docker-compose 实例可共存（不同端口）
3. 确认 Zep Cloud 的 `collection` 或 `user_id` 字段能区分不同实例

---

## 3. 第一版 MVP 边界

**必须做：**
- 支付成功后自动创建 MiroFish 实例（docker-compose 方式）
- 实例有独立端口、目录、访问入口
- 用户能通过平台控制台入口访问自己的实例（代理）
- 管理员能查看/重启/暂停/删除实例
- 用户数据在重启后保留
- 超出套餐名额拦截创建

**暂不做：**
- 用户自助管理实例（重启、删除）
- 模型用量计费和额度控制
- 多宿主机调度
- 实例自动备份恢复
- 团队协作功能
- 精细 RBAC 权限体系

---

## 4. 标准模板包方案

**模板来源：** `https://github.com/666ghj/MiroFish`

**构建流程：**
```bash
git clone https://github.com/666ghj/MiroFish mirofish-template
cd mirofish-template
# 安装依赖
npm install
uv sync  # Python 依赖
# 清理用户数据
rm -rf .env data/ memory/ tasks/ logs/ __pycache__/
# 拷贝配置模板
cp .env.example config/.env.template
# 打包
tar -czf mirofish-template-<version>.tar.gz .
```

**模板目录结构：**
```
mirofish-template-<version>.tar.gz
  manifest.json
  frontend/           # Vue.js 前端源码 + node_modules
  backend/            # Python 后端源码 + .venv
  config/
    .env.template     # 占位符，不含真实 key
    docker-compose.template.yml
  scripts/
    start.sh
    stop.sh
    healthcheck.sh
    smoke-test.sh
  data.example/       # 空目录结构示例
```

**manifest.json：**
```json
{
  "source_repo": "https://github.com/666ghj/MiroFish",
  "source_commit": "<commit_sha>",
  "template_version": "20260506-<sha8>",
  "build_time": "2026-05-06T00:00:00Z",
  "sha256": "<template_sha256>",
  "verified": {
    "install": true,
    "health": true,
    "console": true
  }
}
```

**scripts/healthcheck.sh：**
```bash
#!/bin/bash
BACKEND_PORT=$1
curl -sf http://localhost:$BACKEND_PORT/health && echo "OK" || exit 1
```

**scripts/smoke-test.sh：**
```bash
#!/bin/bash
FRONTEND_PORT=$1
curl -sf http://localhost:$FRONTEND_PORT/ | grep -q "MiroFish" && echo "OK" || exit 1
```

**禁止进入模板包的内容：**
- `.env`（真实配置）
- `LLM_API_KEY` / `ZEP_API_KEY` 真实值
- 用户上传数据、任务历史、记忆文件
- 任何用户会话 token

---

## 5. Runtime 宿主机方案

**推荐部署：** 独立 Linux VPS（2核4G 起，Ubuntu 22.04），安装 Docker + Docker Compose。

**目录结构：**
```
/data/mirofish/
  prod/
    templates/
      mirofish-template-current.tar.gz
      mirofish-template-<version>.tar.gz
    instances/
      mf-<instance_id>/
        app/          # 解压自模板包（runtime代码）
        data/         # 用户上传文件、生成文件
        memory/       # 智能体记忆、状态
        tasks/        # 任务历史
        logs/         # 实例日志
        config/
          .env        # 平台注入的真实配置
    logs/
    backups/
  dev/
    templates/
    instances/
    logs/
```

**端口规划：**
| 环境 | 后端端口段 | 前端端口段 |
|------|-----------|-----------|
| prod | 25001–25999 | 23000–23999 |
| dev | 35001–35999 | 33000–33999 |

**service 命名：** `mirofish-prod-<instance_id>` / `mirofish-dev-<instance_id>`

**runtime user：** 每个实例使用同一个专属系统用户 `mirofish-runner`（第一版可共用，后续升级为按实例隔离）

---

## 6. 实例生命周期设计

**创建流程（支付成功后触发）：**
```
Creem Webhook → my_mirofish API (Cloudflare Worker)
  → 校验 entitlement（是否超出套餐名额）
  → 写 deployment 记录（status: creating）
  → 写 instance 记录（status: creating）
  → 调用 Runtime Server API（VPS 上的管理服务）
    → 分配 instance_id、backend_port、frontend_port、目录
    → 解压模板包到 /data/mirofish/prod/instances/mf-<id>/app/
    → 创建 data/ memory/ tasks/ logs/ 目录
    → 渲染 .env（注入 LLM_API_KEY、ZEP_API_KEY、实例token）
    → docker-compose up -d
    → 轮询 healthcheck.sh（最多 60 秒）
    → smoke-test.sh 验证前端可达
  → 写 console_url 到 instance 记录
  → 更新 instance status: running
  → 更新 deployment status: success
  → 触发给用户的邮件/控制台通知
```

**失败清理：**
```
任一步骤失败 →
  docker-compose down（如已创建）
  删除实例目录
  释放端口记录
  instance status → failed
  deployment status → failed，写 error_message
  runtime_event 记录失败详情
```

---

## 7. 最小数据模型

在 Cloudflare D1（mirofish-b-analytics）中**新建以下表**（不影响现有 analytics 表）：

```sql
-- 用户表（简化版，第一版只存邮箱和支付provider标识）
CREATE TABLE mf_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  provider_customer_id TEXT,
  created_at TEXT NOT NULL
);

-- 套餐权益
CREATE TABLE mf_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  max_instances INTEGER NOT NULL,
  used_instances INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  order_id TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 实例
CREATE TABLE mf_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'prod',
  status TEXT NOT NULL DEFAULT 'creating',
  host TEXT,
  backend_port INTEGER,
  frontend_port INTEGER,
  service_name TEXT,
  workspace_path TEXT,
  console_url TEXT,
  console_token TEXT,
  console_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 部署记录（第一版可与 mf_instances 合并，稳定后拆分）
CREATE TABLE mf_deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  template_version TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 运行事件
CREATE TABLE mf_runtime_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

-- 管理员操作审计
CREATE TABLE mf_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
```

---

## 8. 控制台/API 代理方案

**访问路径：**
```
用户浏览器
  → https://mirofish.best/console/<instance_id>
  → Cloudflare Worker（校验 console_token，验证归属）
  → Cloudflare Tunnel → VPS frontend_port
  → MiroFish Vue 前端（内部再访问 backend:5001）
```

**Cloudflare Tunnel 方案（推荐）：**
- 在 VPS 上运行 `cloudflared` daemon
- 每个实例注册 tunnel route：`mf-<id>.internal.mirofish.best → localhost:<frontend_port>`
- Worker 验证 session 后 proxy 转发，用户不接触 VPS IP

**鉴权规则：**
- 用户登录后生成 `console_token`（JWT，有效期 8 小时）
- 每次访问 `/console/<instance_id>` 都校验 token 和实例归属
- token 过期后跳转重新登录，生成新 token 并更新 `console_token_expires_at`

**故障定位分层：**
```
控制台打不开 →
  1. instance.status != running → 实例未启动
  2. healthcheck.sh 失败 → 后端 /health 无响应
  3. smoke-test.sh 失败 → 前端端口不通
  4. Cloudflare Tunnel 失败 → cloudflared 未运行或 route 未注册
  5. Worker token 校验失败 → 登录过期
```

---

## 9. 密钥和上游 API 方案

**平台持有的真实密钥（存放在 Cloudflare 加密 secret / VPS 环境变量）：**
- `PLATFORM_LLM_API_KEY`：OpenAI 兼容 LLM API Key（如 Qwen-plus）
- `PLATFORM_ZEP_API_KEY`：Zep Cloud API Key

**实例 .env 注入：**
```bash
LLM_API_KEY=<PLATFORM_LLM_API_KEY>
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL_NAME=qwen-plus
ZEP_API_KEY=<PLATFORM_ZEP_API_KEY>
INSTANCE_TOKEN=<生成的实例唯一token>
```

**Zep Cloud 隔离：** 每个实例使用独立 collection（`mf-<instance_id>`），防止记忆跨实例泄露。

**后续升级路径：** 改为平台代理层，实例调 `https://api.mirofish.best/v1/chat`，平台持有真实 key 并统计用量。

---

## 10. 用户数据持久化方案

| 数据类型 | 目录 | 重启后 | 暂停后 | 删除后 |
|---------|------|--------|--------|--------|
| 上传文件/生成文件 | `data/` | 保留 | 保留 | 管理员确认后删除 |
| 智能体记忆 | `memory/` + Zep Cloud | 保留 | 保留 | Zep collection 同步清理 |
| 任务历史 | `tasks/` | 保留 | 保留 | 管理员确认后删除 |
| 实例日志 | `logs/` | 保留（追加） | 保留 | 可选保留 30 天 |
| 临时缓存 | `app/__pycache__/` | 重建 | 重建 | 直接删除 |

**删除实例流程：**
```
管理员确认删除 →
  docker-compose down
  rm -rf .../mf-<id>/app/
  （data/ tasks/ memory/ logs/ 保留 30 天后彻底清理）
  释放 backend_port / frontend_port
  删除 Cloudflare Tunnel route
  instance.status → deleted
  写 audit_log
```

---

## 11. 套餐权益映射

| 套餐 | 计费 | 模拟配额 | Agent 上限/次 | 种子格式 | API 访问 | 变量注入 | 优先处理 | 部署方式 |
|------|------|---------|-------------|---------|---------|---------|---------|---------|
| Starter | $9/mo 年付（$108/年） | 100次/月 | 50 | Text | ❌ | ❌ | ❌ | 托管共享 |
| Pro | $14.50/mo 年付（$174/年） | 500次/月 | 500 | PDF/MD/TXT | ✅ 完整 REST | ✅ | ❌ | 托管共享 |
| Enterprise | $59/mo 年付（$708/年） | 无限 | 无限 | 全部 | ✅ 完整 REST | ✅ | ✅ | 独立实例 / 私有云 |

**权益校验逻辑：**
- Starter / Pro：校验当月已用模拟次数 `entitlement.used_simulations < entitlement.max_simulations_per_month`，超出返回 429
- Enterprise：独立实例部署，无模拟次数限制，按实例数校验 `used_instances < max_instances`

**第一版简化：** Starter/Pro 共用同一个托管实例（通过 `user_id` 隔离数据），Enterprise 单独分配独立实例。

---

## 12. 管理员后台能力

| 能力 | API 路径 |
|------|---------|
| 查看所有用户 | `GET /admin/users` |
| 查看订单/权益 | `GET /admin/entitlements` |
| 查看所有实例 | `GET /admin/instances` |
| 查看单个实例详情 | `GET /admin/instances/:id` |
| 触发健康检查 | `POST /admin/instances/:id/health` |
| 查看最近日志 | `GET /admin/instances/:id/logs` |
| 重启实例 | `POST /admin/instances/:id/restart` |
| 暂停实例 | `POST /admin/instances/:id/pause` |
| 删除实例 | `DELETE /admin/instances/:id` |

---

## 13. 安全基线

- 用户只能访问 `instance.user_id == 当前登录user_id` 的实例
- `console_token` 有效期 8 小时，过期强制重新鉴权
- 平台真实 `LLM_API_KEY` / `ZEP_API_KEY` 不进 git、不进模板包
- 实例端口不对公网直接暴露，只通过 Cloudflare Tunnel 访问
- 管理员操作全部写 `mf_audit_logs`
- 删除用户数据需管理员二次确认

---

## 14. 运维基线

- 创建失败：自动清理容器、目录、端口，`deployment.error_message` 记录原因
- 实例可重启：`stop.sh` + `start.sh`，重启后 healthcheck 验证
- 实例可暂停：`docker-compose stop`，数据保留
- 实例可删除：`docker-compose down`，资源全部回收
- 日志：通过 `docker logs` 或 `logs/` 目录查看
- 基础备份：每日定时打包 `data/ memory/ tasks/` 到 `backups/<date>/`

---

## 15. 端到端验收清单

```
[ ] 用户访问 mirofish.best，完成 Creem 支付
[ ] Webhook 触发实例创建，instance.status → running
[ ] 用户登录后看到控制台入口链接
[ ] 点击入口，console_token 校验通过，MiroFish 前端加载成功
[ ] 上传种子文件，能触发多智能体模拟
[ ] 收到预测报告，能与 agent 对话
[ ] 重启实例后，上传的文件和任务历史仍存在
[ ] 超出套餐实例数额，创建被拦截
[ ] 管理员 API 能查看实例状态和日志
[ ] 管理员能触发重启，healthcheck 通过
[ ] 管理员删除实例后，docker 容器、目录、端口全部清理
[ ] 创建失败场景：目录已被清理，端口已释放，deployment.status = failed
```

---

## 16. 风险和待验证问题

| 风险 | 优先级 | 验证方式 |
|------|--------|---------|
| MiroFish 是否真正支持多实例并存 | **P0** | 本地启动两个 docker-compose，不同端口，验证互不干扰 |
| Zep Cloud 是否按 collection 隔离不同用户记忆 | **P0** | 查看 Zep API 文档，测试跨 collection 查询是否泄露 |
| AGPL-3.0 商业 SaaS 合规性 | **P1** | 确认在控制台提供原项目 GitHub 链接即满足合规 |
| VPS 单点故障（一台机器挂了所有实例不可访问） | **P1** | 第一版接受，后续做多节点 |
| Cloudflare Tunnel 稳定性（每实例一个 route） | **P1** | 测试 10 个以上 tunnel route 并发稳定性 |
| Python 多实例资源占用（每实例独立进程） | **P2** | 测试单机承载 10-20 实例的内存压力 |

---

## 17. 实施顺序

```
Week 1
  [ ] 1. 原项目轻改造：后端补 /health 端点
  [ ] 2. 验证多实例并存（不同端口的 docker-compose）
  [ ] 3. 验证 Zep Cloud collection 隔离
  [ ] 4. 产出模板包（含 start/stop/healthcheck/smoke-test 脚本）

Week 2
  [ ] 5. VPS 初始化：目录结构、端口规划、Cloudflare Tunnel 安装
  [ ] 6. D1 新建 mf_* 数据表
  [ ] 7. 实现 Runtime Server 管理 API（VPS 上的轻量 HTTP 服务）
  [ ] 8. 实现 Creem Webhook → 实例创建流程（Cloudflare Worker）

Week 3
  [ ] 9. 实现用户控制台入口页面（my_mirofish 现有站点新增页面）
  [ ] 10. 实现 console_token 鉴权 + Cloudflare Worker 代理
  [ ] 11. 实现套餐权益校验（创建时拦截超额）

Week 4
  [ ] 12. 管理员 API（查看/重启/暂停/删除）
  [ ] 13. 端到端验收清单逐项跑通
  [ ] 14. 基础备份 cron 脚本
  [ ] 15. 上线 prod，第一版交付
```

---

> **注意：现有 my_mirofish 的 Creem 支付代码（`functions/api/launch-checkout.js`）和所有页面内容不做任何修改，SaaS 化的新增功能全部以新增文件和新增 API 路由的方式接入。**
