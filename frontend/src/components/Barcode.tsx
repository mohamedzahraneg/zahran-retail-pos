import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

interface BarcodeProps {
  value: string;
  format?: 'CODE128' | 'EAN13' | 'EAN8' | 'UPC' | 'CODE39';
  width?: number;
  height?: number;
  displayValue?: boolean;
  fontSize?: number;
  margin?: number;
  textMargin?: number;
  background?: string;
  lineColor?: string;
}

/**
 * Barcode — renders a barcode as SVG using JsBarcode.
 * Works in both screen view and print view.
 */
export function Barcode({
  value,
  format = 'CODE128',
  width = 2,
  height = 50,
  displayValue = true,
  fontSize = 14,
  margin = 4,
  textMargin = 2,
  background = '#ffffff',
  lineColor = '#000000',
}: BarcodeProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format,
        width,
        height,
        displayValue,
        fontSize,
        margin,
        textMargin,
        background,
        lineColor,
        font: 'monospace',
      });
    } catch (err) {
      // leave SVG empty on error (invalid code for format)
    }
  }, [
    value,
    format,
    width,
    height,
    displayValue,
    fontSize,
    margin,
    textMargin,
    background,
    lineColor,
  ]);

  return <svg ref={ref} />;
}
