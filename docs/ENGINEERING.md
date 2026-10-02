# Engineo Engineering Principles

## 1. Correctness is a product feature

Engineo will influence expensive real-world decisions. Schedule and cost calculations must be reviewable, reproducible, and testable.

## 2. Deterministic core, probabilistic edge

AI can interpret intent and explain results. It cannot be the source of authoritative schedule or cost mathematics.

## 3. Tests are executable specifications

For scheduling semantics, tests define behavior more precisely than prose. Every bug in the calculation engine should become a regression fixture.

## 4. External formats are adapters

Interchange formats may be important for adoption, but they do not dictate Engineo's canonical domain model.

## 5. Preserve user ownership

Projects must be exportable. APIs should be documented. Avoid architecture whose business value depends on trapping data.

## 6. Prefer explicit state

Scheduling options, calendar policies, constraints, progress rules, rounding, units, and timezones must be explicit. Hidden defaults create project-controls bugs.

## 7. Audit material change

A user should be able to answer:
- who changed this?
- when?
- from what?
- to what?
- through which source or automation?
- what schedule result changed because of it?

## 8. Scenarios before destructive automation

Optimization and AI recommendations operate in isolated scenarios first. Applying a scenario to authoritative project state is an explicit action.

## 9. Performance has fixtures

We benchmark representative project sizes and relationship densities. "Feels fast" is not a performance requirement.

## 10. Security belongs in the domain

Authorization is server-enforced. Tenant/project boundaries are tested. Audit data is append-oriented. Secrets never enter project exports.

## Repository conventions

Planned monorepo shape:

```text
apps/
  web/
  api/

crates/
  scheduling/
  calendar/
  project-model/

packages/
  contracts/
  ui/

docs/
  adr/
  specs/

fixtures/
  schedules/
  imports/
```

The exact structure may evolve through ADRs.

## Pull request quality

A PR changing project-control behavior should include:
- behavior description;
- tests;
- edge cases;
- migration/interoperability impact if any;
- benchmark impact for hot paths.

## Definition of done for calculation code

- typed inputs and outputs;
- validation;
- deterministic result;
- unit tests;
- property/golden tests where applicable;
- documented semantics;
- no dependency on UI/database/LLM;
- performance checked when on a hot path.
