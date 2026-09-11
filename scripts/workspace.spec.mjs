import { expect, test } from '@playwright/test';

const syntheticSessionA = {
  id: 'user-identity-uuid-aaaa',
  email: 'user-a@example.com',
  email_verified: true,
  expires_at: '2099-01-01T00:00:00Z',
};

const syntheticSessionB = {
  id: 'user-identity-uuid-bbbb',
  email: 'user-b@example.com',
  email_verified: true,
  expires_at: '2099-01-01T00:00:00Z',
};

const taskIdA1 = 'a'.repeat(32);
const taskIdA2 = 'b'.repeat(32);
const taskIdCreated = 'c'.repeat(32);

const syntheticTasksUserA = [
  {
    id: taskIdA1,
    title: 'First task for user A',
    prompt: 'First task for user A\nLine 2 details',
    status: 'draft',
    created_at: '2026-09-08T10:00:00Z',
  },
  {
    id: taskIdA2,
    title: 'Second task for user A',
    prompt: 'Second task for user A',
    status: 'draft',
    created_at: '2026-09-08T11:00:00Z',
  },
];

test.describe('Workspace mocked contract suite', () => {
  test('redirects to /auth/login when session is missing or 401', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { id: 'session_required' } }),
    }));

    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('redirects to /auth/login when tasks API returns 401 session_required', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(syntheticSessionA),
    }));

    await page.route('**/api/tasks', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { id: 'session_required' } }),
    }));

    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('clears in-memory tasks and reset state when switching identity', async ({ page }) => {
    let currentSession = syntheticSessionA;

    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(currentSession),
    }));

    await page.route('**/api/tasks', route => {
      if (currentSession.id === syntheticSessionA.id) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tasks: syntheticTasksUserA }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.route(`**/api/tasks/${taskIdA1}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: syntheticTasksUserA[0] }),
    }));

    await page.goto('/workspace');
    await expect(page.getByRole('heading', { level: 1, name: '任务工作区' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'First task for user A', exact: true })).toBeVisible();

    // Switch identity to User B and trigger visibility change
    currentSession = syntheticSessionB;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Task list must now be cleared and show empty state
    await expect(page.getByText('还没有保存的任务')).toBeVisible();
    await expect(page.getByText('First task for user A', { exact: true })).toHaveCount(0);
  });

  test('late creation response cannot restore a previous identity task', async ({ page }) => {
    let currentSession = syntheticSessionA;
    let pendingCreate;
    let releaseCreate;
    const released = new Promise(resolve => { releaseCreate = resolve; });
    const oldPrompt = 'Private pending task from user A';

    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(currentSession),
    }));
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'POST') {
        pendingCreate = route;
        await released;
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto('/workspace');
    const input = page.getByRole('textbox', { name: '任务目标', exact: true });
    await input.fill(oldPrompt);
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect.poll(() => Boolean(pendingCreate)).toBe(true);

    currentSession = syntheticSessionB;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(input).toHaveValue('');
    await expect(page.getByText('还没有保存的任务')).toBeVisible();

    try {
      await pendingCreate.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ task: {
          id: taskIdCreated, title: oldPrompt, prompt: oldPrompt,
          status: 'draft', created_at: '2026-09-08T12:00:00Z',
        } }),
      });
    } finally {
      releaseCreate();
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByText(oldPrompt, { exact: true })).toHaveCount(0);
    await expect(page.getByText('还没有保存的任务')).toBeVisible();
    await input.fill('New task for user B');
    await expect(page.getByRole('button', { name: '保存任务', exact: true })).toBeEnabled();
  });

  test('preserves user input text on submission failure and allows retry', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(syntheticSessionA),
    }));

    const createdTask = {
      id: taskIdCreated,
      title: 'Review operating system lecture slides and prepare questions',
      prompt: 'Review operating system lecture slides and prepare questions',
      status: 'draft',
      created_at: new Date().toISOString(),
    };

    await page.route(`**/api/tasks/${taskIdCreated}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: createdTask }),
    }));

    await page.route('**/api/tasks', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tasks: [] }),
        });
      }
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { id: 'task_storage_unavailable' } }),
      });
    });

    await page.goto('/workspace');
    await expect(page.getByRole('heading', { level: 1, name: '任务工作区' })).toBeVisible();

    const input = page.getByRole('textbox', { name: '任务目标', exact: true });
    const targetText = 'Review operating system lecture slides and prepare questions';
    await input.fill(targetText);
    await page.getByRole('button', { name: '保存任务', exact: true }).click();

    // Error alert displayed
    await expect(page.getByRole('alert')).toContainText('任务存储服务暂时不可用');
    // Input must preserve the typed text
    await expect(input).toHaveValue(targetText);

    // Unroute 503 and provide successful response
    await page.unroute('**/api/tasks');
    await page.route('**/api/tasks', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tasks: [] }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          task: createdTask,
        }),
      });
    });

    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: targetText, exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('displays task details with draft status and execution disclaimer', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(syntheticSessionA),
    }));

    await page.route('**/api/tasks', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: syntheticTasksUserA }),
    }));

    await page.route(`**/api/tasks/${taskIdA1}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: syntheticTasksUserA[0] }),
    }));

    await page.route(`**/api/tasks/${taskIdA1}/runs`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }));

    await page.goto('/workspace');
    await expect(page.getByRole('heading', { level: 2, name: 'First task for user A' })).toBeVisible();
    await expect(page.locator('.workspace-detail-panel').getByText('Line 2 details')).toBeVisible();
    await expect(page.locator('.workspace-detail-panel').getByText('已保存', { exact: true })).toBeVisible();
    await expect(page.getByText('草稿捕获阶段')).toBeVisible();
  });

  test('displays Run list, active status, and supports cancelling run', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(syntheticSessionA),
    }));

    await page.route('**/api/tasks', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: syntheticTasksUserA }),
    }));

    await page.route(`**/api/tasks/${taskIdA1}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: syntheticTasksUserA[0] }),
    }));

    const runId1 = '1'.repeat(32);
    const mockRunningRun = {
      id: runId1,
      task_id: taskIdA1,
      status: 'running',
      created_at: '2026-09-09T10:00:00Z',
      started_at: '2026-09-09T10:00:01Z',
    };

    const mockCancelledRun = {
      ...mockRunningRun,
      status: 'cancelled',
      finished_at: '2026-09-09T10:01:00Z',
    };

    let runsState = [mockRunningRun];

    await page.route(`**/api/tasks/${taskIdA1}/runs`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ runs: runsState }),
        });
      }
      if (route.request().method() === 'POST') {
        const newRunId = '2'.repeat(32);
        const createdRun = {
          id: newRunId,
          task_id: taskIdA1,
          status: 'queued',
          created_at: new Date().toISOString(),
        };
        runsState = [createdRun, ...runsState];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ run: createdRun }),
        });
      }
    });

    await page.route(`**/api/runs/${runId1}/cancel`, route => {
      runsState = [mockCancelledRun];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run: mockCancelledRun }),
      });
    });

    await page.goto('/workspace');
    await expect(page.getByRole('heading', { level: 2, name: 'First task for user A' })).toBeVisible();

    // Check Run list header and running status badge
    await expect(page.getByRole('heading', { level: 3, name: '执行记录与运行 (Runs)' })).toBeVisible();
    await expect(page.locator(`[data-testid="run-card-${runId1}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="run-card-${runId1}"]`).getByText('执行中')).toBeVisible();

    // Cancel the running run
    const cancelBtn = page.getByRole('button', { name: `取消执行 ${runId1.slice(0, 8)}` });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // After cancellation, status should update to 已取消
    await expect(page.locator(`[data-testid="run-card-${runId1}"]`).getByText('已取消')).toBeVisible();
  });

  test('displays artifacts and error information on terminal run', async ({ page }) => {
    await page.route('**/api/auth/session', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(syntheticSessionA),
    }));

    await page.route('**/api/tasks', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: syntheticTasksUserA }),
    }));

    await page.route(`**/api/tasks/${taskIdA1}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: syntheticTasksUserA[0] }),
    }));

    const runIdFailed = '3'.repeat(32);
    const mockFailedRun = {
      id: runIdFailed,
      task_id: taskIdA1,
      status: 'failed',
      created_at: '2026-09-09T08:00:00Z',
      finished_at: '2026-09-09T08:02:00Z',
      error: '模型响应超时，沙箱实例已自动释放。',
    };

    const runIdSucceeded = '4'.repeat(32);
    const mockSucceededRun = {
      id: runIdSucceeded,
      task_id: taskIdA1,
      status: 'succeeded',
      created_at: '2026-09-09T09:00:00Z',
      finished_at: '2026-09-09T09:05:00Z',
      artifacts: [
        {
          id: 'art-001',
          name: 'course_review_outline.md',
          size_bytes: 4096,
          url: '/api/artifacts/art-001/download',
        },
      ],
    };

    await page.route(`**/api/tasks/${taskIdA1}/runs`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [mockSucceededRun, mockFailedRun] }),
    }));

    await page.goto('/workspace');
    await expect(page.getByRole('heading', { level: 2, name: 'First task for user A' })).toBeVisible();

    // Verify succeeded run and artifact download link
    const succCard = page.locator(`[data-testid="run-card-${runIdSucceeded}"]`);
    await expect(succCard.getByText('已完成')).toBeVisible();
    await expect(succCard.getByText('course_review_outline.md')).toBeVisible();
    await expect(succCard.getByRole('link', { name: '下载 course_review_outline.md' })).toBeVisible();

    // Verify failed run and error text
    const failCard = page.locator(`[data-testid="run-card-${runIdFailed}"]`);
    await expect(failCard.getByText('执行失败')).toBeVisible();
    await expect(failCard.getByText('模型响应超时，沙箱实例已自动释放。')).toBeVisible();
  });
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900], [1920, 1080], [2560, 1440]]) {
  for (const theme of ['light', 'dark']) {
    test(`workspace layout ${width}x${height} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });

      await page.route('**/api/auth/session', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(syntheticSessionA),
      }));

      await page.route('**/api/tasks', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: syntheticTasksUserA }),
      }));

      await page.route(`**/api/tasks/${taskIdA1}`, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task: syntheticTasksUserA[0] }),
      }));

      await page.goto('/workspace');
      await expect(page.getByRole('heading', { level: 1, name: '任务工作区' })).toBeVisible();

      // No horizontal overflow
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      expect(horizontalOverflow).toBe(true);
      const accountTextHeight = await page.locator('.workspace-nav-link span')
        .evaluate(element => element.getBoundingClientRect().height);
      expect(accountTextHeight).toBeLessThan(32);

      // Verify appearance toggle button
      const toggleLabel = theme === 'dark' ? '切换浅色外观' : '切换深色外观';
      await expect(page.getByRole('button', { name: toggleLabel })).toBeVisible();

      // Responsive screenshot artifact
      await page.screenshot({
        path: `test-results/workspace/workspace-${width}x${height}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}
