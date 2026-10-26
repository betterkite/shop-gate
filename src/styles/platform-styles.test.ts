import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { expect, it } from 'vitest';
import config from '../../tailwind.config';

it('keeps file-button styles valid when uploads and legacy platform cards appear together', async () => {
  const file = path.join(process.cwd(), 'src/app/globals.css');
  const generated = await postcss([tailwindcss({ ...config, content: [{ extension: 'html', raw:
    '<main class="platform-content"><div class="bg-white rounded-lg"></div><input type="file" class="file:rounded-lg file:bg-primary file:px-3"></main>',
  }] })]).process(await readFile(file, 'utf8'), { from: file });
  const selectors: string[] = [];
  generated.root.walkRules((rule) => { selectors.push(rule.selector); });
  // The original compound component rule generated ::file-selector-button twice,
  // rejected by the normal Next dev CSS compiler before even the login could open.
  expect(selectors.some((selector) => selector.includes('::file-selector-button'))).toBe(true);
  expect(selectors.filter((selector) => /::file-selector-button[^,{]*::file-selector-button/.test(selector))).toEqual([]);
  const cardRules = generated.root.nodes.filter((node) => node.type === 'rule'
    && node.selector.includes('.platform-content') && node.toString().includes('box-shadow'));
  expect(cardRules.length).toBeGreaterThan(0);
});
