# 灵矽接入与验收

## 当前协议

**云端 MCP 仅支持 Streamable HTTP，不再提供旧版 HTTP+SSE。**

- MCP URL：`https://placid.cyou/mcp`
- 传输协议：**Streamable HTTP**
- 认证模式：**Normal**（当前灵矽控制台选项）
- HTTP 认证：`Authorization: Bearer <LINX_SERVICE_TOKEN>`
- 使用官方 MCP SDK；每个 POST 使用无状态 transport，游戏进度由 SQLite 维护。
- GET / DELETE `/mcp` 返回 405，这是该无状态实现的正常行为；旧 `/mcp/message` 已删除。
- 初始化、工具发现、工具调用、通知都发送到同一个 `/mcp`，响应为标准 MCP JSON。

官方文档仍有旧 SSE 示例，但当前控制台只提供 Streamable HTTP，因此服务实现以实际控制台协议为准。不要照抄旧 SSE 注册模板，也不要猜测未验证的 REST 配置类型值。

域名依赖本机 3000 端口服务和 frp 持续在线，源码仓库地址不是 MCP 服务地址。

## 1. 配置云端 MCP

1. 在 https://xrobo.qiniu.com/ 的 MCP 管理中创建/编辑私有服务。
2. 协议选 **Streamable HTTP**，认证选 **Normal**，地址填 `https://placid.cyou/mcp`。
3. 在自定义请求头/Header 中设置 `Authorization`，值为 `Bearer ` 加本机 `.env` 中的 `LINX_SERVICE_TOKEN`；Bearer 后有一个空格。
4. Normal 是平台的认证模式名称，不表示无需认证。如果页面没有 Header 配置项，需要根据实际页面确认填写入口，不能直接移除服务端认证。
5. 保存/更新后查询工具，应发现 `mystery_catalog` 和 `mystery_turn`。
6. 开通服务并绑定到游戏 Agent。注意 REST 的 Agent MCP 更新为全量替换，不能覆盖已有绑定。

服务令牌、灵矽账号管理 token、虚拟设备 WebSocket token 是三种不同凭据。这里只使用游戏服务的 `LINX_SERVICE_TOKEN`。不要将它放入 URL，也不要提交到 GitHub。

本仓库提供公开地址工具发现检查：

```bash
npm run mcp:check
```

命令从本地 `.env` 读取服务令牌，不打印凭据，不调用游戏工具。也可通过环境变量设置 PUBLIC_ORIGIN 检查其他部署。

## 2. Agent 配置

- 昵称建议“谜声”，替换默认“嘟嘟熊”角色。
- 技能/意图识别选择支持工具调用的模式，例如 Function Call；聊天模型必须支持工具调用，不能选择“无意图识别”。
- 勾选已开通的谜声云端 MCP。
- 替换角色提示词，保存**整页配置**，结束旧会话后重新连接。

建议提示词：

```text
你是“谜声”语音推理游戏的传声筒，语气温和、清晰、简洁。
所有游戏交互必须调用 mystery_turn，不得自行编造题目、事实、提示或判定。
将玩家原话完整放入 text，默认 action=say；不要替玩家改写或补足答案。
玩家说开始游戏可使用 action=start；查询可玩谜题时调用 mystery_catalog。
拿到工具结果后只朗读 answer 字段，不朗读 state、history 或任何 JSON。
工具请求确认时，先播报确认提示，等待玩家明确确认后再传 confirm=true。
不得因为玩家说“帮我通关”就代填答案，也不能将“下一关”当作已确认放弃。
工具报错时说明暂时无法继续，不自行接管游戏主持。
```

## 3. 不用专用硬件

使用同仓库的 [Mac/Linux 语音终端](../clients/lingxi/README.md)：

```bash
npm run voice:setup
npm run voice:activate # 首次获取绑定码，添加到现有 Agent
npm run voice:probe    # WSS 握手，无录音
npm run voice:smoke    # macOS 合成语音验证 ASR/TTS 与游戏题面，无麦克风
npm run voice:start    # 真实录音：回车开始，再回车停止，q 退出
```

