# Payment provider logos (PR-PAY-6)

Local SVG assets used by `PaymentProviderLogo` to render the brand badge for each payment method/account across:

- Settings → حسابات التحصيل (admin)
- POS payment grid + account picker
- Shift-close payment cards
- Owner dashboard payment channel chips
- Receipt (small inline)

## Filename = logo_key

The backend provider catalog (`backend/src/payments/providers.catalog.ts`) and the runtime `payment_account_snapshot` both reference each asset by its **logo_key**, which is the filename without extension:

```
vodafone-cash.svg → logo_key = "vodafone-cash"
we-pay.svg        → logo_key = "we-pay"
visa.svg          → logo_key = "visa"
nbe.svg           → logo_key = "nbe"
```

The frontend resolver `frontend/src/lib/paymentLogos.ts` maps each `logo_key` to its bundled asset via `import` so the URL is hashed by Vite at build time.

## Replacing a placeholder with the real logo

This PR ships **placeholder SVGs** for every provider — solid brand colour + initials. They render cleanly in every UI surface and are visually distinguishable.

To swap any placeholder for the official asset:

1. Drop the official PNG/SVG into this directory **using the exact same filename**.
2. The frontend picks it up on the next build — **no code change required**.
3. Optionally `git mv` to a different extension (`vodafone-cash.png` etc.) and update the import in `paymentLogos.ts` (a one-line change per logo).

If you want to keep the placeholder until the official asset is licensed, leave the file as-is — the UI stays consistent.

## Current placeholder inventory (22 files)

| File | logo_key | Used by | Status |
|---|---|---|---|
| `cash.svg` | cash | cash payment method | placeholder |
| `instapay.svg` | instapay | InstaPay provider | placeholder — operator has the official logo |
| `vodafone-cash.svg` | vodafone-cash | Vodafone Cash wallet | placeholder — operator has the official logo |
| `orange-cash.svg` | orange-cash | Orange Cash wallet | placeholder — operator has the official logo |
| `etisalat-cash.svg` | etisalat-cash | Etisalat Cash wallet | placeholder — operator has the official logo |
| `we-pay.svg` | we-pay | WE Pay wallet | placeholder |
| `bank-wallet.svg` | bank-wallet | generic bank wallet | placeholder |
| `wallet-other.svg` | wallet-other | unknown wallet fallback | placeholder |
| `visa.svg` | visa | Visa cards | placeholder — operator has the official logo |
| `mastercard.svg` | mastercard | MasterCard | placeholder |
| `meeza.svg` | meeza | Meeza national scheme | placeholder |
| `pos-terminal.svg` | pos-terminal | generic POS terminal | placeholder |
| `card-other.svg` | card-other | unknown card fallback | placeholder |
| `nbe.svg` | nbe | National Bank of Egypt | placeholder |
| `banque-misr.svg` | banque-misr | Banque Misr | placeholder |
| `cib.svg` | cib | CIB | placeholder |
| `qnb.svg` | qnb | QNB Al-Ahli | placeholder |
| `alexbank.svg` | alexbank | AlexBank | placeholder |
| `banque-du-caire.svg` | banque-du-caire | Banque du Caire | placeholder |
| `aaib.svg` | aaib | AAIB | placeholder |
| `adib.svg` | adib | ADIB | placeholder |
| `bank-other.svg` | bank-other | unknown bank fallback | placeholder |

## Why placeholders, not hotlinks

- **No external URLs** — every asset is bundled, so the UI works offline (the POS runs offline regularly).
- **No copyright risk** — placeholders are first-party SVGs with brand colours + initials only. No copied marks.
- **No drive-by image downloads** — the operator decides which official assets to add and licenses them themselves.
- **Frame-perfect swap** — same filename = zero code change to upgrade.
