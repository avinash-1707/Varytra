import { describe, expect, it } from 'vitest';

import { getOnboardingPanelContent, ONBOARDING_PREFLIGHT, ONBOARDING_STEPS } from '../apps/web/src/onboarding';

describe('first-run onboarding UI helpers', () => {
  it('keeps the guide ordered from a template through a first report and retention loop', () => {
    expect(ONBOARDING_STEPS.map(({ id }) => id)).toEqual(['templates', 'preflight', 'report', 'review', 'trends']);
    expect(getOnboardingPanelContent('report').heading).toContain('report');
  });

  it('describes preflight as unresolved and confines trends to redacted organization aggregates', () => {
    expect(ONBOARDING_PREFLIGHT.every(({ state }) => state === 'Required')).toBe(true);
    expect(getOnboardingPanelContent('preflight').body).toContain('authorized comparison flow');

    const trends = getOnboardingPanelContent('trends');
    expect(trends.body).toContain('organization-scoped, redacted');
    expect(trends.body).not.toContain('raw trace');
  });
});
