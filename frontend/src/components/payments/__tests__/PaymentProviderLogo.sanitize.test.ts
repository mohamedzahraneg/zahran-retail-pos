import { describe, it, expect } from 'vitest';
import { sanitizeImgSrc } from '../PaymentProviderLogo';

/**
 * PR-PAY-7 (Option C) — `<img src>` allow-list is intentionally
 * narrow. NO external HTTP(S) URLs. NO hotlinks. Logos must come
 * from one of two trusted sources:
 *
 *   1. Vite-bundled relative URLs (`/assets/...`).
 *   2. Operator-uploaded raster image files, encoded as
 *      `data:image/(png|jpe?g|webp);base64,...`.
 *
 * Anything else — javascript:, vbscript:, file:, http:, https:,
 * blob:, data:image/svg+xml, data:text/html, data:application/*,
 * protocol-relative `//host/...`, malformed strings — is rejected
 * outright. The consumer falls through to the initials avatar.
 */

describe('sanitizeImgSrc — accept', () => {
  it('accepts Vite-bundled relative URLs', () => {
    expect(sanitizeImgSrc('/assets/logo.svg'))
      .toBe('/assets/logo.svg');
    expect(sanitizeImgSrc('/payment-logos/instapay-abc123.svg'))
      .toBe('/payment-logos/instapay-abc123.svg');
  });

  it('accepts data URLs for png/jpeg/webp (raster only)', () => {
    expect(sanitizeImgSrc('data:image/png;base64,iVBORw0KGgo='))
      .toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(sanitizeImgSrc('data:image/jpeg;base64,/9j/4AAQ='))
      .toBe('data:image/jpeg;base64,/9j/4AAQ=');
    expect(sanitizeImgSrc('data:image/jpg;base64,/9j/4AAQ='))
      .toBe('data:image/jpg;base64,/9j/4AAQ=');
    expect(sanitizeImgSrc('data:image/webp;base64,UklGRg=='))
      .toBe('data:image/webp;base64,UklGRg==');
  });

  it('trims surrounding whitespace before validation', () => {
    expect(sanitizeImgSrc('  /assets/logo.svg  '))
      .toBe('/assets/logo.svg');
  });
});

describe('sanitizeImgSrc — reject (XSS surface + Option-C policy)', () => {
  it('rejects external https URLs (no hotlinks per Option C)', () => {
    expect(sanitizeImgSrc('https://example.com/logo.png')).toBeNull();
    expect(sanitizeImgSrc('https://attacker.com/x.svg')).toBeNull();
  });

  it('rejects external http URLs', () => {
    expect(sanitizeImgSrc('http://example.com/logo.png')).toBeNull();
  });

  it('rejects javascript: pseudo-protocol', () => {
    expect(sanitizeImgSrc('javascript:alert(1)')).toBeNull();
    expect(sanitizeImgSrc('JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects vbscript:', () => {
    expect(sanitizeImgSrc('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects file:', () => {
    expect(sanitizeImgSrc('file:///etc/passwd')).toBeNull();
  });

  it('rejects data:text/html', () => {
    expect(
      sanitizeImgSrc('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='),
    ).toBeNull();
  });

  it('rejects data:image/svg+xml (SVG is reserved for the bundled catalog)', () => {
    expect(
      sanitizeImgSrc(
        'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
      ),
    ).toBeNull();
    expect(
      sanitizeImgSrc('data:image/svg+xml;utf8,<svg onload=alert(1)></svg>'),
    ).toBeNull();
  });

  it('rejects data:application/javascript', () => {
    expect(
      sanitizeImgSrc('data:application/javascript;base64,YWxlcnQoMSk='),
    ).toBeNull();
  });

  it('rejects data: URLs without base64 (URL-encoded payload)', () => {
    expect(sanitizeImgSrc('data:image/png,raw-bytes-here')).toBeNull();
  });

  it('rejects data:image/gif (GIF is allowed for upload but not rendered until catalog adds it)', () => {
    // Future-proofing: GIF is accepted by LogoPicker upload but
    // currently not in the sanitizer allow-list. If the catalog
    // ever needs GIF, update both sides.
    expect(sanitizeImgSrc('data:image/gif;base64,R0lGOD==')).toBeNull();
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(sanitizeImgSrc('//evil.com/x.png')).toBeNull();
  });

  it('rejects ftp / mailto / tel', () => {
    expect(sanitizeImgSrc('ftp://example.com/logo.png')).toBeNull();
    expect(sanitizeImgSrc('mailto:a@b.com')).toBeNull();
    expect(sanitizeImgSrc('tel:+201000000000')).toBeNull();
  });

  it('rejects blob: (we never produce blob URLs in this flow)', () => {
    expect(sanitizeImgSrc('blob:https://example.com/uuid-1234')).toBeNull();
  });

  it('rejects empty / whitespace-only / null / undefined', () => {
    expect(sanitizeImgSrc('')).toBeNull();
    expect(sanitizeImgSrc('   ')).toBeNull();
    expect(sanitizeImgSrc(null)).toBeNull();
    expect(sanitizeImgSrc(undefined)).toBeNull();
  });

  it('rejects malformed strings', () => {
    expect(sanitizeImgSrc('not-a-url')).toBeNull();
    expect(sanitizeImgSrc('http://')).toBeNull();
  });
});
