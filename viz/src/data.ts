/** Загрузка и подготовка данных сети. Файл network.json готовит скрипт
 *  `viz/export_network.py` из результатов ноутбука. */

export interface TypeInfo {
  id: number;
  /** Человеческое название типа */
  name: string;
  /** Как тип назван в ноутбуке: при черновой разметке — перечисление отличий */
  detail?: string;
  count: number;
  inside: number;
}

export interface FeatureWeight {
  name: string;
  value: number;
}

export interface Meta {
  nodes: number;
  edges: number;
  internal_share: number | null;
  types: TypeInfo[];
  /** Доля различий по признаку, объяснённая типом; может отсутствовать */
  importance?: FeatureWeight[];
}

export interface RawNode {
  n: string;
  t: number;
  x: number;
  y: number;
  lat: number;
  lon: number;
  d: number;
}

export interface Network {
  meta: Meta;
  nodes: RawNode[];
  /** [индекс узла, индекс узла, вес] */
  edges: [number, number, number][];
  /** Координаты силовой раскладки, приведённые к квадрату 0–1 */
  graph: Float32Array;
  /** Координаты географической раскладки в том же квадрате */
  geo: Float32Array;
  /** Радиус узла в пикселях при единичном масштабе */
  radius: Float32Array;
  /** true, если оба конца ребра одного типа */
  edgeInside: Uint8Array;
  /** Ширина и высота облака точек внутри квадрата 0–1: нужны, чтобы раскладка
   *  занимала всё полотно. Силовая раскладка почти круглая, географическая
   *  сильно вытянута по долготе, и единый масштаб оставил бы половину пустой */
  graphExtent: [number, number];
  geoExtent: [number, number];
}

/** Веб-меркатор: привычная форма страны, вытянутый север.
 *
 *  Чукотка заходит за 180-й меридиан, и её долгота отрицательная: Эгвекинот
 *  это −179°. На обычной развёртке такие МО уезжают к левому краю карты,
 *  за океан. Поэтому отрицательную долготу сдвигаем на целый оборот —
 *  страна остаётся цельной, Чукотка оказывается справа от Камчатки.
 */
function mercator(lat: number, lon: number): [number, number] {
  const shifted = lon < 0 ? lon + 360 : lon;
  const clamped = Math.max(-85, Math.min(85, lat));
  const radians = (clamped * Math.PI) / 180;
  return [shifted / 360, -Math.log(Math.tan(Math.PI / 4 + radians / 2)) / (2 * Math.PI)];
}

/** Привести точки к квадрату 0–1, сохранив пропорции. Возвращает размер
 *  занятой ими области. */
function fitUnitSquare(points: Float32Array): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  for (let i = 0; i < points.length; i += 2) {
    points[i] = (points[i] - (minX + maxX) / 2) / span + 0.5;
    points[i + 1] = (points[i + 1] - (minY + maxY) / 2) / span + 0.5;
  }
  return [(maxX - minX) / span || 1, (maxY - minY) / span || 1];
}

export async function loadNetwork(url = 'network.json'): Promise<Network> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const raw = (await response.json()) as { meta: Meta; nodes: RawNode[]; edges: [number, number, number][] };

  const count = raw.nodes.length;
  const graph = new Float32Array(count * 2);
  const geo = new Float32Array(count * 2);
  const radius = new Float32Array(count);
  let maxDegree = 1;
  for (const node of raw.nodes) maxDegree = Math.max(maxDegree, node.d);

  raw.nodes.forEach((node, i) => {
    graph[i * 2] = node.x;
    graph[i * 2 + 1] = 1 - node.y; // в canvas ось Y направлена вниз
    const [mx, my] = mercator(node.lat, node.lon);
    geo[i * 2] = mx;
    geo[i * 2 + 1] = my;
    // Радиус растёт как корень из числа связей: площадь точки пропорциональна степени
    radius[i] = 1.9 + 2.6 * Math.sqrt(node.d / maxDegree);
  });
  // Силовая раскладка уже приведена к квадрату в export_network.py, здесь
  // остаётся измерить занятую область; географическая приводится тут же
  const geoExtent = fitUnitSquare(geo);
  const graphExtent = fitUnitSquare(graph);

  const edgeInside = new Uint8Array(raw.edges.length);
  raw.edges.forEach(([a, b], i) => {
    edgeInside[i] = raw.nodes[a].t === raw.nodes[b].t ? 1 : 0;
  });

  return {
    meta: raw.meta, nodes: raw.nodes, edges: raw.edges,
    graph, geo, radius, edgeInside, graphExtent, geoExtent,
  };
}

/** Соседи каждого узла — для подсветки при наведении и для списка в подсказке.
 *
 *  Внутри каждого списка соседи идут от самой сильной связи к самой слабой:
 *  в подсказке помещается десяток названий, и это должны быть ближайшие,
 *  а не первые попавшиеся по порядку рёбер.
 */
export function buildNeighbors(network: Network): number[][] {
  const linked: { index: number; weight: number }[][] = network.nodes.map(() => []);
  for (const [a, b, weight] of network.edges) {
    linked[a].push({ index: b, weight });
    linked[b].push({ index: a, weight });
  }
  return linked.map((list) =>
    list.sort((one, other) => other.weight - one.weight).map((item) => item.index),
  );
}
