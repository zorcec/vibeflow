import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/client/shared/renderMarkdown.js';

describe('renderMarkdown', () => {
  it('renders markdown tables into HTML table markup', () => {
    const html = renderMarkdown([
      '| Name | Value |',
      '| --- | --- |',
      '| Port | 3700 |',
      '| Mode | API-only |',
    ].join('\n'));

    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('Port');
    expect(html).toContain('API-only');
  });
});
