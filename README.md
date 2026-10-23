# 谜声 · MISHENG

面向灵矽的语音情境推理游戏。听题、提问、获得提示、提交推理、结算和下一关；单人可玩，多人可围坐参与，不是跑团。

**当前公开试玩仍是规则模式。** 已通过真实灵矽六轮语音游戏实测；新的 AI 主持与语义判题已接入代码，但未配置真实模型、未通过质量评测，不能视作已经完成自由问答。

- [竞赛版优先级与验收标准](docs/competition-roadmap.md)
- [灵矽接入](docs/linx-integration.md)
- [六轮真实平台实测](docs/playtest.md)
- [Mac/Linux 语音终端](clients/lingxi/README.md)

## 环境与启动

Node.js 推荐 24+（最低 22.13），**pnpm 12.0.0**；Python 由 **uv** 管理，`.python-version` 选择 3.12，依赖锁在 `uv.lock`。

```bash
pnpm install --frozen-lockfile
pnpm start
# http://localhost:3210；以 .env 的 PORT 为准
```

只有一份 Node 锁文件 `pnpm-lock.yaml`，不混用 npm/yarn。Python 使用 `pyproject.toml` + `uv.lock`，不手动 pip 安装。

本地不填密钥即可体验 5 道规则关卡。题面不等于谜底，未结束的公共 API 不下发真相和评分规准。网页麦克风与朗读为浏览器 Speech API，**不经过灵矽**；识别结果先填入输入框，检查后发送。浏览器厂商可能处理音频，请勿输入敏感内容。

## 不用专用硬件：Mac 连接真实灵矽

```bash
brew install opus
pnpm voice:setup      # uv sync --locked；依赖放在 .venv，不改系统 Python
pnpm voice:check      # 原生 Opus 和音频设备自检，不录音
pnpm voice:activate   # 获取绑定码，添加到现有 Agent
pnpm voice:probe      # 真实 WSS 握手，不录音
pnpm voice:smoke      # 合成“开始游戏”检查 ASR/TTS，不打开麦克风
pnpm voice:start      # 回车开始录音，再次回车结束；q 退出
```

状态文件 `.local/lingxi-device.json` 权限 0600，设备 token 只在内存中。Agent 需要配置游戏 MCP、支持工具调用的模型和角色提示词。详见终端文档。已完成的六轮实测使用合成语音，不代表实际麦克风、扬声器、噪声、打断和重连均已验收。

## MCP

仅支持 **Streamable HTTP `POST /mcp`**，Normal 认证模式下配置：

```text
Authorization: Bearer <LINX_SERVICE_TOKEN>
```

工具：`mystery_catalog`、`mystery_turn`。GET/DELETE `/mcp` 返回 405，旧 SSE 端点已删除。每次游戏调用需要平台自动传入设备/会话标识；查询工具不需要设备身份。

部署实例 `https://placid.cyou/mcp` 依赖本机 3000 端口服务和 frp 持续在线。GitHub 仓库地址不是服务 URL。

```bash
cp .env.example .env  # 已有 .env 时不要覆盖
# 配置 LINX_SERVICE_TOKEN、PUBLIC_ORIGIN 后启动服务
pnpm mcp:check
```

服务令牌、灵矽管理账号 token、设备 token、模型 key 各自独立，不能互换。密钥只保存在服务端 `.env` 或部署环境。

## AI 主持（P0，尚待真实模型评测）

在 `.env` 配置 OpenAI-compatible 服务的 `LLM_BASE_URL`（/v1 地址）、`LLM_API_KEY`、`LLM_MODEL`，先保持 `AI_HOST_ENABLED=0`：

```bash
pnpm eval:host
# 配置缺失退出 2，表示没有执行模型质量评测，而不是通过
```

开发评测集覆盖 5 关、未知细节、否定、多问题、注入、错误因果和堆词判题。目标总体 ≥95%，安全样本 100%；开发集通过还需独立盲测，报告存入忽略的 `eval-results/`。门槛和排期见竞赛路线图。

准备好后再设 `AI_HOST_ENABLED=1` 并重启：

- 读取固定真相，只输出是/否/无关/无法确定/澄清/拒答，不扩展整条事实。
- 是/否需要合法内部证据，证据不发给玩家；合法证据 ID 不等于语义正确，仍需真实评测。
- 按独立因果规准和玩家原文引文判题；状态机决定通关，模型不能直接修改状态。
- 模型异常/超时/无效输出，不退回会剧透的关键词答案，不扣提问或提交次数。
- 未记载细节、澄清和安全拒答不扣提问次数。
- AI 不可用时提示、重听等确定性操作仍可用。

不开启 AI 时仍是旧规则演示：只做有限关键词匹配，可能连带泄露关键事实；判题可能误拒复杂正确表达或被堆词绕过，不适合竞技。新模型测试中的 mock 只验证程序约束，不证明真实模型的理解/抗注入能力。

## 测试

```bash
pnpm test          # 引擎、主持结构校验、HTTP/MCP 集成
pnpm test:e2e      # 已安装 Chrome 的桌面/手机完整流程
pnpm voice:test    # uv 下的 Python 测试，含本机 libopus 编解码
pnpm eval:host     # 配置真实模型后运行，可能产生 API 费用
```

依赖锁文件可复现安装。缺少 libopus 时 Python 原生编解码测试会跳过，不等于本机音频已通过。真实平台语音诊断会消耗少量平台资源。

## 部署与边界

```bash
docker build -t linx-mystery .
docker run --rm -p 127.0.0.1:3210:3210 --env-file .env \
  -e HOST=0.0.0.0 -e DB_PATH=/app/data/games.sqlite \
  -v misheng-data:/app/data linx-mystery
```

Dockerfile 使用 pnpm frozen lockfile，镜像构建/运行尚未实测。对外由反向代理提供 HTTPS，设置准确的 `PUBLIC_ORIGIN`。服务默认只监听本机，平台端点未设置令牌时关闭。

另保留非 MCP 的第三方业务 `POST /api/chat/stream` SSE 回调，使用时需关闭代理缓冲。不能把它当作 MCP URL 或 OpenAI API。

初版为单实例小流量：SQLite 持久化，基础直连 IP 限流；仍需正式部署保活、可信代理、数据清理、备份和监控。清理网页 cookie 后无法恢复原进度。数据库含文字和进度，不保存录音。

## 代码

```text
src/cases.js          固定谜题、审核事实、提示和评分规准（服务端）
src/host.js           AI 裁判、输出与引用校验
src/engine.js         状态、计分、持久化、规则与 AI 模式
src/server.js         网页 API、Streamable HTTP MCP、认证
public/               无构建步骤的网页试玩
clients/lingxi/       同仓库 Python 音频终端
scripts/              uv 启动器、MCP 检查、模型评测
eval/                 人工标注的开发评测集（不是独立盲测）
test/、e2e/           程序与网页回归
docs/                 接入、实测、竞赛路线图
```
