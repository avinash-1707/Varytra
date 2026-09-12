import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('the public landing page communicates evidence accessibly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /know what changed/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /open workspace/i }).first()).toHaveAttribute('href', '/app');
  await page.locator('.landing-tagline').scrollIntoViewIfNeeded();
  await expect(page.locator('.landing-reveal-word.is-visible').first()).toBeVisible();
  await page.waitForTimeout(500);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBeTruthy();
});
