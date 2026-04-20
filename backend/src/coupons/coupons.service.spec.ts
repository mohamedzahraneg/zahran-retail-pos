import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CouponsService } from './coupons.service';

describe('CouponsService.validate', () => {
  let service: CouponsService;
  let ds: { query: jest.Mock };

  const baseCoupon = {
    id: 'c1',
    code: 'SAVE10',
    name_ar: 'خصم 10٪',
    coupon_type: 'percentage',
    value: 10,
    max_discount_amount: null,
    is_active: true,
    starts_at: null,
    expires_at: null,
    max_uses_total: null,
    uses_count: 0,
    max_uses_per_customer: 1,
    min_order_value: 0,
  };

  beforeEach(async () => {
    ds = { query: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CouponsService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();
    service = moduleRef.get(CouponsService);
  });

  it('throws when coupon does not exist', async () => {
    ds.query.mockResolvedValueOnce([]);
    await expect(
      service.validate({ code: 'NOPE', subtotal: 100 } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws when coupon is inactive', async () => {
    ds.query.mockResolvedValueOnce([{ ...baseCoupon, is_active: false }]);
    await expect(
      service.validate({ code: 'SAVE10', subtotal: 100 } as any),
    ).rejects.toThrow('الكوبون غير مفعل');
  });

  it('throws when coupon has not started yet', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    ds.query.mockResolvedValueOnce([{ ...baseCoupon, starts_at: future }]);
    await expect(
      service.validate({ code: 'SAVE10', subtotal: 100 } as any),
    ).rejects.toThrow('لم يبدأ');
  });

  it('throws when coupon expired', async () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    ds.query.mockResolvedValueOnce([{ ...baseCoupon, expires_at: past }]);
    await expect(
      service.validate({ code: 'SAVE10', subtotal: 100 } as any),
    ).rejects.toThrow('منتهي');
  });

  it('throws when max uses total reached', async () => {
    ds.query.mockResolvedValueOnce([
      { ...baseCoupon, max_uses_total: 5, uses_count: 5 },
    ]);
    await expect(
      service.validate({ code: 'SAVE10', subtotal: 100 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when subtotal below min_order_value', async () => {
    ds.query.mockResolvedValueOnce([
      { ...baseCoupon, min_order_value: 200 },
    ]);
    await expect(
      service.validate({ code: 'SAVE10', subtotal: 100 } as any),
    ).rejects.toThrow('الحد الأدنى');
  });

  it('computes percentage discount on subtotal', async () => {
    ds.query.mockResolvedValueOnce([baseCoupon]);
    const res = await service.validate({
      code: 'SAVE10',
      subtotal: 250,
    } as any);
    expect(res.discount_amount).toBeCloseTo(25, 2);
  });

  it('caps percentage discount at max_discount_amount', async () => {
    ds.query.mockResolvedValueOnce([
      { ...baseCoupon, value: 50, max_discount_amount: 30 },
    ]);
    const res = await service.validate({
      code: 'SAVE10',
      subtotal: 200,
    } as any);
    // 50% of 200 = 100, but capped at 30
    expect(res.discount_amount).toBe(30);
  });

  it('returns fixed value for fixed_amount coupons', async () => {
    ds.query.mockResolvedValueOnce([
      { ...baseCoupon, coupon_type: 'fixed_amount', value: 50 },
    ]);
    const res = await service.validate({
      code: 'SAVE10',
      subtotal: 200,
    } as any);
    expect(res.discount_amount).toBe(50);
  });

  it('caps discount at subtotal', async () => {
    ds.query.mockResolvedValueOnce([
      { ...baseCoupon, coupon_type: 'fixed_amount', value: 500 },
    ]);
    const res = await service.validate({
      code: 'SAVE10',
      subtotal: 100,
    } as any);
    expect(res.discount_amount).toBe(100);
  });

  it('checks per-customer usage when customer_id provided', async () => {
    ds.query
      .mockResolvedValueOnce([baseCoupon])
      .mockResolvedValueOnce([{ cnt: 1 }]); // already used
    await expect(
      service.validate({
        code: 'SAVE10',
        subtotal: 100,
        customer_id: 'cust-1',
      } as any),
    ).rejects.toThrow('استنفد');
  });
});
