/**
 * cartonMath — PR-PURCHASES-P1
 *
 * Pure helpers for the piece/carton purchase-line UI. The backend
 * `purchase_items` schema only stores `quantity` (pieces) and
 * `unit_cost` (per piece) — no carton columns exist today. These
 * helpers let the UI present the operator with a carton workflow
 * (cartons × pieces_per_carton + carton price) while sending the
 * backend the equivalent piece-level payload.
 *
 *   piece mode:
 *     total_pieces = quantity
 *     unit_piece_cost = unit_cost
 *     line_total = total_pieces × unit_piece_cost
 *
 *   carton mode:
 *     total_pieces = cartons × pieces_per_carton
 *     unit_piece_cost = carton_cost / pieces_per_carton
 *     line_total = cartons × carton_cost
 *
 * Both modes converge on `(total_pieces, unit_piece_cost, line_total)`
 * — exactly the three numbers the existing CreatePurchaseDto.items
 * payload needs to stay backward compatible.
 */

export type PurchaseUnit = 'piece' | 'carton';

export interface CartonInput {
  mode: PurchaseUnit;
  /** Used in piece mode. Always positive integer. */
  quantity?: number;
  /** Used in carton mode. */
  cartons?: number;
  /** Used in carton mode. Defaults to 1 (UI should require ≥1). */
  pieces_per_carton?: number;
  /** Per-piece purchase price (piece mode) or used as fallback. */
  unit_cost?: number;
  /** Per-carton purchase price (carton mode). */
  carton_cost?: number;
  /** Optional invoice-line discount in EGP (subtracted from line total). */
  discount?: number;
  /** Optional invoice-line tax in EGP (added to line total). */
  tax?: number;
}

export interface CartonResult {
  total_pieces: number;
  unit_piece_cost: number;
  carton_price: number;
  line_total: number;
}

const round2 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function computeLine(input: CartonInput): CartonResult {
  const discount = Math.max(0, Number(input.discount ?? 0));
  const tax = Math.max(0, Number(input.tax ?? 0));

  if (input.mode === 'carton') {
    const cartons = Math.max(0, Number(input.cartons ?? 0));
    const ppc = Math.max(1, Number(input.pieces_per_carton ?? 1));
    const cartonCost = Math.max(0, Number(input.carton_cost ?? 0));
    const totalPieces = cartons * ppc;
    const unitPieceCost = ppc > 0 ? round2(cartonCost / ppc) : 0;
    const lineTotal = round2(cartons * cartonCost - discount + tax);
    return {
      total_pieces: totalPieces,
      unit_piece_cost: unitPieceCost,
      carton_price: round2(cartonCost),
      line_total: lineTotal,
    };
  }

  // piece mode
  const qty = Math.max(0, Number(input.quantity ?? 0));
  const unitCost = Math.max(0, Number(input.unit_cost ?? 0));
  const cartonHint = Math.max(1, Number(input.pieces_per_carton ?? 1));
  const lineTotal = round2(qty * unitCost - discount + tax);
  return {
    total_pieces: qty,
    unit_piece_cost: round2(unitCost),
    carton_price: round2(unitCost * cartonHint),
    line_total: lineTotal,
  };
}

/**
 * Build the backend-shaped CreatePurchaseItemPayload from carton-aware
 * UI state. Always emits piece-level numbers (quantity + unit_cost) so
 * the existing API contract stays untouched.
 */
export function toBackendItem(input: CartonInput & { variant_id: string }) {
  const computed = computeLine(input);
  return {
    variant_id: input.variant_id,
    quantity: computed.total_pieces,
    unit_cost: computed.unit_piece_cost,
    discount: Math.max(0, Number(input.discount ?? 0)) || undefined,
    tax: Math.max(0, Number(input.tax ?? 0)) || undefined,
  };
}
