# 谜声 · MISHENG

面向灵矽的轻量语音情境推理游戏。听题、提问、提示、提交答案、结算、下一关，不需要凑齐真人，也不是跑团。

## 快速试玩

推荐 Node.js 24+（最低 22.13）。

```bash
npm ci
npm start
# http://localhost:3210
```

无需灵矽账号或模型密钥即可体验规则版。选择谜题后可点击示例问题或输入文字；说/输入“我的答案是……”提交。支持“开始游戏”“给我提示”“重听题目”“揭晓答案”“确认揭晓”“下一关”“确认重开”。

网页的麦克风与朗读使用浏览器 Speech API，不是灵矽语音链路。语音识别结果先填入输入框，检查后发送，避免误识别直接触发操作。Chrome 通常需要麦克风授权、可用的浏览器语音服务及 localhost / HTTPS；不支持时可用文字。浏览器语音服务可能将音频发送到浏览器厂商，请勿输入敏感信息。

## 不需要专用硬件：用 Mac 连接灵矽

仓库内已包含独立语音终端，与游戏服务同一仓库，无需克隆其他客户端：

```bash
brew install opus
npm run voice:setup
npm run voice:check       # 设备枚举与编解码自检，不录音
npm run voice:activate    # 获取绑定码，在现有 Agent 中添加设备
npm run voice:probe       # 验证真实 WSS 握手
npm run voice:smoke       # 合成语音检查平台 ASR/TTS 和游戏题面，不录音
npm run voice:start      # 回车开始录音，再次回车结束；q 退出
```

需要 Python 3.9+。客户端通过灵矽 HTTPS OTA 获取绑定码和设备令牌，以 WSS 连接平台，录音、播报使用本机音频；不是浏览器语音。Agent 仍需绑定游戏云端 MCP。详见 [语音终端说明](clients/lingxi/README.md)。

本机安装、Opus 自检、设备枚举、OTA、绑定后 WSS 及合成语音 ASR/TTS 已验证。目前 Agent 仍回复默认角色，待配置游戏 MCP；真实麦克风录音和扬声器播放待体验。

## 当前交付

- 5 道谜题，桌面及手机布局。
- 固定真相、审核事实库、三级提示、通关/揭晓结算、下一关。
- 100 分起算；每个提示扣 15 分，超过 5 次的每次提问扣 2 分，首次之后每次提交答案扣 5 分，最低 0 分。揭晓不计分。
- SQLite 持久化，网页按 HttpOnly cookie 隔离，灵矽按设备/智能体/会话隔离。
- 第三方业务 `POST /api/chat/stream`，返回文档规定的 SSE。
- 云端 MCP `GET /mcp` + `POST /mcp/message`，使用官方 SDK，兼容灵矽文档要求的旧版 HTTP+SSE。
- 可选 OpenAI-compatible 语义路由。模型只选事实编号，播报由服务端固定文本生成，异常自动退回规则。

## 玩法边界

这是可玩的首版，不是任意问题都能理解的开放推理主持人。

1. **未配置模型时是关键词规则模式**，提问优先使用示例措辞；每次只问一个事实。没有匹配时明确说明不能可靠判断，不假装理解。
2. 回复采用“可以确认：固定事实”，而非承诺始终精确回答“是/否/无关”。某些问题会连带揭示一个相关事实。
3. **判题仍是关键概念匹配**，支持有限同义表达，不理解任意复杂推理。含否定的答案保守不通过；请以明确肯定句提交。这不能防止关键词堆砌作弊，正式比赛需要升级语义判题和人工评估。
4. 可选模型服务尚未使用真实供应商凭据验证。语义误路由仍可能选错事实，但不能生成新的事实或更改通关状态。
5. 已通过 frp 验证 `https://placid.cyou` 的公网网页与 MCP 接入，并提供本机语音终端；已验证合成语音经真实灵矽 ASR/TTS 返回，但仍未完成 Agent 游戏配置及实际麦克风/扬声器体验。不包含嵌入式固件或内置 ASR / TTS。
6. 进度按会话隔离，灵矽新建 session 后不会继承上一个 session 的进度。网页清理 cookie 后无法恢复旧进度。

## 灵矽接入

见 [接入说明](docs/linx-integration.md)。两种方式任选一种；推荐先走第三方业务模式，避免模型决定是否调用游戏工具。

```bash
cp .env.example .env
# 编辑 .env，设置 LINX_SERVICE_TOKEN；本地模型增强为可选项
npm start
```

所有密钥留在服务端 `.env` 或部署环境，不进入网页，也不写入源码。服务令牌是平台回调凭据，不是终端玩家需要填写的密钥。

## 测试

```bash
npm test          # 16 项引擎与 HTTP/MCP 集成测试
npm run test:e2e  # Chrome：桌面 + 手机两个完整流程
npm run voice:test # 18 项语音终端测试（原生 Opus 测试缺少库时跳过）
```

E2E 默认使用已安装的 Chrome。测试覆盖：开局、提问、提示、判题、换关、刷新恢复、揭晓二次确认、设备隔离、身份缺失拒绝、SSE session_id、官方 MCP 客户端工具发现/调用、跨站请求、认证和超限消息体。**不覆盖实际麦克风采集、浏览器厂商语音服务、灵矽 ASR/TTS 和真机。**

## 部署

```bash
docker build -t linx-mystery .
docker run --rm -p 127.0.0.1:3210:3210 --env-file .env \
  -e HOST=0.0.0.0 -e DB_PATH=/app/data/games.sqlite \
  -v misheng-data:/app/data linx-mystery
```

Docker 构建及镜像运行尚未实测。对外使用反向代理提供 HTTPS，设置 `PUBLIC_ORIGIN=https://你的域名`，对 SSE 关闭缓冲、延长读取超时。不直接暴露未加 TLS 的 Node 端口。服务默认只监听本机。

初版仅适合单实例小规模试用。限流按直连 IP 统计，反向代理后会聚合为代理 IP；正式上线需配置可信代理、网关级限流、用户认证、数据保留/清理策略、监控及备份。SQLite 不支持多个应用副本共享写入。数据文件含提问文本和进度，不保存音频。

## 文件结构

```text
src/cases.js             服务端谜题、事实、提示与判题概念
src/engine.js            状态机、持久化、可选语义路由
src/server.js            网页 API、业务 SSE、MCP、认证
public/                 无构建步骤的网页试玩
clients/lingxi/          同仓库的 Mac/Linux 语音终端
scripts/voice.mjs        终端依赖安装、绑定、自检与启动入口
test/                   引擎与接口测试
e2e/                    桌面/手机浏览器流程
docs/                   接入与验收报告
```
