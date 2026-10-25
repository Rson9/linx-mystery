# 部署配置

## 组件与端口

| 组件 | 默认地址 | 职责 |
| --- | --- | --- |
| 游戏引擎 | `127.0.0.1:3210` | 题库、状态、计分、HTTP API、MCP |
| 桌面终端 | `127.0.0.1:3212` | 桌面界面、设备接入、PCM 音频桥 |
| 灵矽 Agent | 平台托管 | 语音识别、工具调用、语义判断和语音合成 |

仅游戏引擎的 HTTPS 入口需要供灵矽访问。桌面终端必须保持本机监听，不能把 `3212` 加入公网反向代理。

## 环境要求

- Node.js 24+（最低 22.13），pnpm 12。
- Google Chrome；macOS 支持自动打开独立窗口。
- 已配置的灵矽账户与支持工具调用的 Agent。
- 可供平台访问的游戏引擎 HTTPS 地址。

桌面应用不需要 Python、PortAudio 或 libopus。只有使用可选终端时才需要 [uv 与音频依赖](../clients/lingxi/README.md)。

## 首次安装

```bash
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

已有 `.env` 时不要覆盖。将生成的随机值保存在 `LINX_SERVICE_TOKEN`，再配置公开地址：

```ini
HOST=127.0.0.1
PORT=3210
PET_PORT=3212
PUBLIC_ORIGIN=https://your-game.example
LINX_SERVICE_TOKEN=<随机服务令牌>
LINX_AGENT_HOST_ENABLED=1
AI_HOST_ENABLED=0
```

通过反向代理将公开 HTTPS 域名转发到游戏引擎端口。`PUBLIC_ORIGIN` 必须与浏览器访问的公开 origin 一致，不带末尾斜杠。`HOST=127.0.0.1` 适用于同机代理；使用容器时按下方配置监听容器网络。

按照 [灵矽接入](linx-integration.md) 绑定 MCP 与设备，再启动：

```bash
pnpm pet
```

首次唤醒会获取真实设备绑定码。在现有 Agent 中添加该设备后重新唤醒。已经绑定的设备会沿用 `.local/lingxi-device.json`，不要删除或共享此文件。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 游戏引擎监听地址 |
| `PORT` | `3210` | 游戏引擎端口 |
| `PET_PORT` | `3212` | 本机桌面终端端口 |
| `PUBLIC_ORIGIN` | 本机请求 origin | 公开网页的准确 HTTPS origin |
| `LINX_SERVICE_TOKEN` | 空 | 平台 API 与 MCP 认证令牌；缺失时平台接口关闭 |
| `LINX_AGENT_HOST_ENABLED` | 见 `.env.example` | 启用复用 Agent 的两阶段裁判 |
| `AI_HOST_ENABLED` | `0` | 网页及业务回调的可选独立模型裁判 |
| `DB_PATH` | `data/games.sqlite` | 游戏数据库路径 |
| `PET_GAME_ORIGIN` | 本机 `PORT` 地址 | 桌面终端读取的可信游戏服务 |
| `MCP_DIAGNOSTICS` | `0` | 输出有限的安全诊断事件 |
| `LINGXI_OTA_URL` | 官方 HTTPS 服务 | 自定义设备服务地址，仅接受可信 HTTPS |

独立模型适配通过 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 和可选 `LLM_REASONING_EFFORT` 配置。它不是桌面主路径的必需项，使用前应单独验证供应商格式与时延。不要把灵矽管理 token、设备 token 或 MCP 令牌当作独立模型密钥。

## 运行与升级

```bash
pnpm pet --no-open  # 仅启动服务
pnpm pet:open      # 打开已有桌面服务
pnpm start         # 单独启动游戏引擎
```

启动器会复用已经在线的引擎，不会在关闭桌面服务时接管或停止外部管理的引擎。

升级时先停止旧进程，再更新源码并安装锁定依赖：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm check
pnpm pet
```

单独运行的引擎也要重启以加载新代码。保留 `.env`、`.local/lingxi-device.json` 和数据库；不要为升级重新创建设备身份。

## 数据与备份

- `data/games.sqlite`：进度、文字记录和计分，不保存录音。
- `.local/lingxi-device.json`：绑定身份，权限应为 `0600`。
- `.local/pet-browser/`：独立窗口的 Chrome 配置。
- `.env`：服务端配置和密钥。

数据库启用 WAL。备份时使用 SQLite 备份工具，或先停止引擎再复制数据库与相关文件，不能只复制正在写入的主数据库文件。配置和身份应通过受控渠道单独备份，不进入源码交付包。

## 容器部署游戏引擎

```bash
docker build -t linx-mystery:0.2.0 .
docker run --rm -p 127.0.0.1:3210:3210 --env-file .env \
  -e HOST=0.0.0.0 -e PORT=3210 -e DB_PATH=/app/data/games.sqlite \
  -v misheng-data:/app/data linx-mystery:0.2.0
```

镜像只运行游戏引擎，不包含桌面浏览器或麦克风。桌面终端仍在本机运行，通过 `PET_GAME_ORIGIN` 连接引擎。容器构建与运行需要在目标环境单独核对；当前自动验证以 Node 直接运行方式为主。

## 交付包

```bash
pnpm package
```

命令从干净的 Git 提交生成 `dist/linx-mystery-<版本>.zip`。包内包含源码、文档、依赖锁文件和配置示例，不包含 `.env`、设备身份、数据库、浏览器配置、依赖目录或运行报告。它是源码包，不是原生系统安装器。
