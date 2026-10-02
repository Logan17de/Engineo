# Engineo Product Definition

## Product thesis

Complex projects fail expensively when teams cannot see how scope, time, resources, cost, and risk interact. Engineo will be a modern command center for complex projects: professional scheduling and controls depth, approachable workflows, open data, and AI that helps users understand and improve a project without replacing deterministic project mathematics.

Engineo is designed from first principles around user jobs. It is not an implementation clone of an incumbent product.

## Primary users

- **Planner / Scheduler** — builds and maintains integrated schedules, logic, calendars, constraints, baselines, status updates, and schedule-quality checks.
- **Project Manager** — needs forecasts, critical work, variance, risks, recovery options, and clear explanations.
- **Cost / Controls Engineer** — connects schedule progress to budgets, actuals, forecasts, earned value, and trends.
- **Resource Manager** — manages people, crews, equipment, capacity, assignments, overloads, and scenarios.
- **Contractor / Delivery Team** — needs look-aheads, assignments, progress capture, constraints, handoffs, and simple updates.
- **Owner / Executive** — needs portfolio health, milestones, forecast dates, cost exposure, risk, and decisions.
- **Administrator** — controls organizations, users, permissions, calendars, codes, integrations, and auditability.

## Core jobs to be done

1. Turn scope into an executable schedule.
2. Calculate trustworthy dates from logic, calendars, constraints, and progress.
3. Understand what controls completion and why.
4. Establish and compare approved baselines.
5. Forecast the impact of progress, delays, changes, and resource conflicts.
6. Allocate limited resources across activities and projects.
7. Connect schedule progress to cost and earned value.
8. Communicate the right view to each stakeholder.
9. Preserve a defensible history of changes and decisions.
10. Explore recovery and what-if scenarios safely.

## Product surfaces

### Project workspace
Project summary, data date, forecast completion, milestone status, critical work, alerts, and recent changes.

### Schedule
A high-performance activity table synchronized with a Gantt timeline. Editing relationships, durations, constraints, calendars, codes, progress, and assignments must be fast enough for professional schedulers.

### WBS
Hierarchical scope structure with rollups and restructuring.

### Logic / network
Dependency visualization, open-end detection, driving relationships, path tracing, and diagnostics.

### Calendars
Reusable work calendars, shifts, holidays, exceptions, and activity/resource assignment.

### Baselines
Immutable snapshots, comparison baselines, and date/duration/cost variance.

### Resources
Resources/roles, rates, calendars, availability, assignments, histograms, overloads, and leveling.

### Cost & performance
Budgets, actuals, remaining/forecast cost, time-phased values, EVM metrics, and trends.

### Programs & portfolios
Multi-project rollups, milestones, resource demand, capacity, health, and scenarios.

### Reports
Saved views, printable/exportable reports, scheduled reports, and machine-readable exports.

### AI command layer
Natural-language project queries and safe commands backed by deterministic tools.

## AI-native capabilities

AI may:
- draft a WBS and activity plan;
- propose relationships, durations, and calendars;
- explain why a completion date moved;
- trace delay propagation and driving paths;
- detect suspicious constraints, open ends, excessive lags, and quality problems;
- propose recovery scenarios;
- summarize weekly status;
- extract candidate progress updates from field reports;
- create queries, filters, reports, and dashboards.

AI must not:
- silently alter schedule mathematics;
- fabricate calculated dates or EVM metrics;
- apply material schedule changes without deterministic validation;
- hide assumptions behind recommendations.

## Initial non-goals

The first releases will not attempt to be a full ERP/accounting system, BIM authoring tool, payroll platform, document-management suite, or every construction field workflow. Engineo will integrate with those systems over time.

## Product quality bar

Engineo is ready for professional use only when:
- calculations are deterministic and reproducible;
- large schedules remain responsive;
- material calculated dates can be explained;
- changes are auditable;
- import/export failures are explicit rather than silently lossy;
- users can export their data;
- AI output can be verified against deterministic project state.
