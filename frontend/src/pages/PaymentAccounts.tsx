/**
 * PaymentAccounts — PR-FIN-PAYACCT-4D
 * ───────────────────────────────────────────────────────────────────
 *
 * The dedicated /payment-accounts admin page shipped in PR-4B has been
 * folded into the unified treasury experience at /cashboxes
 * ("الخزائن والحسابات البنكية"). This component is now a permanent
 * redirect so existing bookmarks, training docs, and the Settings tab
 * link continue to work.
 *
 * The page work itself (dense table, KPIs, alerts panel, modal) was
 * NOT discarded — it lives inside Cashboxes.tsx as panels and reuses
 * PaymentAccountModal / PaymentAccountAlerts / PaymentProviderLogo
 * verbatim.
 */
import { Navigate } from 'react-router-dom';

export default function PaymentAccounts() {
  return <Navigate to="/cashboxes" replace />;
}
