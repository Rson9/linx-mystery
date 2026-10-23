# 灵矽接入与真机验收

## 官方依据

- [第三方业务系统接入](https://linx.qiniu.com/docs/xrobot/guide/third-app)
- [云端 MCP](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)
- [MCP 服务与 Agent 绑定](https://linx.qiniu.com/docs/xrobot/guide/mcp-store)
- [客户端 demo](https://linx.qiniu.com/docs/xrobot/guide/client-demo)
- [自定义 LLM 配置](https://linx.qiniu.com/docs/xrobot/api/llm)

实现参考官方文档仓库 `qiniu/Xrobot-docs`，读取时 HEAD 为 `20ce1b29a1bdff575a4c3317689bae30a7e08535`。文档及平台实现可能变化；以下接口已用本地模拟请求验证，但不表示已完成平台实测。

## 前置条件

1. 可用的灵矽账号、Agent、已绑定并联网的设备；也可使用官方 Linux/macOS 音频客户端。
2. 可被灵矽平台访问的 HTTPS 地址。不能填写 localhost。
3. 设置服务端 `LINX_SERVICE_TOKEN`，在平台侧配置相同的 `Authorization: Bearer ...`。使用高强度随机值，不要提交到仓库。
4. 对外部署设置 `PUBLIC_ORIGIN`，反向代理禁止缓存和缓冲 SSE。

本次没有创建/修改平台资源，也没有读取任何本机平台凭据。

## 方式 A：第三方业务模式（推荐先验证）

链路：设备语音 → 灵矽 ASR → 本服务 → 固定事实/判题 → 灵矽 TTS → 设备。

- 回调：`POST https://你的域名/api/chat/stream`
- 请求头：`Authorization: Bearer <服务令牌>`、`Content-Type: application/json`
- 输入格式：

```json
{
  "auth": { "device_id": "device001" },
  "type": "chat",
  "details": { "msg": "开始游戏", "session_id": "session001" }
}
```

返回 `text/event-stream`：

```text
data: {"event":"message","type":"chat","session_id":"session001","details":{"answer":"欢迎来到谜声……"}}

data: {"event":"message_end","session_id":"session001"}

```

所有 SSE 消息原样返回 session_id。不指定 TTS 供应商和音色，由平台 Agent 配置决定。暂不支持 report/get/reset 透传操作。

平台文档描述了业务回调协议，但未充分给出当前控制台配置入口或可直接执行的完整注册 payload。需要在控制台/平台侧确认**第三方业务服务**的启用方式；不要把这个端点直接当成 OpenAI `/chat/completions`，两者协议不同。如果该入口暂不可用，使用下面的 MCP 方式。

本地协议检查（先在环境中设置测试用服务令牌并启动服务）：

```bash
curl -N http://localhost:3210/api/chat/stream \
  -H "Authorization: Bearer $LINX_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"auth":{"device_id":"test-device"},"type":"chat","details":{"msg":"开始游戏","session_id":"test-session"}}'
```

`.env` 不会自动导出到当前 shell；运行 curl 前需在 shell 中设置同一个令牌。

## 方式 B：云端 MCP

### 服务配置

- SSE URL：`https://你的域名/mcp`
- 消息端点：`POST /mcp/message?sessionId=...`（由 SSE endpoint 事件协商，不能手填自定义地址）
- SSE GET 和后续 POST 都需要服务令牌。
- 不把 `api_key` 放进 URL，避免被访问日志记录。

在灵矽 MCP 管理创建私有服务，开通后勾选绑定到游戏 Agent。控制台如要求配置模板，可使用如下结构，替换域名和令牌：

```json
{
  "types": ["sse"],
  "sse": {
    "type": 0,
    "url": "https://你的域名/mcp",
    "shared_key": false,
    "params": {},
    "header": { "Authorization": "Bearer <服务令牌>" }
  }
}
```

平台 REST 注册接口见官方文档。Agent 的 MCP 更新接口是**全量替换**，不能直接覆盖已有绑定。首版不提供自动注册脚本，以免误改现有 Agent。

### 设备标识

游戏调用需要平台传入：

- `X-Linx-Device-Id`
- `X-Linx-Session-Id`
- `X-Linx-Agent-Id`（如果有）

这些不是模型工具参数。优先读取工具调用 POST 的请求头，必要时使用 SSE 握手时的同名请求头。握手已有身份时，拒绝后续身份变化；没有身份时仍可发现工具，但不能创建游戏。服务令牌只应交给可信平台，不能发给终端玩家；设备请求头本身不是密码学身份凭据。

MCP 游戏进度按 device + agent + session 隔离。第三方业务模式没有 agent 维度，因此两种模式不会共享游戏进度。

### Agent 提示词

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

模型不一定严格遵循提示词，需要真机验收工具调用率和逐字播报行为。若模型跳过工具，优先使用方式 A。

## 真机验收清单（尚未执行）

- [ ] “开始游戏”能听到第一道题的完整题面。
- [ ] “房主听力正常吗”收到固定事实回复，不生成额外背景。
- [ ] “给我提示”逐次播报不同提示，第四次不增加计数。
- [ ] “我的答案是房主听不见，门铃用闪光灯提醒”正确结算。
- [ ] “下一关”切换第二题；未结束时要求确认。
- [ ] “揭晓答案”先确认，“确认揭晓”后才结束。
- [ ] 两台设备、两个 session 不串进度。
- [ ] 断线重连后，同一 session 能继续；新 session 按设计重新开局。
- [ ] 验证 TTS 开始延迟、长题面播报、打断、噪声误识别、超时恢复。
- [ ] 如果启用语义路由，验证供应商响应格式与 8 秒超时降级。

## 后续两天建议

1. 第 2 天：接平台账号和一个真实设备，完成上述清单；根据实际 ASR 扩展同义表达，测量端到端延迟。
2. 第 3 天：补充高质量原创关卡、校正判题误判、长时间连续试玩、部署监控及数据清理；只有通过真机验收后才标记为灵矽成品。
