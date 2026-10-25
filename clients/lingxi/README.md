# 灵矽终端客户端

可选的 Mac/Linux 手动语音入口，使用同仓库的 uv/Python 环境，通过 OTA 与 WebSocket 连接已绑定 Agent。普通桌面使用推荐 [小矽桌面窗口](../../docs/pet.md)，不需要安装本终端的音频依赖。

## 安装

需要 Node.js、pnpm、uv 和 libopus。Python 版本由 `.python-version` 指定，依赖由 `uv.lock` 锁定。

```bash
# macOS
brew install opus
pnpm voice:setup
pnpm voice:check
```

Linux 需安装 `libopus0`、`libportaudio2` 等系统音频依赖。`voice:check` 列出设备并检查编解码，不录音、不连接平台。

## 连接现有 Agent

```bash
pnpm voice:activate
```

未绑定时显示真实绑定码，在灵矽现有 Agent 中添加设备。已经绑定时无需再次添加。身份保存在 `.local/lingxi-device.json`，权限为 `0600`，不使用真实网卡 MAC，不应共享或提交。

Agent 的 MCP、模型工具能力和角色配置见 [灵矽接入](../../docs/linx-integration.md)。终端没有端侧工具，hello 中不声明端侧 MCP 支持；游戏工具来自 Agent 挂载的云端 MCP。

同一设备不能同时运行本终端和桌面窗口。

## 录音与播放

```bash
pnpm voice:start
```

- 按回车：停止当前播报并开始录音。
- 再按回车：停止录音，等待平台识别与回复。
- 输入 `q` 后回车，或按 `Ctrl+C`：退出。

建议戴耳机。启动不会自动录音，运行期间不保存录音。macOS 需给启动该命令的终端程序授予麦克风权限。

```bash
pnpm voice:start --input-device 1 --output-device 2
```

设备编号通过 `voice:check` 查看，连接或断开蓝牙设备后可能改变。

## 诊断

```bash
pnpm voice:probe     # 真实 WSS 握手，不录音或播放
pnpm voice:smoke     # 合成输入经 ASR/TTS，不使用物理麦克风或扬声器
pnpm voice:playtest  # 固定的同会话游戏流程
pnpm voice:test     # Python 单元与原生编解码检查
```

联网诊断会使用真实平台资源。报告保存在 `eval-results/`，收到题面或语音不能单独代替服务端工具执行记录。完整检查范围见 [维护指南](../../docs/maintenance.md)。

## 连接与数据

设备 token 每次通过可信 HTTPS OTA 获取，仅保留在内存中；WSS 使用系统证书校验。OTA 不下载或执行固件升级内容。

上行使用 16kHz 单声道 Opus，帧长 60ms；下行按握手格式解码。终端显示平台返回的识别与播报文字，不输出认证元数据。

断线后停止当前会话，重新运行命令会建立新的业务会话。此入口没有桌面服务的输入登记层，使用普通 MCP 原话参数，不能将两条入口的输入绑定保证混同。

## 文件

| 文件 | 职责 |
| --- | --- |
| `protocol.py` | 身份、OTA、握手与控制消息 |
| `codec.py` | libopus 编解码 |
| `client.py` | 音频设备、录音、播放和退出 |
| `diagnostics.py`、`playtest.py` | 联网检查与脱敏报告 |
| `tests/` | 协议、编解码和控制状态测试 |

实现依据为公开协议，未复制缺少明确授权的第三方示例源码。
