import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:3211', channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', trace: 'retain-on-failure' },
  webServer: { command: 'node src/server.js', url: 'http://127.0.0.1:3211/healthz', env: { PORT: '3211', HOST: '127.0.0.1', DB_PATH: ':memory:', LINX_SERVICE_TOKEN: '', LLM_BASE_URL: '', PUBLIC_ORIGIN: '' }, reuseExistingServer: false },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 1080 } } }, { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }]
});
