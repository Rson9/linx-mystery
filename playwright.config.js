import { defineConfig } from '@playwright/test';
const fakeAudio = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] };
export default defineConfig({
  testDir: './e2e', fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:3211', channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node src/server.js', url: 'http://127.0.0.1:3211/healthz', env: { PORT: '3211', HOST: '127.0.0.1', DB_PATH: ':memory:', LINX_SERVICE_TOKEN: '', AI_HOST_ENABLED: '', LINX_AGENT_HOST_ENABLED: '', LLM_BASE_URL: '', PUBLIC_ORIGIN: '' }, reuseExistingServer: false },
    ...[3213, 3214].map(port => ({ command: 'node test/fixtures/pet-ui-server.js', url: `http://127.0.0.1:${port}/healthz`, env: { PET_TEST_PORT: String(port) }, reuseExistingServer: false }))
  ],
  projects: [
    { name: 'desktop', testMatch: 'play.spec.js', use: { viewport: { width: 1440, height: 1080 } } },
    { name: 'mobile', testMatch: 'play.spec.js', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'pet-desktop', testMatch: 'pet.spec.js', use: { baseURL: 'http://127.0.0.1:3213', viewport: { width: 1360, height: 1000 }, permissions: ['microphone'], launchOptions: fakeAudio } },
    { name: 'pet-compact', testMatch: 'pet.spec.js', use: { baseURL: 'http://127.0.0.1:3214', viewport: { width: 400, height: 740 }, permissions: ['microphone'], launchOptions: fakeAudio } }
  ]
});
