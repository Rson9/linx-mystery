import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3210}`;
const token = process.env.LINX_SERVICE_TOKEN;
if (!token) { console.error('请先在 .env 中配置 LINX_SERVICE_TOKEN'); process.exit(1); }
const client = new Client({ name: 'misheng-discovery-check', version: '1.0' });
try {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  });
  await client.connect(transport);
  const result = await client.listTools();
  for (const name of ['mystery_catalog', 'mystery_turn']) {
    if (!result.tools.some(t => t.name === name)) throw new Error('Missing expected tool');
  }
  console.log('Streamable HTTP 工具发现通过：' + result.tools.map(t => t.name).join(', '));
} catch (error) {
  // 不输出可能含认证响应或请求元数据的第三方异常。
  console.error(`MCP 检查失败（${error.name}），请检查地址、认证及服务端 [mcp] 日志。`);
  process.exitCode = 1;
} finally { await client.close(); }
