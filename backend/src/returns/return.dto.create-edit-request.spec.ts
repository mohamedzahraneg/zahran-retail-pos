/**
 * return.dto.create-edit-request.spec.ts — PR-FIX-EDIT-REQUEST-
 * PAYLOAD-WHITELIST.
 *
 * Pins that `CreateEditRequestDto` survives the global ValidationPipe
 * configured with `whitelist: true, transform: true` (see main.ts).
 *
 * The bug we're fixing: `requested_payload` had only `@ApiProperty`
 * (Swagger) and no class-validator decorator.  Under `whitelist:
 * true`, class-validator strips any property without a decorator
 * even when the property is declared on the class.  That left
 * `dto.requested_payload === undefined` at the controller boundary,
 * and the service's `validatePayload(undefined)` threw
 * "requested_payload يجب أن يكون كائنًا (JSON object)".
 *
 * The fix adds `@IsObject()` to the field.  These tests pin the
 * pipe + DTO contract so a regression can't silently strip the
 * field again.
 */
import { ValidationPipe } from '@nestjs/common';
import { CreateEditRequestDto } from './dto/return.dto';

const PIPE = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: false,
  transformOptions: { enableImplicitConversion: true },
});

const META = {
  type: CreateEditRequestDto,
  metatype: CreateEditRequestDto,
  data: '',
} as any;

const VALID_PAYLOAD = {
  kind: 'line_changes',
  lines: {
    updated: [
      {
        item_id: 'ri-1',
        before: { variant_id: 'v-1', sku: 'X', name: 'X', quantity: 1, unit_price: 10 },
        after: { variant_id: 'v-1', sku: 'X', name: 'X', quantity: 1, unit_price: 9 },
      },
    ],
    removed: [],
    added: [],
  },
  summary: { old_total: 10, new_total: 9, delta: -1 },
};

describe('CreateEditRequestDto — survives whitelist:true (PR-FIX-EDIT-REQUEST-PAYLOAD-WHITELIST)', () => {
  it('preserves requested_payload on a well-formed body', async () => {
    const out: any = await PIPE.transform(
      {
        requested_action: 'price_change',
        requested_payload: VALID_PAYLOAD,
        reason_text: 'العميل اعترض على السعر',
      },
      META,
    );
    expect(out).toBeInstanceOf(CreateEditRequestDto);
    expect(out.requested_action).toBe('price_change');
    // The CRITICAL check — the field is NOT stripped by the pipe.
    expect(out.requested_payload).toBeDefined();
    expect(typeof out.requested_payload).toBe('object');
    expect(out.requested_payload).not.toBeNull();
    expect(Array.isArray(out.requested_payload)).toBe(false);
    expect(out.requested_payload.kind).toBe('line_changes');
    expect(out.requested_payload.lines.updated).toHaveLength(1);
    expect(out.reason_text).toBe('العميل اعترض على السعر');
  });

  it('rejects when requested_payload is null', async () => {
    await expect(
      PIPE.transform(
        {
          requested_action: 'price_change',
          requested_payload: null,
          reason_text: 'سبب كافٍ للرفض',
        },
        META,
      ),
    ).rejects.toThrow();
  });

  it('rejects when requested_payload is missing', async () => {
    await expect(
      PIPE.transform(
        {
          requested_action: 'price_change',
          reason_text: 'سبب كافٍ للرفض',
        },
        META,
      ),
    ).rejects.toThrow();
  });

  it('rejects when requested_payload is a string (the wrong-type flavour)', async () => {
    await expect(
      PIPE.transform(
        {
          requested_action: 'price_change',
          requested_payload: '{"kind":"line_changes"}',
          reason_text: 'سبب كافٍ للرفض',
        },
        META,
      ),
    ).rejects.toThrow();
  });

  it('rejects when requested_action is not in the allowlist', async () => {
    await expect(
      PIPE.transform(
        {
          requested_action: 'inject_evil',
          requested_payload: VALID_PAYLOAD,
          reason_text: 'سبب كافٍ للرفض',
        },
        META,
      ),
    ).rejects.toThrow();
  });

  it('rejects when reason_text is shorter than 5 chars', async () => {
    await expect(
      PIPE.transform(
        {
          requested_action: 'price_change',
          requested_payload: VALID_PAYLOAD,
          reason_text: 'abc',
        },
        META,
      ),
    ).rejects.toThrow();
  });
});
