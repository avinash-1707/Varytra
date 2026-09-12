import { useEffect, useRef } from 'react';

const TAGLINE_LINES = [
  'Compare the path before you trust the outcome.',
  'Release with evidence your team can inspect.',
] as const;

const benefits = [
  {
    number: '01',
    title: 'Find the first material break',
    body: 'Align baseline and candidate trajectories so reviewers start at the decision changing event, not at an undifferentiated log.',
  },
  {
    number: '02',
    title: 'Keep the release record defensible',
    body: 'Bind verdicts to immutable versions, policy outcomes, coverage, and a safe evidence projection that can be reviewed later.',
  },
  {
    number: '03',
    title: 'Carry the decision into delivery',
    body: 'Give CI a compact verdict and report link while keeping trace payloads out of routine release signals.',
  },
] as const;

const steps = [
  {
    number: '01',
    label: 'Frame',
    title: 'State the release question',
    body: 'Record the scenario, expected final state, materiality policy, and the immutable baseline and candidate versions.',
  },
  {
    number: '02',
    label: 'Compare',
    title: 'Run paired trajectories',
    body: 'Varytra executes the registered endpoints, aligns the resulting evidence, then applies deterministic checks before any semantic review.',
  },
  {
    number: '03',
    label: 'Decide',
    title: 'Review a localized report',
    body: 'See the release classification, first material divergence, affected evidence, and a shareable report for the decision record.',
  },
] as const;

const faqs = [
  {
    question: 'What does Varytra compare?',
    answer: 'Varytra compares paired baseline and candidate agent runs against a versioned scenario. It evaluates trajectories, final state, policy outcomes, reliability, and efficiency evidence.',
  },
  {
    question: 'Does a different trajectory always block release?',
    answer: 'No. Different paths can be harmless. Varytra localizes the difference and distinguishes no material change, suspected regression, improvement, and inconclusive evidence.',
  },
  {
    question: 'How are safety policies handled?',
    answer: 'Deterministic state integrity and policy checks run before semantic evaluation. A critical policy failure cannot be silently converted into a pass.',
  },
  {
    question: 'What happens when evidence is incomplete?',
    answer: 'The result remains inconclusive. The report identifies the limited evidence and presents the smallest next action, such as more repetitions or a fixture correction.',
  },
  {
    question: 'Does the workspace expose raw traces by default?',
    answer: 'No. Default reports use redacted, safe projections. Raw content is progressively disclosed only to authorized users and is excluded from ordinary delivery signals.',
  },
  {
    question: 'Can Varytra inform CI gates?',
    answer: 'Yes. The CI result carries the verdict, severity, confidence, and immutable report URL so delivery systems can apply a policy without receiving raw trace content.',
  },
] as const;

function WordReveal({ line }: { line: string }) {
  const lineRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const words = lineRef.current?.querySelectorAll<HTMLSpanElement>('[data-reveal-word]');
    if (!words || !('IntersectionObserver' in window)) {
      words?.forEach((word) => word.classList.add('is-visible'));
      return;
    }

    const observers = Array.from(words, (word) => {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            word.classList.add('is-visible');
            observer.unobserve(word);
          }
        },
        { rootMargin: '0px 0px -18% 0px', threshold: 0.8 },
      );
      observer.observe(word);
      return observer;
    });

    return () => observers.forEach((observer) => observer.disconnect());
  }, []);

  return (
    <span className="landing-reveal-line" ref={lineRef}>
      {line.split(' ').map((word, index) => (
        <span data-reveal-word className="landing-reveal-word" style={{ transitionDelay: `${index * 55}ms` }} key={`${word}-${index}`}>
          {word}{' '}
        </span>
      ))}
    </span>
  );
}

function TrajectoryLedgerVisual() {
  return (
    <figure className="landing-ledger" aria-labelledby="ledger-caption">
      <figcaption id="ledger-caption" className="landing-ledger-caption">
        <span>Trajectory ledger</span>
        <span>Illustrative run pair</span>
      </figcaption>
      <div className="landing-ledger-plot" aria-hidden="true">
        <div className="landing-ledger-lane">
          <span className="landing-ledger-label">Baseline</span>
          <div className="landing-ledger-track">
            <i className="landing-ledger-node">01</i><i className="landing-ledger-node">02</i><i className="landing-ledger-node">03</i><i className="landing-ledger-node">04</i><b className="landing-ledger-outcome landing-ledger-outcome--pass">Pass</b>
          </div>
        </div>
        <div className="landing-ledger-connector"><span>first material divergence</span></div>
        <div className="landing-ledger-lane">
          <span className="landing-ledger-label">Candidate</span>
          <div className="landing-ledger-track">
            <i className="landing-ledger-node">01</i><i className="landing-ledger-node">02</i><i className="landing-ledger-node">03</i><i className="landing-ledger-node landing-ledger-node--divergence">×</i><i className="landing-ledger-node">05</i><b className="landing-ledger-outcome landing-ledger-outcome--review">Review</b>
          </div>
        </div>
      </div>
      <table className="landing-ledger-table">
        <caption>Illustrative trajectory events</caption>
        <thead><tr><th>Track</th><th>Sequence</th><th>Recorded result</th></tr></thead>
        <tbody>
          <tr><td>Baseline</td><td>04</td><td>Approval preserved</td></tr>
          <tr><td>Candidate</td><td>04</td><td>Material divergence requires review</td></tr>
        </tbody>
      </table>
      <p className="landing-ledger-note"><span>Evidence note</span> Compare the sequence before aggregating the verdict.</p>
    </figure>
  );
}

