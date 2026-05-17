/**
 * PricingSuggestions.test.tsx — PR-PURCHASES-P3.1
 *
 * Pins the presentational contract of <PricingSuggestions />. Renders
 * the result of `suggestPrices()` and proves:
 *   · the four Arabic strategy cards render
 *   · the markup-vs-margin clarifying example is on screen
 *   · below-cost / below-min-margin warnings surface correctly
 *   · click handlers fire ONLY the local onApply callback
 *   · applied marker reflects the selected strategy
 *   · component never makes API calls (no fetch / axios import)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PricingSuggestions } from '../PricingSuggestions';
import { suggestPrices } from '../pricingMath';

function makeResult(input: {
  cost: number;
  currentSellingPrice?: number;
  minMarginPct?: number;
}) {
  return suggestPrices(input);
}

describe('PricingSuggestions — base render', () => {
  it('renders the four Arabic strategy cards', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100, currentSellingPrice: 130 })}
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('pricing-card-competitive')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-card-recommended')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-card-high_margin')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-card-wholesale')).toBeInTheDocument();
    // Arabic labels visible
    expect(screen.getByText('اقتصادي / منافس')).toBeInTheDocument();
    expect(screen.getByText('موصى به')).toBeInTheDocument();
    expect(screen.getByText('هامش عالي')).toBeInTheDocument();
    expect(screen.getByText('جملة')).toBeInTheDocument();
  });

  it('renders the markup-vs-margin clarifying example', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100 })}
        onApply={() => {}}
      />,
    );
    const explanation = screen.getByTestId('pricing-markup-margin-explanation');
    expect(explanation).toHaveTextContent('Markup');
    expect(explanation).toHaveTextContent('Margin');
    expect(explanation).toHaveTextContent('30%');
    expect(explanation).toHaveTextContent('23%');
  });
});

describe('PricingSuggestions — warnings', () => {
  it('shows below-cost warning when current sale price < landed cost', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100, currentSellingPrice: 80 })}
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('pricing-below-cost-warning')).toBeInTheDocument();
    expect(
      screen.queryByTestId('pricing-below-min-margin-warning'),
    ).toBeNull();
  });

  it('shows below-min-margin warning when current margin < threshold', () => {
    render(
      <PricingSuggestions
        result={makeResult({
          cost: 100,
          currentSellingPrice: 110,
          minMarginPct: 15,
        })}
        onApply={() => {}}
      />,
    );
    expect(
      screen.queryByTestId('pricing-below-cost-warning'),
    ).toBeNull();
    expect(
      screen.getByTestId('pricing-below-min-margin-warning'),
    ).toBeInTheDocument();
  });
});

describe('PricingSuggestions — local-only behavior', () => {
  it('clicking "استخدام هذا السعر" calls onApply with the suggestion (no API)', () => {
    const onApply = vi.fn();
    // Guard: assert no fetch/axios call leaks during the interaction.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.reject(new Error('no network expected in P3.1')),
    );
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100 })}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByTestId('pricing-apply-recommended'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({
      strategy: 'recommended',
      price: 145,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('renders the "selected locally" marker', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100 })}
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('pricing-local-marker')).toHaveTextContent(
      'سعر مقترح محدد محليًا فقط',
    );
    expect(screen.getByTestId('pricing-local-marker')).toHaveTextContent(
      'لن يتم تحديث سعر البيع في هذه المرحلة',
    );
  });

  it('shows the applied badge on the active strategy', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 100 })}
        appliedStrategy="high_margin"
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('pricing-applied-high_margin')).toHaveTextContent(
      'محدد',
    );
    expect(screen.queryByTestId('pricing-applied-recommended')).toBeNull();
  });
});

describe('PricingSuggestions — unknown cost', () => {
  it('shows the neutral "enter cost first" message when cost <= 0', () => {
    render(
      <PricingSuggestions
        result={makeResult({ cost: 0 })}
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId('pricing-unknown-cost')).toBeInTheDocument();
    expect(screen.queryByTestId('pricing-card-competitive')).toBeNull();
  });
});
