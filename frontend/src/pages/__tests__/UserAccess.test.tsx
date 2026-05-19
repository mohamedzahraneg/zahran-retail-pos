/**
 * UserAccess.test.tsx — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Smoke + behavior tests for the per-user access page:
 *   · Page renders both panels with the right counts.
 *   · Save calls accessApi.updateUserAccess with the selected rows
 *     and the chosen defaults.
 *   · Source-level guard: page does NOT import any stock-mutating
 *     client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  getUserAccess: vi.fn(),
  updateUserAccess: vi.fn(),
  listBranches: vi.fn(),
  listWarehouses: vi.fn(),
}));

vi.mock('@/api/access.api', async () => {
  const actual = await vi.importActual<any>('@/api/access.api');
  return {
    ...actual,
    accessApi: {
      getMyAccess: vi.fn(),
      getUserAccess: (...a: any[]) => mocks.getUserAccess(...a),
      updateUserAccess: (...a: any[]) => mocks.updateUserAccess(...a),
    },
  };
});

vi.mock('@/api/branches.api', async () => {
  const actual = await vi.importActual<any>('@/api/branches.api');
  return {
    ...actual,
    branchesApi: {
      list: (...a: any[]) => mocks.listBranches(...a),
    },
  };
});

vi.mock('@/api/settings.api', () => ({
  settingsApi: {
    listWarehouses: (...a: any[]) => mocks.listWarehouses(...a),
  },
}));

import UserAccess from '../UserAccess';

const USER = '11111111-1111-1111-1111-111111111111';
const BRANCH_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const BRANCH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const WH_A = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const WH_B = 'cccccccc-cccc-cccc-cccc-cccccccccc02';

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as any).mockReset?.();
  mocks.listBranches.mockResolvedValue([
    { id: BRANCH_A, code: 'CAI-01', name_ar: 'فرع القاهرة', is_active: true },
    { id: BRANCH_B, code: 'ALX-01', name_ar: 'فرع الإسكندرية', is_active: true },
  ] as any);
  mocks.listWarehouses.mockResolvedValue([
    { id: WH_A, code: 'WH-A', name_ar: 'الرئيسي', is_active: true },
    { id: WH_B, code: 'WH-B', name_ar: 'الفرع 2', is_active: true },
  ] as any);
  mocks.getUserAccess.mockResolvedValue({
    user_id: USER,
    branches: [
      {
        user_id: USER,
        branch_id: BRANCH_A,
        access_level: 'view',
        is_default: true,
      },
    ],
    warehouses: [
      {
        user_id: USER,
        warehouse_id: WH_A,
        access_level: 'operate',
        is_default: true,
      },
    ],
    default_branch_id: BRANCH_A,
    default_warehouse_id: WH_A,
  } as any);
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/users/${USER}/access`]}>
        <Routes>
          <Route path="/users/:id/access" element={<UserAccess />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<UserAccess />', () => {
  it('renders branches and warehouses panels populated from the API', async () => {
    renderPage();
    await screen.findByTestId('user-access-page');
    const branches = await screen.findByTestId('access-branches');
    const warehouses = await screen.findByTestId('access-warehouses');
    expect(within(branches).getAllByTestId('access-branches-row')).toHaveLength(2);
    expect(within(warehouses).getAllByTestId('access-warehouses-row')).toHaveLength(2);

    // BRANCH_A is pre-selected from the API payload.
    const branchAToggle = (await screen.findByTestId(
      `access-branches-toggle-${BRANCH_A}`,
    )) as HTMLInputElement;
    expect(branchAToggle.checked).toBe(true);
  });

  it('save posts the selected branches + warehouses + defaults', async () => {
    mocks.updateUserAccess.mockResolvedValue({});
    renderPage();
    await screen.findByTestId('user-access-page');

    // Add BRANCH_B
    const branchBToggle = await screen.findByTestId(
      `access-branches-toggle-${BRANCH_B}`,
    );
    fireEvent.click(branchBToggle);
    // Add WH_B
    const whBToggle = await screen.findByTestId(
      `access-warehouses-toggle-${WH_B}`,
    );
    fireEvent.click(whBToggle);

    fireEvent.click(screen.getByTestId('user-access-save'));

    await waitFor(() => {
      expect(mocks.updateUserAccess).toHaveBeenCalledTimes(1);
    });
    const [userId, payload] = mocks.updateUserAccess.mock.calls[0];
    expect(userId).toBe(USER);
    expect(payload.branch_access).toHaveLength(2);
    expect(payload.warehouse_access).toHaveLength(2);
    expect(payload.default_branch_id).toBe(BRANCH_A);
    expect(payload.default_warehouse_id).toBe(WH_A);
  });

  it('un-checking the default branch clears default_branch_id', async () => {
    mocks.updateUserAccess.mockResolvedValue({});
    renderPage();
    await screen.findByTestId('user-access-page');

    const branchAToggle = await screen.findByTestId(
      `access-branches-toggle-${BRANCH_A}`,
    );
    fireEvent.click(branchAToggle); // un-check the only allowed branch

    fireEvent.click(screen.getByTestId('user-access-save'));
    await waitFor(() => {
      expect(mocks.updateUserAccess).toHaveBeenCalled();
    });
    const [, payload] = mocks.updateUserAccess.mock.calls[0];
    expect(payload.branch_access).toHaveLength(0);
    expect(payload.default_branch_id).toBeNull();
  });
});

describe('<UserAccess /> — read-only invariant (source-level)', () => {
  const RAW = readFileSync(
    `${process.cwd()}/src/pages/UserAccess.tsx`,
    'utf8',
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('does NOT import any stock / inventory / cashbox mutation client', () => {
    expect(SRC).not.toMatch(/@\/api\/stock\.api/);
    expect(SRC).not.toMatch(/@\/api\/stock-transfers\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory-counts\.api/);
    expect(SRC).not.toMatch(/@\/api\/inventory\.api/);
    expect(SRC).not.toMatch(/stockApi\b/);
    expect(SRC).not.toMatch(/inventoryApi\b/);
    expect(SRC).not.toMatch(/cashboxApi\b/);
  });
});