export function LandingPage() {
  return (
    <div className="landing-shell">
      <a className="landing-skip-link" href="#landing-main">Skip to content</a>
      <header className="landing-header">
        <a className="landing-wordmark" href="/" aria-label="Varytra home">VARYTRA<span>/</span></a>
        <p className="landing-header-context">Regression intelligence for AI agents</p>
      </header>

      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">Release decision record / 01</p>
            <h1 id="landing-title">Know what changed<br />before your agent ships.</h1>
            <p className="landing-lede">Varytra compares baseline and candidate agent runs, localizes material divergence, and gives AI teams an evidence backed release decision.</p>
            <a className="landing-primary-action" href="/app">Open workspace <span aria-hidden="true">→</span></a>
            <p className="landing-proof-line"><span>Recorded basis</span> Versioned inputs · paired trajectories · policy outcomes · immutable reports</p>
          </div>
          <TrajectoryLedgerVisual />
        </section>

        <section className="landing-problem" aria-labelledby="problem-title">
          <div className="landing-section-label"><span>02</span><span>Release review</span></div>
          <div className="landing-problem-statement">
            <h2 id="problem-title">A successful final response can still hide a release changing path.</h2>
            <p>Raw logs are exhaustive but slow to review. Aggregate scores are fast but can bury the event that changes a customer state, violates a policy, or alters a cost boundary. Varytra preserves both the decision and the evidence behind it.</p>
          </div>
        </section>

        <section className="landing-tagline" aria-label="Varytra benefit">
          <p className="landing-eyebrow">Evidence before release</p>
          <p className="landing-tagline-copy" aria-hidden="true">
            {TAGLINE_LINES.map((line) => <WordReveal key={line} line={line} />)}
          </p>
          <p className="landing-screen-reader-text">{TAGLINE_LINES.join(' ')}</p>
        </section>

        <section className="landing-benefits" aria-labelledby="benefits-title">
          <div className="landing-section-heading">
            <div><p className="landing-eyebrow">03 / Decision clarity</p><h2 id="benefits-title">Evidence that holds its shape under review.</h2></div>
            <p>Each result starts with a consequence, then points directly to the observed record.</p>
          </div>
          <ol className="landing-benefit-list">
            {benefits.map((benefit) => <li key={benefit.number}><span className="landing-list-number">{benefit.number}</span><div><h3>{benefit.title}</h3><p>{benefit.body}</p></div></li>)}
          </ol>
        </section>

        <section className="landing-flow" aria-labelledby="flow-title">
          <div className="landing-section-heading">
            <div><p className="landing-eyebrow">04 / Method</p><h2 id="flow-title">From release question to accountable decision.</h2></div>
            <p>Three recorded steps, with uncertainty kept visible when evidence is not sufficient.</p>
          </div>
          <ol className="landing-step-list">
            {steps.map((step) => <li key={step.number}><p className="landing-step-meta">{step.number} / {step.label}</p><h3>{step.title}</h3><p>{step.body}</p></li>)}
          </ol>
        </section>

        <section id="evidence" className="landing-evidence" aria-labelledby="evidence-title">
          <div className="landing-section-label"><span>05</span><span>Product evidence</span></div>
          <div className="landing-evidence-content">
            <div><p className="landing-eyebrow">What the record contains</p><h2 id="evidence-title">Proof is a report, not a marketing claim.</h2><p>Varytra makes the release decision inspectable with concrete system evidence. It does not replace judgment with a score or claim certainty where evidence is incomplete.</p></div>
            <dl className="landing-evidence-register">
              <div><dt>Verdict lineage</dt><dd>Classification, severity, coverage, and evaluator version remain attached to the comparison.</dd></div>
              <div><dt>First divergence</dt><dd>Baseline and candidate sequence ranges identify where material behavior first separates.</dd></div>
              <div><dt>Safety boundary</dt><dd>Deterministic policy and final state checks run before a semantic assessment can contribute context.</dd></div>
              <div><dt>Safe projection</dt><dd>Routine reports expose redacted evidence summaries, not raw prompts, payloads, or secrets.</dd></div>
            </dl>
          </div>
        </section>

        <section className="landing-faq" aria-labelledby="faq-title">
          <div className="landing-section-heading"><div><p className="landing-eyebrow">06 / Questions</p><h2 id="faq-title">What teams need to know before they compare.</h2></div></div>
          <div className="landing-faq-list">
            {faqs.map((faq) => <details key={faq.question}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}</p></details>)}
          </div>
        </section>

        <section className="landing-final-cta" aria-labelledby="final-cta-title">
          <p className="landing-eyebrow">Decision ready</p>
          <h2 id="final-cta-title">Open the workspace and make the next release legible.</h2>
          <a className="landing-primary-action" href="/app">Open workspace <span aria-hidden="true">→</span></a>
        </section>
      </main>

      <footer className="landing-footer">
        <p>Varytra / Evidence before release</p>
        <div><a href="#privacy">Privacy</a><a href="#terms">Terms</a></div>
        <section id="privacy" aria-label="Privacy notice"><strong>Privacy</strong><span>Product records are designed to keep raw traces and secrets out of routine reports.</span></section>
        <section id="terms" aria-label="Terms notice"><strong>Terms</strong><span>Release decisions remain subject to your team’s review and deployment policy.</span></section>
      </footer>
    </div>
  );
}