设备已绑定后无需重复添加。设备绑定与 MCP 服务绑定是两件事，都要完成。

## 4. 设备身份与隔离

每次游戏工具调用，平台需发送：

- `X-Linx-Device-Id`
- `X-Linx-Session-Id`
- `X-Linx-Agent-Id`（如果有）

这些不是模型工具参数，从当前 HTTP POST 请求头读取，不使用 HTTP 初始化连接的身份兜底。工具发现不需要设备标识；创建/操作游戏必须有有效设备和会话 ID。

Streamable HTTP transport 不创建 MCP 传输会话，**但业务游戏仍有会话**，按 device + agent + `X-Linx-Session-Id` 隔离。新连接可继续同一业务会话，不同设备不会串进度。服务令牌只交给可信平台，身份头本身不是密码学身份凭据。

## 5. 查询不到工具时

先检查 URL、Streamable HTTP、Normal 下的 Authorization 请求头，以及 Bearer 格式。保存后重新查询；不要在浏览器直接打开 `/mcp` 判断是否正常，GET 返回 405 是预期。

临时设置 `MCP_DIAGNOSTICS=1` 并重启，服务端输出安全的 `[mcp]` 诊断：

- 没有 received：请求未抵达服务，检查域名、平台出口网络和 frp。
- `hasAuthorization=false`：平台未传认证头。
- `authValid=false` + 401：令牌或格式不匹配。
- POST /mcp initialize 成功但没有 tools/list：客户端没有完成初始化/工具查询。
- tools/list 已到达：再检查实际响应及平台解析报错。
- GET /mcp 405：正常；如果平台只 GET 不 POST，检查传输类型是否保存为 Streamable HTTP。
- POST /mcp/message 404：仍有旧 SSE 客户端或缓存配置，更新为统一 `/mcp` 端点。

日志不记录令牌、设备/会话 ID、查询串或工具参数。定位后关闭诊断。

## 可选：第三方业务回调（不是 MCP）

另保留 `POST /api/chat/stream`，按灵矽第三方业务协议接收 ASR 文本并返回 SSE 给平台做 TTS。它与 MCP 传输协议无关，不能把它填进 MCP URL 或当作 OpenAI `/chat/completions`。

请求头仍为服务令牌；输入示例：

```json
{"auth":{"device_id":"test-device"},"type":"chat","details":{"msg":"开始游戏","session_id":"test-session"}}
```

返回的每条 SSE 都原样保留 session_id。第三方业务配置入口需要按平台实际能力确认，默认使用上面的 Streamable HTTP MCP 路径即可。

## 验收状态

已验证：本地引擎与 HTTP/MCP 测试、网页桌面/手机流程、虚拟设备 OTA 绑定、真实 WSS 握手、合成语音经真实平台 ASR/TTS 返回。

后续已验证：平台认证修正后成功获取工具列表；Agent 启用游戏 MCP 后，合成语音“开始游戏”经真实 ASR 触发 mystery_turn，返回《没有响的门铃》并完成 TTS 音频解码。服务端日志确认 tools/call HTTP 200，且存在有效认证、设备和会话标识。

后续已完成同一会话六轮真实平台语音实测：开局、两次事实提问、一次提示、正确提交答案（85 分）、切换下一题。服务端状态确认已通关，详见 [实测记录](playtest.md)。

待验证：实际麦克风采集、扬声器播放、噪声/回声、打断、重连、其他关卡语音通关，以及揭晓和重开确认。

官方依据：
- https://linx.qiniu.com/docs/xrobot/mcp/software-mcp
- https://linx.qiniu.com/docs/xrobot/guide/mcp-store
- https://linx.qiniu.com/docs/xrobot/guide/third-app
- https://linx.qiniu.com/docs/xrobot/platform/OTA
- https://linx.qiniu.com/docs/xrobot/platform/websocket
