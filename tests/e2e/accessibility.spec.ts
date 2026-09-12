import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('the unauthenticated workspace communicates failure accessibly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/workspace|project|sign in|unable/i).first()).toBeVisible();
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});
