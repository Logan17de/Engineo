import { ENGINE_CONTRACT_VERSION } from "@engineo/contracts";

const milestones = [
  ["M0", "Scheduling kernel", "active"],
  ["M1", "Planner workspace", "queued"],
  ["M2", "Professional controls", "queued"],
  ["M3", "Resources & earned value", "queued"],
] as const;

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            E
          </span>
          <span>Engineo</span>
        </div>
        <span className="status">Foundation · Contract v{ENGINE_CONTRACT_VERSION}</span>
      </header>

      <section className="hero">
        <p className="eyebrow">PROJECT COMMAND CENTER</p>
        <h1>Command complex projects.</h1>
        <p className="lede">
          Engineo is building a deterministic planning and project-controls core, then wrapping it
          in a faster, clearer workspace for the people responsible for delivery.
        </p>
      </section>

      <section className="panel" aria-labelledby="foundation-heading">
        <div>
          <p className="eyebrow">CURRENT MILESTONE</p>
          <h2 id="foundation-heading">M0 · Deterministic scheduling kernel</h2>
          <p>
            Calendars, dependency logic, CPM, float, constraints, path tracing, diagnostics, and
            performance fixtures come before decorative dashboards.
          </p>
        </div>
        <div className="signal">
          <span className="signalDot" />
          BUILDING
        </div>
      </section>

      <section className="milestones" aria-label="Product milestones">
        {milestones.map(([id, name, state]) => (
          <article className="milestone" key={id}>
            <div className="milestoneId">{id}</div>
            <div>
              <strong>{name}</strong>
              <span>{state}</span>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
