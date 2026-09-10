import { useState } from 'react';

export type OnboardingPanel = 'templates' | 'preflight' | 'report' | 'review' | 'trends';

type OnboardingStep = Readonly<{
  id: OnboardingPanel;
  label: string;
  detail: string;
}>;

type OnboardingTemplate = Readonly<{
  id: string;
  name: string;
  description: string;
  detail: string;
  recommended?: true;
}>;

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: 'templates', label: '01 / Template', detail: 'Choose a bounded starting point.' },
  { id: 'preflight', label: '02 / Preflight', detail: 'Resolve configuration before a run.' },
  { id: 'report', label: '03 / First report', detail: 'Read a release decision with evidence.' },
  { id: 'review', label: '04 / Review loop', detail: 'Turn a confirmed regression into coverage.' },
  { id: 'trends', label: '05 / Aggregate trends', detail: 'Track redacted organization-level signals.' },
] as const;

const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = [
  {
    id: 'support-sandbox',
    name: 'Support workflow sandbox',
    description: 'A controlled ticket-resolution path with a safe starter scenario and materiality policy.',
    detail: 'Recommended for the first comparison. The reference environment is resettable and bounded.',
    recommended: true,
  },
  {
    id: 'file-sandbox',
    name: 'File workflow sandbox',
    description: 'A bounded file-handling reference flow for state and policy checks.',
    detail: 'Use when your release question depends on approved file changes rather than support actions.',
  },
  {
    id: 'registered-adapter',
    name: 'Registered HTTP adapter',
    description: 'Connect an already-registered endpoint after its configuration has been resolved.',
    detail: 'Adapter credentials and request content stay outside this interface and require preflight validation.',
  },
] as const;

export const ONBOARDING_PREFLIGHT = [
  { label: 'Baseline and candidate', detail: 'Select two distinct immutable agent versions.', state: 'Required' },
  { label: 'Scenario and fixture', detail: 'Confirm the fixture reset contract before execution.', state: 'Required' },
  { label: 'Secret references', detail: 'Verify required vault references without revealing their values.', state: 'Required' },
  { label: 'Policy and estimate', detail: 'Validate the policy, run count, cost range, and expected duration.', state: 'Required' },
] as const;

export function getOnboardingPanelContent(panel: OnboardingPanel): Readonly<{ eyebrow: string; heading: string; body: string }> {
  return {
    templates: {
      eyebrow: 'Safe starting point',
      heading: 'Start with a bounded reference environment.',
      body: 'Templates create a starter scenario, materiality policy, and checklist. Review every default before treating it as production policy.',
    },
    preflight: {
      eyebrow: 'Run gate',
      heading: 'A comparison begins only when its evidence inputs are resolved.',
      body: 'Preflight names what will be checked. Actual validation occurs in the authorized comparison flow, not in this local guide.',
    },
    report: {
      eyebrow: 'Decision path',
      heading: 'End the first run at a report, not configuration.',
      body: 'The report localizes the first material divergence, states uncertainty, and gives a reviewer an attributable next action.',
    },
    review: {
      eyebrow: 'Evidence becomes coverage',
      heading: 'A reviewed regression can become a versioned future scenario.',
      body: 'Conversion should preserve a redacted evidence summary and policy context—not raw trace payloads—and always creates a new immutable version.',
    },
    trends: {
      eyebrow: 'Organization scope',
      heading: 'Use aggregates to notice a pattern, then return to evidence.',
      body: 'Trend views show organization-scoped, redacted counts and intervals only. They never substitute for an individual comparison report.',
    },
  }[panel];
}

