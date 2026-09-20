import { expect, test } from '@playwright/test';

const fresh = { stage: 'email', captcha_endpoint: '/api/auth/captcha/' };
const pending = () => ({ ...fresh, stage: 'code', email: 'student@tju.edu.cn', expires_at: new Date(Date.now() + 600000).toISOString(), resend_at: new Date(Date.now() + 60000).toISOString() });
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
// UI contract tests only. The integration repository separately solves real Cap.
async function solveForUI(page) {
  await page.locator('cap-widget').evaluate(element => EventTarget.prototype.dispatchEvent.call(element, new CustomEvent('solve', { detail: { token: 'ui-contract-only' } })));
}
test('welcome offers a visible password login', async ({ page }) => {
  await page.route('**/api/auth/flow', route => reply(route, fresh));
  await page.goto('/');
  await expect(page.getByRole('link', { name: '使用密码登录' })).toBeVisible();
  await page.getByRole('link', { name: '使用密码登录' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
});


for (const route of ['/auth/login', '/auth/registration']) {
  test(`${route}: slow flow preserves editable email and requires Cap`, async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let posts = 0;
    await page.route('**/api/auth/flow', async request => { await gate; await reply(request, fresh); });
    await page.route('**/api/auth/start', request => { posts++; return reply(request, pending()); });
    await page.goto(route);
    const email = page.getByLabel('邮箱地址', { exact: true });
    await expect(email).toBeVisible();
    await expect(page.locator('.auth-skeleton, .app-loading-shell')).toHaveCount(0);
    await email.fill('draft@tju.edu.cn');
    await email.press('Enter');
    expect(posts).toBe(0);
    await expect(page.getByRole('button', { name: '获取验证码', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(email).toHaveValue('draft@tju.edu.cn');
    await expect(page.getByRole('button', { name: '获取验证码', exact: true })).toBeDisabled();
    await solveForUI(page);
    await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /秒后可重发/ })).toBeDisabled();
    expect(posts).toBe(1);
  });
}
test('password tab posts credentials and keeps OTP as default', async ({ page }) => {
  let passwordPosts = 0;
  let startPosts = 0;
  await page.route('**/api/auth/flow', route => reply(route, fresh));
  await page.route('**/api/auth/password', route => {
    passwordPosts++;
    return reply(route, { error: { id: 'invalid_credentials' } }, 400);
  });
  await page.route('**/api/auth/start', route => { startPosts++; return reply(route, pending()); });
  await page.goto('/auth/login');
  await expect(page.getByRole('button', { name: '获取验证码', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '密码' }).click();
  expect(await page.locator('label[for="auth-password"]').evaluate(label => label.getBoundingClientRect().width > 10)).toBe(true);
  await page.getByLabel('邮箱地址', { exact: true }).fill('student@tju.edu.cn');
  await page.getByLabel('密码', { exact: true }).fill('correcthorse');
  await solveForUI(page);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  expect(passwordPosts).toBe(1);
  expect(startPosts).toBe(0);
});

test('restored OTP has no error until a rejected submission', async ({ page }) => {
  await page.route('**/api/auth/flow', route => reply(route, pending()));
  await page.route('**/api/auth/verify', route => reply(route, { error: { id: 'invalid_code' } }, 400));
  await page.goto('/auth/login');
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('邮箱验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('验证码不正确');
  await page.reload();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('flow failure retries without losing draft or replacing the form', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/auth/flow', route => ++calls === 1 ? reply(route, { error: { id: 'auth_unavailable' } }, 503) : reply(route, fresh));
  await page.goto('/auth/login');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('邮箱地址', { exact: true }).fill('draft@tju.edu.cn');
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('邮箱地址', { exact: true })).toHaveValue('draft@tju.edu.cn');
});
for (const [width, height] of [[1366, 768], [1024, 600], [390, 844], [320, 844]]) {
  for (const stage of ['email', 'code']) {
    test(`compact ${stage} card ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.route('**/api/auth/flow', route => reply(route, stage === 'code' ? pending() : fresh));
      await page.goto('/auth/login');
      await expect(page.getByLabel(stage === 'code' ? '邮箱验证码' : '邮箱地址', { exact: true })).toBeVisible();
      await expect(page.getByRole('status')).toHaveCount(0);
      if (stage === 'email') {
        const fieldLabelWidth = await page.locator('label[for="auth-input"]').evaluate(label => label.getBoundingClientRect().width);
        expect(fieldLabelWidth > 10).toBe(width >= 960);
      }
      const size = await page.locator('.auth-card').boundingBox();
      expect(size.height).toBeLessThanOrEqual(width >= 1000 ? 600 : 600);
      expect(await page.evaluate(() => ({ x: document.documentElement.scrollWidth <= innerWidth, y: document.documentElement.scrollHeight <= innerHeight }))).toEqual({ x: true, y: true });
      if (stage === 'email' && width <= 390) {
        const mobileLayout = await page.evaluate(() => {
          const card = document.querySelector('.auth-card');
          const topbar = document.querySelector('.auth-card-topbar');
          return {
            topInset: topbar.getBoundingClientRect().top - card.getBoundingClientRect().top,
            methodToControlGap: document.querySelector('.auth-input-wrap').getBoundingClientRect().top - document.querySelector('.auth-method-tabs').getBoundingClientRect().bottom,
          };
        });
        expect(mobileLayout.topInset).toBeLessThanOrEqual(18);
        expect(mobileLayout.methodToControlGap).toBeGreaterThanOrEqual(7);
        expect(mobileLayout.methodToControlGap).toBeLessThanOrEqual(9);
      }
    });
  }
}

for (const [width, height] of [[1366, 768], [1024, 600], [390, 844]]) {
  for (const theme of ['light', 'dark']) {
    test(`stable authentication stages ${width}x${height} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(mode => localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode, accent: 'mono' })), theme);
      const next = () => ({ ...pending(), resend_at: new Date(Date.now() - 1000).toISOString() });
      await page.route('**/api/auth/flow', route => reply(route, fresh));
      await page.route('**/api/auth/start', route => reply(route, next()));
      await page.route('**/api/auth/verify', route => reply(route, { error: { id: 'invalid_code' } }, 400));
      await page.route('**/api/auth/reset', route => reply(route, fresh));
      await page.route('**/api/auth/resend', route => reply(route, next()));
      await page.goto('/auth/login');
      await expect(page.getByRole('status')).toHaveCount(0);
      const card = page.locator('.auth-flow-card');
      const initial = await card.boundingBox();
      async function stable(name) {
        const bounds = await card.boundingBox();
        expect(Math.abs(bounds.width - initial.width)).toBeLessThanOrEqual(4);
        expect(Math.abs(bounds.x - initial.x)).toBeLessThanOrEqual(4);
        const fits = await card.evaluate(element => {
          const box = element.getBoundingClientRect();
          return [...element.querySelectorAll('input, button, cap-widget, h1, [role="alert"]')].every(control => {
            const r = control.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return true;
            return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right;
          }) && element.scrollHeight <= element.clientHeight;
        });
        expect(fits).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${name}.png`) });
      }
      await stable('email');
      await page.getByLabel('邮箱地址', { exact: true }).fill('student@tju.edu.cn');
      await solveForUI(page);
      await page.getByRole('button', { name: '获取验证码', exact: true }).click();
      await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
      await stable('code');
      await page.getByLabel('邮箱验证码', { exact: true }).fill('000000');
      await page.getByRole('button', { name: '验证并继续', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await stable('error');
      await page.getByRole('button', { name: '重新发送', exact: true }).click();
      await expect(page.getByRole('button', { name: '确认重发', exact: true })).toBeDisabled();
      await stable('resend');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeFocused();
      await stable('cancel');
      await page.getByRole('button', { name: '重新发送', exact: true }).click();
      await solveForUI(page);
      await page.getByRole('button', { name: '确认重发', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('新验证码');
      await stable('resent');
      await page.getByRole('button', { name: '更换邮箱', exact: true }).click();
      await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
      await stable('reset');
    });
  }
}
