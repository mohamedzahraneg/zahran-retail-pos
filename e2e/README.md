# Zahran — End-to-End Tests (Playwright)

These tests exercise the full stack (backend + frontend) from a real browser.

## Prerequisites

- PostgreSQL running and migrated
- `.env` in `backend/` pointing at the DB
- Ports 3000 (API) and 5173 (frontend) free
- Seed data loaded (so the catalog actually contains products)

## Install

```bash
cd e2e
npm install
npx playwright install --with-deps
```

## Run

In dev, Playwright will boot both backend (`npm run start:dev`) and
frontend (`npm run dev`) for you via `webServer:`

```bash
npm test           # headless
npm run test:headed
npm run test:ui
```

In CI, bring the stack up yourself and set `CI=1`:

```bash
CI=1 BASE_URL=http://app.local API_URL=http://app.local npm test
```

## Env vars

| Var        | Default                | Purpose                     |
| ---------- | ---------------------- | --------------------------- |
| BASE_URL   | http://localhost:5173  | Frontend root               |
| API_URL    | http://localhost:3000  | Backend root                |
| ADMIN_USER | admin                  | Seed admin username         |
| ADMIN_PASS | admin123               | Seed admin password         |

## Adding tests

- New tests go in `tests/*.spec.ts`
- Reuse the `login()` fixture from `fixtures/auth.ts`
- Prefer accessible locators (`getByRole`, `getByLabel`) — they're RTL-safe
- Keep tests sequential unless they clean up after themselves
  (retail flows touch real stock)
