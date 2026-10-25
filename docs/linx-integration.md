# 灵矽接入

## 连接游戏 MCP

1. 为游戏引擎配置稳定的公开 HTTPS 地址。
2. 在灵矽 MCP 管理中创建服务，传输选 **Streamable HTTP**。
3. 认证模式选 **Normal**，服务地址填 `https://your-game.example/mcp`。
4. 添加请求头 `Authorization: Bearer <LINX_SERVICE_TOKEN>`，与服务端 `.env` 一致。
5. 保存并查询工具，将服务绑定到游戏 Agent。

Normal 是平台的认证模式名称，不表示无需认证。不要把令牌放入 URL，也不要用管理 token、设备 token 或独立模型密钥替代服务令牌。

所有 MCP 请求使用同一个 `POST /mcp`。GET 和 DELETE 返回 405；不提供旧版 HTTP+SSE 端点。

```bash
pnpm mcp:check
```

此命令检查初始化与工具发现，不执行游戏。公开地址默认取 `PUBLIC_ORIGIN`，未设置时使用本机游戏端口。

## 配置 Agent

服务端配置：

```ini
LINX_AGENT_HOST_ENABLED=1
AI_HOST_ENABLED=0
```

Agent 需要：

- 支持真实工具调用的语言模型及相应意图识别模式。
- 已启用并绑定的游戏 MCP。
- [完整角色提示词](agent-host-prompt.txt)。

应能发现三个工具：

| 工具 | 职责 |
| --- | --- |
| `mystery_catalog` | 只读题库目录，不创建游戏 |
| `mystery_turn` | 当前输入与游戏控制入口 |
| `mystery_commit` | 提交结构化语义判断 |

角色提示词负责引导工具调用，不赋予模型修改分数或伪造通关的权限。当 `requiresJudgment=true` 时，必须继续调用 `mystery_commit`，不能把空 answer、内部上下文或工具代码当成回复。

保存配置后结束旧语音会话，再重新唤醒。模型名称和高级参数以平台实际接入为准；没有明确需要时，不同时修改多个参数。

语音与模型调用使用灵矽账户资源，费用以平台配置为准；复用 Agent 不代表调用免费。

## 绑定桌面设备

```bash
pnpm pet
```

首次唤醒时，窗口会显示真实绑定码。在现有 Agent 中添加设备，填入绑定码，然后重新唤醒。

- 已绑定的身份位于 `.local/lingxi-device.json`，无需再次创建。
- 不要删除身份文件或把它提交到仓库。
- 绑定码过期时重新获取即可，不需要更换设备身份。
- MCP 服务绑定和设备绑定是两项独立配置。
- 同一设备不要同时由多个桌面窗口或终端使用。

桌面服务只在 `127.0.0.1:3212` 监听，不对公网开放。对外暴露的是游戏 MCP，不是麦克风代理。

## 请求身份

平台在每次游戏调用中传入：

```text
X-Linx-Device-Id
X-Linx-Session-Id
X-Linx-Agent-Id  # 平台提供时使用
```

身份来自当前 HTTP 请求头，不来自模型工具参数。工具发现不要求设备身份；创建或修改游戏需要有效的设备和业务会话。

在同一业务会话内，SQLite 保留进度；新的平台会话具有独立的玩家状态，不自动恢复已断开的语音局。

## 辅助接入

[终端客户端](../clients/lingxi/README.md) 支持 Mac/Linux 的手动录音与协议检查。它与桌面入口沿用同一绑定身份，但不要同时运行。

另提供认证的 `POST /api/chat/stream` 第三方业务回调，接收文本并以 SSE 返回 answer。它不是 MCP，也不是 OpenAI `/chat/completions` 端点；使用前应按平台的业务回调能力配置，并关闭代理缓冲。

## 协议参考

- [云端 MCP](https://linx.qiniu.com/docs/xrobot/mcp/software-mcp)
- [MCP 管理](https://linx.qiniu.com/docs/xrobot/guide/mcp-store)
- [第三方业务](https://linx.qiniu.com/docs/xrobot/guide/third-app)
- [OTA](https://linx.qiniu.com/docs/xrobot/platform/OTA)
- [WebSocket](https://linx.qiniu.com/docs/xrobot/platform/websocket)

运行诊断见 [维护指南](maintenance.md)，组件与权限边界见 [系统设计](architecture.md)。
