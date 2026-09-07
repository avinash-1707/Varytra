const serviceChecks = [
  ['Web client', 'Ready', 'Browser interface initialized'],
  ['Release analysis', 'Pending', 'Awaiting connected evaluation services'],
] as const;

export function App() {
  return (
    <main className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="#status" aria-label="Varytra operational status">
          VARYTRA<span className="wordmark-mark">/</span>
        </a>
        <p className="environment-label">Local foundation</p>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">System record / U0</p>
        <h1 id="page-title">Varytra web is operational.</h1>
        <p className="lede">
          The release-intelligence interface is online and ready to make agent
          decisions legible, auditable, and calm.
        </p>
      </section>

      <section id="status" className="status-panel" aria-labelledby="status-title">
        <div className="status-heading">
          <div>
            <p className="eyebrow">Operational status</p>
            <h2 id="status-title">Foundation check</h2>
          </div>
          <p className="status-tag">
            <span aria-hidden="true">●</span> Ready
          </p>
        </div>

        <dl className="status-list">
          {serviceChecks.map(([name, state, detail]) => (
            <div className="status-row" key={name}>
              <dt>{name}</dt>
              <dd>
                <span className={state === 'Ready' ? 'state-ready' : 'state-pending'}>
                  {state}
                </span>
                <span className="status-detail">{detail}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="ledger" aria-labelledby="ledger-title">
        <div className="ledger-header">
          <p className="eyebrow">Chronology</p>
          <h2 id="ledger-title">Foundation ledger</h2>
        </div>
        <ol>
          <li>
            <time dateTime="2026-09-07T00:00:00">SEQ 001</time>
            <span className="ledger-node" aria-hidden="true" />
            <p>Web entry point mounted</p>
          </li>
          <li>
            <time dateTime="2026-09-07T00:00:01">SEQ 002</time>
            <span className="ledger-node ledger-node--ready" aria-hidden="true" />
            <p>Operational status confirmed</p>
          </li>
        </ol>
      </section>

      <footer>
        <span>Varytra</span>
        <span>Evidence before release</span>
      </footer>
    </main>
  );
}