function OnboardingNavigation({ activePanel, onSelect }: Readonly<{
  activePanel: OnboardingPanel;
  onSelect: (panel: OnboardingPanel) => void;
}>) {
  return (
    <ol className="onboarding-navigation" aria-label="First comparison guide">
      {ONBOARDING_STEPS.map((step) => {
        const isActive = activePanel === step.id;

        return (
          <li key={step.id} className={isActive ? 'onboarding-navigation-item onboarding-navigation-item--active' : 'onboarding-navigation-item'}>
            <button type="button" onClick={() => onSelect(step.id)} aria-current={isActive ? 'step' : undefined}>
              <span>{step.label}</span>
              <small>{step.detail}</small>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function TemplatePanel({ selectedTemplateId, onSelect }: Readonly<{
  selectedTemplateId: string;
  onSelect: (templateId: string) => void;
}>) {
  return (
    <div className="onboarding-template-list" role="radiogroup" aria-label="Reference environment template">
      {ONBOARDING_TEMPLATES.map((template) => {
        const isSelected = selectedTemplateId === template.id;

        return (
          <button
            key={template.id}
            type="button"
            className={isSelected ? 'onboarding-template onboarding-template--selected' : 'onboarding-template'}
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(template.id)}
          >
            <span className="onboarding-template-heading">
              <strong>{template.name}</strong>
              {template.recommended && <span className="onboarding-status onboarding-status--recommended">Recommended</span>}
            </span>
            <span>{template.description}</span>
            <small>{template.detail}</small>
          </button>
        );
      })}
    </div>
  );
}

function PreflightPanel() {
  return (
    <>
      <p className="onboarding-panel-note">
        <span className="onboarding-status onboarding-status--pending">Not yet run</span>
        No adapter, secret, fixture, or policy validation has been performed in this browser-only guide.
      </p>
      <ol className="onboarding-checklist">
        {ONBOARDING_PREFLIGHT.map((item, index) => (
          <li key={item.label}>
            <span className="onboarding-check-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
            <span className="onboarding-status onboarding-status--pending">{item.state}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function FirstReportPanel() {
  return (
    <ol className="onboarding-report-path">
      <li><span>01</span><strong>Template and project</strong><p>Frame the release question and use a safe starter.</p></li>
      <li><span>02</span><strong>Scenario and versions</strong><p>Resolve the scenario, baseline, and candidate records.</p></li>
      <li><span>03</span><strong>Authorized preflight</strong><p>Validate the adapter, policy, fixture, and estimate.</p></li>
      <li><span>04</span><strong>Comparison report</strong><p>Inspect the verdict, first divergence, and next reviewer action.</p></li>
    </ol>
  );
}

function ReviewPanel({ onDraft }: Readonly<{ onDraft: () => void }>) {
  return (
    <div className="onboarding-review-layout">
      <section className="onboarding-inbox" aria-labelledby="onboarding-inbox-title">
        <div>
          <p className="eyebrow">Reviewer inbox</p>
          <h3 id="onboarding-inbox-title">No reviews awaiting a decision.</h3>
          <p>The first report will place only a redacted evidence summary, verdict, and attributable decision controls in this inbox.</p>
        </div>
        <span className="onboarding-status onboarding-status--quiet">0 awaiting</span>
      </section>
      <section className="onboarding-conversion" aria-labelledby="onboarding-conversion-title">
        <p className="eyebrow">Regression to scenario</p>
        <h3 id="onboarding-conversion-title">Make reviewed evidence repeatable.</h3>
        <p>After a reviewer confirms a regression, create a new scenario version from its redacted finding and policy context.</p>
        <button type="button" className="onboarding-secondary-action" onClick={onDraft}>Prepare scenario draft</button>
      </section>
    </div>
  );
}

function TrendsPanel() {
  return (
    <div className="onboarding-trends">
      <div className="onboarding-trend-summary">
        <p className="eyebrow">Current interval / no reports</p>
        <strong>Trend baseline awaits the first completed comparison.</strong>
        <p>Once reports exist, this area will present redacted organization-level counts alongside the time interval and sample size.</p>
      </div>
      <table>
        <caption>Redacted organization aggregate trend preview</caption>
        <thead>
          <tr><th scope="col">Interval</th><th scope="col">Completed reports</th><th scope="col">Reviewed findings</th><th scope="col">Scenario additions</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Awaiting first report</th><td>—</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      <p className="onboarding-redaction-note"><span className="redaction-swatch" aria-hidden="true" /> Aggregate views exclude raw traces, prompts, tool payloads, and customer content.</p>
    </div>
  );
}

export function FirstRunOnboarding() {
  const [activePanel, setActivePanel] = useState<OnboardingPanel>('templates');
  const [selectedTemplateId, setSelectedTemplateId] = useState('support-sandbox');
  const [isDraftPrepared, setIsDraftPrepared] = useState(false);
  const content = getOnboardingPanelContent(activePanel);

  return (
    <section className="onboarding-surface" aria-labelledby="onboarding-title">
      <header className="onboarding-header">
        <div>
          <p className="eyebrow">First comparison / guided setup</p>
          <h2 id="onboarding-title">Build evidence before you need a release decision.</h2>
        </div>
        <a className="onboarding-create-link" href="#create-project">Create project record <span aria-hidden="true">↓</span></a>
      </header>

      <div className="onboarding-body">
        <OnboardingNavigation activePanel={activePanel} onSelect={setActivePanel} />
        <section className="onboarding-panel" aria-live="polite" aria-labelledby="onboarding-panel-title">
          <p className="eyebrow">{content.eyebrow}</p>
          <h3 id="onboarding-panel-title">{content.heading}</h3>
          <p className="onboarding-panel-intro">{content.body}</p>

          {activePanel === 'templates' && <TemplatePanel selectedTemplateId={selectedTemplateId} onSelect={setSelectedTemplateId} />}
          {activePanel === 'preflight' && <PreflightPanel />}
          {activePanel === 'report' && <FirstReportPanel />}
          {activePanel === 'review' && <ReviewPanel onDraft={() => setIsDraftPrepared(true)} />}
          {activePanel === 'trends' && <TrendsPanel />}

          {isDraftPrepared && activePanel === 'review' && (
            <p className="onboarding-local-notice" role="status">
              Scenario draft preparation is a local guide only. A connected flow must create a new immutable version from redacted review evidence.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
