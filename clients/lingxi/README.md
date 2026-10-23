# 灵矽语音终端（Mac / Linux）

不需要专用硬件。用电脑麦克风和扬声器，通过灵矽官方 OTA + WebSocket v1 协议连接现有 Agent。

这不是浏览器 Speech API，也不是本地 ASR：语音 → 灵矽 ASR → Agent → 云端谜声 MCP → 灵矽 TTS → 本机扬声器。

## 一次性准备

需要 Python 3.9+、Node.js，以及 libopus。Mac 推荐 Homebrew：

```bash
cd linx-mystery
brew install opus
npm run voice:setup
npm run voice:check
```

音频依赖装进本仓库的 `.venv-lingxi/`，不修改系统 Python。macOS 的 sounddevice wheel 自带 PortAudio；Linux 需要另行安装 `libportaudio2`、`libopus0` 和 Python venv 支持。Linux 没有在本次交付实机验证。

`voice:check` 检查 Opus 并列出输入/输出设备，不开始录音，也不连接平台。

## 绑定现有 Agent

```bash
npm run voice:activate
```

首次生成本机随机虚拟设备 ID，通过 HTTPS OTA 获取绑定码。在 https://xrobo.qiniu.com/ 打开现有 Agent，添加设备，输入绑定码。

- 不需要提供账号密码、管理 API token 或修改源码。
- 虚拟设备身份保存在 `.local/lingxi-device.json`，权限 0600，已被 git 忽略；不要共享这个文件。
- 不读取真实网卡 MAC，不把本机序列号上传平台。
- 已绑定时显示成功；未绑定时打印绑定码并以状态码 2 退出，这是预期状态。
- 绑定码过期后重跑命令即可；不要删除身份文件，否则会生成另一个虚拟设备。
- OTA 不下载固件，不执行平台返回的升级 URL。

## Agent 上启用谜声

1. 给 Agent 绑定云端 MCP，传输协议选 **Streamable HTTP**、认证模式选 **Normal**，URL 为部署服务的 `/mcp`。不再支持旧 SSE。
2. 示例部署地址为 `https://placid.cyou/mcp`（依赖对应电脑、游戏服务及 frp 持续在线）。
3. 配置 `Authorization: Bearer <LINX_SERVICE_TOKEN>`；服务令牌在游戏服务 `.env`，不是设备 WebSocket token，两者不同。
4. 启用支持工具调用的意图识别模式（例如 Function Call），聊天模型需要支持工具调用，不能选择“无意图识别”。
5. 使用 [接入说明](../../docs/linx-integration.md) 中的 Agent 提示词，保存整页配置。
6. 能发现 `mystery_catalog`、`mystery_turn` 后开始体验。

终端不提供端侧工具，所以 hello 不声明端侧 MCP 支持。游戏工具由 Agent 配置的云端 MCP 提供。

## 不用麦克风的联调诊断

```bash
npm run voice:probe  # 只验证真实 WSS 握手，不采集/播放音频
npm run voice:smoke  # 用 macOS say 合成“开始游戏”，发送到灵矽并解码返回 TTS
```

`voice:smoke` 会访问真实平台、消耗少量语音资源；不打开麦克风、不播放扬声器。临时合成音频使用后自动清理，终端会显示识别及回复文字。

退出码：0 = ASR/TTS 完整且收到已知谜题题面；1 = 语音链路未完整通过；2 = 设备未绑定；3 = 语音通过但没有谜声题面，优先检查 Agent 的 MCP 绑定、Function Call 和提示词。收到题面只是回复内容检查，不能替代服务端工具调用记录。

## 语音试玩

```bash
npm run voice:start
```

- 按 **回车**：打断现有播报，打开麦克风，开始录音。
- 说“开始游戏”，再按 **回车**：停止录音，等待灵矽识别和回答。
- 下一句话仍按回车开始，再按回车结束。
- 输入 `q` 再回车，或按 `Ctrl+C`：退出。

默认手动半双工，不是免唤醒自由对话。建议戴耳机。启动时不会自动录音，只有手动开始后采集音频；运行期间不保存录音。平台和模型供应商的数据处理策略仍由各自配置决定。

首次录音时，macOS 如询问麦克风权限，请允许启动命令所在的 Terminal / iTerm / 编辑器。没有弹窗或失败时检查“系统设置 → 隐私与安全性 → 麦克风”。

指定音频设备（编号先通过 `voice:check` 查看，连接蓝牙设备后可能变化）：

```bash
npm run voice:start -- --input-device 1 --output-device 2
```

## 安全与恢复

- 每次启动重新获取设备 token，仅保留在内存中，不存盘、不打印。
- OTA 必须 HTTPS，且不跟随重定向；WebSocket 强制 WSS，使用系统证书校验。
- 官方 OTA 可能返回 `ws://` 地址；终端升级为同主机 `wss://`，不允许明文降级。不支持 TLS 的自定义服务会连接失败。
- 断线后停止会话，退出后重跑 `voice:start`。当前没有自动重连和跨 session 进度恢复。
- 设备身份和麦克风录音不会提交到 Git；模型/平台返回的 STT 和 TTS 文字会显示在当前终端。
- 如需自定义 OTA，可通过进程环境设置 `LINGXI_OTA_URL`，只接受 HTTPS，不要指向不可信服务。

## 实现与测试

代码从公开协议独立实现，没有复制官方示例仓库（该仓库读取时未附明确 LICENSE）的源码或固定设备标识。

- `protocol.py`：身份、OTA、WSS 配置、hello 和控制消息。
- `codec.py`：libopus ctypes 封装，16kHz 单声道 / 60ms 上行，按 hello 协商采样率解码下行。
- `client.py`：PortAudio 音频、手动录音、WebSocket、缓冲区和退出处理。
- `tests/`：协议、安全约束、原生编解码、麦克风控制状态机测试。

```bash
npm run voice:test
```

已在 Apple Silicon Mac 完成依赖安装、原生编解码、设备枚举、18 项测试、真实 OTA 绑定状态检查及已绑定设备的 WSS 握手。使用系统合成语音验证了真实灵矽 ASR 和 TTS 音频解码。Agent 配置完成后，合成语音已成功触发 mystery_turn 并返回《没有响的门铃》题面；服务端记录确认调用带有设备和会话标识。随后通过同一真实 WSS 会话完成六轮游戏：开局、两次提问、提示、85 分通关及换关，见 [实测记录](../../docs/playtest.md)。麦克风真实录音和扬声器实际播放仍需在交互式终端体验。

协议依据：
- https://linx.qiniu.com/docs/xrobot/platform/OTA
- https://linx.qiniu.com/docs/xrobot/platform/websocket
- https://linx.qiniu.com/docs/xrobot/guide/quick-start
