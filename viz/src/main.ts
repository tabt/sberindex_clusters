import './style.css';

import { buildNeighbors, loadNetwork, type Network } from './data';
import { draw, resizeCanvas, type Scene } from './render';
import { onThemeChange, readPalette, typeColor } from './theme';
import { centerOn, easeInOut, interpolate, newCamera, nodeAt, zoomAt } from './view';

const MODES = [
  {
    id: 'graph' as const,
    label: 'Сеть',
    caption: 'МО тем ближе друг к другу, чем они экономически похожи.',
  },
  {
    id: 'geo' as const,
    label: 'География',
    caption:
      'Те же МО и те же связи на карте. Чем больше связей тянется через всю страну, ' +
      'тем меньше тип локальной экономики определяется расположением.',
  },
];

const TRANSITION_MS = 900;
const MAX_SUGGESTIONS = 8;
// Сколько соседей перечислять в подсказке: у самых связных МО их несколько
// десятков, и полный список закрыл бы половину полотна
const MAX_NEIGHBORS = 10;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Нет элемента #${id}`);
  return node as T;
}

function plural(value: number, forms: [string, string, string]): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function thousands(value: number): string {
  return value.toLocaleString('ru-RU');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function start(network: Network): void {
  const canvas = element<HTMLCanvasElement>('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas не поддерживается');

  const tooltip = element('tooltip');

  // Стартовый вид силовой раскладки: приблизить и сдвинуть влево.
  // panX в пикселях, отрицательное значение двигает картинку влево
  const GRAPH_START_ZOOM = 4;
  const GRAPH_START_PAN_X = -300;
  const GRAPH_START_PAN_Y = -250;

  const camera = newCamera();
  camera.zoom = GRAPH_START_ZOOM;
  camera.panX = GRAPH_START_PAN_X;
  camera.panY = GRAPH_START_PAN_Y;

  const neighbors = buildNeighbors(network);
  const positions = new Float32Array(network.graph);
  // Размер облака точек тоже меняется во время перехода, иначе на полпути
  // раскладка то вылезает за край полотна, то сжимается в точку
  let extent: [number, number] = [...network.graphExtent];

  let palette = readPalette();
  let size = resizeCanvas(canvas);
  let mode: 'graph' | 'geo' = 'graph';
  let transitionStart = 0; // время начала перехода, 0 — перехода нет
  const visible = new Set(network.meta.types.map((type) => type.id));
  let hover: number | null = null;
  let focus: number | null = null;
  let needsDraw = true;

  const typeName = (id: number) => network.meta.types.find((type) => type.id === id)?.name ?? `тип ${id}`;

  const scene = (): Scene => ({
    ctx,
    network,
    positions,
    camera,
    palette,
    width: size.width,
    height: size.height,
    extent,
    visible,
    hover,
    focus,
    neighbors,
  });

  // ---------- плашки с числами ----------
  const share = network.meta.internal_share;
  element('stats').innerHTML = [
    { value: thousands(network.meta.nodes), label: 'муниципальных образований' },
    { value: thousands(network.meta.edges), label: 'связей в сети' },
    {
      value: share === null ? '—' : `${Math.round(share * 100)}%`,
      label: 'связей внутри своего типа',
    },
    { value: String(network.meta.types.length), label: 'типов локальных экономик' },
  ]
    .map((tile) => `<div class="tile"><b>${tile.value}</b><span>${tile.label}</span></div>`)
    .join('');

  // ---------- переключатель раскладки ----------
  const caption = element('caption');
  const modes = element('modes');
  modes.innerHTML = MODES.map(
    (item) => `<button type="button" data-mode="${item.id}" aria-pressed="${item.id === mode}">${item.label}</button>`,
  ).join('');

  function setMode(next: 'graph' | 'geo'): void {
    if (next === mode) return;
    mode = next;
    camera.zoom = mode === 'graph' ? GRAPH_START_ZOOM : 1;
    camera.panX = mode === 'graph' ? GRAPH_START_PAN_X : 0;
    camera.panY = mode === 'graph' ? GRAPH_START_PAN_Y : 0;
    transitionStart = performance.now();
    caption.textContent = MODES.find((item) => item.id === mode)!.caption;
    modes.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    needsDraw = true;
  }

  caption.textContent = MODES[0].caption;
  modes.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button?.dataset.mode) setMode(button.dataset.mode as 'graph' | 'geo');
  });

  // ---------- таблица типов, она же легенда и фильтр ----------
  const table = element<HTMLTableElement>('types-table');
  table.innerHTML =
    `<caption>«Связей внутри типа» — сколько рёбер соединяют два МО этого типа; ` +
    `чем больше, тем лучше тип выделен в самой сети.</caption>` +
    `<thead><tr><th><span class="visually-hidden">Показывать</span></th>` +
    `<th>Тип локальной экономики</th><th class="num">МО</th>` +
    `<th class="num">Связей внутри типа</th><th class="num">Доля связей сети</th></tr></thead><tbody>` +
    network.meta.types
      .map(
        (type) => `<tr data-type="${type.id}" data-off="false">
          <td class="pick"><input type="checkbox" checked
            aria-label="Показывать тип «${escapeHtml(type.name)}»" /></td>
          <td><span class="swatch" style="background:${typeColor(palette, type.id)}"></span>${escapeHtml(type.name)}</td>
          <td class="num">${thousands(type.count)}</td>
          <td class="num">${thousands(type.inside)}</td>
          <td class="num">${Math.round((type.inside / network.meta.edges) * 100)}%</td>
        </tr>`,
      )
      .join('') +
    '</tbody>';

  function syncRow(id: number): void {
    const row = table.querySelector<HTMLTableRowElement>(`tr[data-type="${id}"]`);
    if (!row) return;
    row.dataset.off = String(!visible.has(id));
    const box = row.querySelector<HTMLInputElement>('input');
    if (box) box.checked = visible.has(id);
  }

  function toggleType(id: number): void {
    if (visible.has(id)) visible.delete(id);
    else visible.add(id);
    // Снятый с показа тип не должен оставаться подсвеченным поиском
    if (focus !== null && !visible.has(network.nodes[focus].t)) focus = null;
    syncRow(id);
    needsDraw = true;
  }

  table.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest('tr');
    if (!row?.dataset.type) return;
    // Клик по самому чекбоксу уже переключил его, строка переключает тоже:
    // чтобы не отменить одно другим, состояние задаём из visible
    toggleType(Number(row.dataset.type));
  });

  // ---------- черновые названия ----------
  const drafts = network.meta.types.filter((type) => type.detail && type.detail !== type.name);
  if (drafts.length) {
    element('drafts-list').innerHTML = drafts
      .map(
        (type) =>
          `<dt data-type="${type.id}"><span class="swatch" ` +
          `style="background:${typeColor(palette, type.id)}"></span>` +
          `${escapeHtml(type.name)}</dt><dd>${escapeHtml(type.detail!)}</dd>`,
      )
      .join('');
    element('drafts').querySelector('summary')!.textContent =
      'Черновые названия: главные отличия типа, собранные автоматически';
  } else {
    element('drafts').remove();
  }

  // ---------- важность признаков ----------
  const importance = network.meta.importance ?? [];
  if (importance.length) {
    const top = Math.max(...importance.map((item) => item.value)) || 1;
    element('importance').innerHTML =
      `<div class="importance"><h3>Какие признаки различают типы</h3>` +
      `<p>В расстояние все признаки входят с равным весом, но разделяют МО они по-разному. ` +
      `Число — доля различий по признаку, объяснённая типом: 0,66 означает, что две трети ` +
      `разброса по этому признаку приходится на различия между типами, а не внутри них.</p>` +
      `<div class="bars">` +
      importance
        .map(
          (item) =>
            `<span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>` +
            `<i style="width:${Math.round((item.value / top) * 100)}%"></i>` +
            `<b>${item.value.toFixed(2).replace('.', ',')}</b>`,
        )
        .join('') +
      `</div></div>`;
  }

  // ---------- поиск ----------
  const search = element<HTMLInputElement>('search');
  const suggestions = element<HTMLUListElement>('suggestions');
  // Нижний регистр считаем один раз: иначе поиск перебирает полторы тысячи
  // названий на каждое нажатие клавиши
  const searchIndex = network.nodes.map((node) => node.n.toLowerCase());
  let matches: number[] = [];

  function closeSuggestions(): void {
    suggestions.hidden = true;
    search.setAttribute('aria-expanded', 'false');
    matches = [];
  }

  function focusNode(index: number): void {
    focus = index;
    if (!visible.has(network.nodes[index].t)) {
      visible.add(network.nodes[index].t);
      syncRow(network.nodes[index].t);
    }
    centerOn(camera, positions[index * 2], positions[index * 2 + 1], size.width, size.height, extent);
    needsDraw = true;
  }

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    if (query.length < 2) {
      focus = null;
      closeSuggestions();
      needsDraw = true;
      return;
    }
    matches = [];
    for (let i = 0; i < searchIndex.length && matches.length < MAX_SUGGESTIONS; i++) {
      if (searchIndex[i].includes(query)) matches.push(i);
    }
    suggestions.innerHTML = matches.length
      ? matches
          .map(
            (index) =>
              `<li role="option" data-index="${index}">${escapeHtml(network.nodes[index].n)}` +
              `<em>${escapeHtml(typeName(network.nodes[index].t))}</em></li>`,
          )
          .join('')
      : '<li class="empty">Ничего не найдено</li>';
    suggestions.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  });

  suggestions.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest('li');
    if (!item?.dataset.index) return;
    const index = Number(item.dataset.index);
    search.value = network.nodes[index].n;
    closeSuggestions();
    focusNode(index);
  });

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && matches.length) {
      event.preventDefault();
      search.value = network.nodes[matches[0]].n;
      closeSuggestions();
      focusNode(matches[0]);
    }
    if (event.key === 'Escape') {
      search.value = '';
      focus = null;
      closeSuggestions();
      needsDraw = true;
    }
  });

  document.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.search')) closeSuggestions();
  });

  // ---------- наведение ----------
  function showTooltip(index: number, x: number, y: number): void {
    const node = network.nodes[index];
    const links = plural(node.d, ['связь', 'связи', 'связей']);
    // Соседи отсортированы по весу ребра, поэтому первые в списке — ближайшие
    const shownNeighbors = neighbors[index].slice(0, MAX_NEIGHBORS);
    const rest = neighbors[index].length - shownNeighbors.length;
    const listed = shownNeighbors.map((other) => escapeHtml(network.nodes[other].n)).join(', ');
    tooltip.innerHTML =
      `<strong>${escapeHtml(node.n)}</strong>` +
      `<em><span class="swatch" style="background:${typeColor(palette, node.t)}"></span>` +
      `${escapeHtml(typeName(node.t))}</em>` +
      `<em>${node.d} ${links} в сети</em>` +
      (listed
        ? `<em class="links">Ближайшие: ${listed}${rest > 0 ? ` и ещё ${rest}` : ''}</em>`
        : '');
    tooltip.style.display = 'block';
    // Чтобы подсказка не вылезала за правый и нижний край
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(x + 14, size.width - box.width - 8)}px`;
    tooltip.style.top = `${Math.min(y + 14, size.height - box.height - 8)}px`;
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      camera.panX += event.clientX - lastX;
      camera.panY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      hover = null;
      tooltip.style.display = 'none';
      needsDraw = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const found = nodeAt(positions, network.radius, camera, size.width, size.height, extent, x, y);
    const shown = found !== null && visible.has(network.nodes[found].t) ? found : null;
    if (shown !== hover) {
      hover = shown;
      needsDraw = true;
    }
    if (shown === null) tooltip.style.display = 'none';
    else showTooltip(shown, x, y);
  });

  canvas.addEventListener('pointerleave', () => {
    hover = null;
    tooltip.style.display = 'none';
    needsDraw = true;
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(
        camera,
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
        size.width,
        size.height,
      );
      needsDraw = true;
    },
    { passive: false },
  );

  // ---------- пересчёт размеров и темы ----------
  new ResizeObserver(() => {
    size = resizeCanvas(canvas);
    needsDraw = true;
  }).observe(canvas);

  onThemeChange(() => {
    palette = readPalette();
    document.querySelectorAll<HTMLElement>('[data-type] .swatch, #drafts-list .swatch').forEach((swatch) => {
      const owner = swatch.closest<HTMLElement>('[data-type]');
      if (owner) swatch.style.background = typeColor(palette, Number(owner.dataset.type));
    });
    needsDraw = true;
  });

  // ---------- цикл отрисовки ----------
  function frame(now: number): void {
    if (transitionStart) {
      const progress = Math.min(1, (now - transitionStart) / TRANSITION_MS);
      const eased = easeInOut(progress);
      const from = mode === 'geo' ? network.graph : network.geo;
      const to = mode === 'geo' ? network.geo : network.graph;
      const fromExtent = mode === 'geo' ? network.graphExtent : network.geoExtent;
      const toExtent = mode === 'geo' ? network.geoExtent : network.graphExtent;
      interpolate(from, to, eased, positions);
      extent = [
        fromExtent[0] + (toExtent[0] - fromExtent[0]) * eased,
        fromExtent[1] + (toExtent[1] - fromExtent[1]) * eased,
      ];
      needsDraw = true;
      if (progress >= 1) transitionStart = 0;
    }
    if (needsDraw) {
      draw(scene());
      needsDraw = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  element('note').textContent =
    `Сеть построена до кластеризации и от числа типов не зависит. ` +
    `Доля связей внутри типов показывает, насколько разбиение согласовано с самой сетью.`;
}

loadNetwork()
  .then(start)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    element('canvas-wrap').innerHTML =
      `<p class="error">Не удалось загрузить <code>network.json</code>: ${message}.<br />` +
      `Соберите его из результатов ноутбука: <code>python viz/export_network.py</code></p>`;
  });
