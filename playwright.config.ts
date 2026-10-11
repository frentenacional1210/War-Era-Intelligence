import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',timeout:30_000,use:{baseURL:process.env.WINT_URL ?? 'http://127.0.0.1:8787',trace:'retain-on-failure',channel:process.env.WINT_BROWSER_CHANNEL},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['Pixel 7']}}],reporter:'list'});
