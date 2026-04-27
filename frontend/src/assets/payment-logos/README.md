# Payment provider logos (PR-PAY-6)

Local assets used by `PaymentProviderLogo` to render the brand badge for each payment method/account across:

- Settings → حسابات التحصيل (admin)
- POS payment grid + account picker
- Shift-close payment cards
- Owner dashboard payment channel chips
- Receipt (small inline)

## Filename = logo_key

The backend provider catalog (`backend/src/payments/providers.catalog.ts`) and the runtime `payment_account_snapshot` both reference each asset by its **`logo_key`**, which is the filename without extension:

```
vodafone-cash.svg → logo_key = "vodafone-cash"
we-pay.png        → logo_key = "we-pay"
visa.svg          → logo_key = "visa"
nbe.svg           → logo_key = "nbe"
```

The frontend resolver `frontend/src/lib/paymentLogos.ts` discovers every file in this directory at build time via Vite's `import.meta.glob` and maps `logo_key → asset URL`.

## Supported extensions

| Extension | Notes |
|---|---|
| `svg` | First-party placeholders (current PR ships these) |
| `png` | Recommended for raster brand assets — has higher priority than `svg` |
| `jpg` / `jpeg` | Supported but PNG is preferred for transparency |
| `webp` | Supported, second priority after PNG |

## Drop-in priority (real asset wins automatically)

When **multiple files share the same `logo_key`** (e.g. both `vodafone-cash.svg` placeholder and `vodafone-cash.png` real asset exist), the resolver picks one based on this priority:

```
PNG  > WEBP  > JPG/JPEG  > SVG
```

So the workflow is:

1. Drop your real `vodafone-cash.png` (or `.webp`) into this directory.
2. Leave the placeholder `vodafone-cash.svg` in place if you want — the PNG wins automatically.
3. Run a build (`npx vite build` or just `npm run dev`).
4. Done — the real logo renders everywhere.

**No code change required.** Vite re-discovers the directory on every build.

## Where to drop your real logos

Replace any of the following placeholders by adding a file with the same `logo_key` and a higher-priority extension:

| logo_key | placeholder ext | drop-in path |
|---|---|---|
| `cash` | svg | `frontend/src/assets/payment-logos/cash.{png,webp,jpg,svg}` |
| `instapay` | svg | `frontend/src/assets/payment-logos/instapay.{png,webp,jpg,svg}` |
| `vodafone-cash` | svg | `frontend/src/assets/payment-logos/vodafone-cash.{png,webp,jpg,svg}` |
| `orange-cash` | svg | `frontend/src/assets/payment-logos/orange-cash.{png,webp,jpg,svg}` |
| `etisalat-cash` | svg | `frontend/src/assets/payment-logos/etisalat-cash.{png,webp,jpg,svg}` |
| `we-pay` | svg | `frontend/src/assets/payment-logos/we-pay.{png,webp,jpg,svg}` |
| `bank-wallet` | svg | `frontend/src/assets/payment-logos/bank-wallet.{png,webp,jpg,svg}` |
| `wallet-other` | svg | `frontend/src/assets/payment-logos/wallet-other.{png,webp,jpg,svg}` |
| `visa` | svg | `frontend/src/assets/payment-logos/visa.{png,webp,jpg,svg}` |
| `mastercard` | svg | `frontend/src/assets/payment-logos/mastercard.{png,webp,jpg,svg}` |
| `meeza` | svg | `frontend/src/assets/payment-logos/meeza.{png,webp,jpg,svg}` |
| `pos-terminal` | svg | `frontend/src/assets/payment-logos/pos-terminal.{png,webp,jpg,svg}` |
| `card-other` | svg | `frontend/src/assets/payment-logos/card-other.{png,webp,jpg,svg}` |
| `nbe` | svg | `frontend/src/assets/payment-logos/nbe.{png,webp,jpg,svg}` |
| `banque-misr` | svg | `frontend/src/assets/payment-logos/banque-misr.{png,webp,jpg,svg}` |
| `cib` | svg | `frontend/src/assets/payment-logos/cib.{png,webp,jpg,svg}` |
| `qnb` | svg | `frontend/src/assets/payment-logos/qnb.{png,webp,jpg,svg}` |
| `alexbank` | svg | `frontend/src/assets/payment-logos/alexbank.{png,webp,jpg,svg}` |
| `banque-du-caire` | svg | `frontend/src/assets/payment-logos/banque-du-caire.{png,webp,jpg,svg}` |
| `aaib` | svg | `frontend/src/assets/payment-logos/aaib.{png,webp,jpg,svg}` |
| `adib` | svg | `frontend/src/assets/payment-logos/adib.{png,webp,jpg,svg}` |
| `bank-other` | svg | `frontend/src/assets/payment-logos/bank-other.{png,webp,jpg,svg}` |

## Current placeholder inventory

**As of this PR every entry below is a first-party SVG placeholder** (solid brand colour + initials). The operator will replace selected ones with the real attached PNGs after this PR merges.

The 5 logos the operator confirmed they have on hand (and plans to drop in next):

| logo_key | source |
|---|---|
| `instapay` | operator-provided PNG, will be dropped in |
| `vodafone-cash` | operator-provided PNG, will be dropped in |
| `orange-cash` | operator-provided PNG, will be dropped in |
| `etisalat-cash` | operator-provided PNG, will be dropped in |
| `visa` | operator-provided PNG, will be dropped in |

Everything else (banks, MasterCard, Meeza, POS terminal, generic wallet/card/bank fallbacks) stays as a placeholder until the operator sources licensed assets.

## Why placeholders, not hotlinks

- **No external URLs** — every asset is bundled, so the UI works offline (the POS runs offline regularly).
- **No copyright risk** — placeholders are first-party SVGs with brand colours + initials only. No copied marks.
- **No drive-by image downloads** — the operator decides which official assets to add and licenses them themselves.
- **Frame-perfect swap** — same `logo_key` + higher-priority extension = zero code change to upgrade.
