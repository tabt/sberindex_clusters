/** Цвета для canvas берём из тех же CSS-переменных, что и для разметки:
 *  одно место определяет светлую и тёмную тему. */

export interface Palette {
  surface: string;
  edge: string;
  ring: string;
  text: string;
  series: string[];
}

function value(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function readPalette(): Palette {
  return {
    surface: value('--surface-raised'),
    edge: value('--edge'),
    ring: value('--node-ring'),
    text: value('--text-primary'),
    series: [1, 2, 3, 4].map((i) => value(`--series-${i}`)),
  };
}

/** Цвет типа. Больше четырёх типов палитра не предусматривает, поэтому
 *  лишние получают нейтральный серый, а не случайный новый оттенок. */
export function typeColor(palette: Palette, type: number): string {
  return palette.series[type] ?? palette.edge;
}

/** Перерисовка при смене системной темы. */
export function onThemeChange(callback: () => void): void {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', callback);
}
