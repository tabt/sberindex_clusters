/** Камера и переход между раскладками.
 *
 *  Обе раскладки — силовая и географическая — лежат в квадрате 0–1, поэтому
 *  переход между ними делается покоординатной интерполяцией, а камера одна
 *  и та же для обеих.
 */

export interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

export function newCamera(): Camera {
  return { zoom: 1, panX: 0, panY: 0 };
}

/** Сколько пикселей занимает единичный квадрат раскладки. Масштаб подбирается
 *  так, чтобы облако точек вписалось в полотно по обеим сторонам. */
export function baseScale(width: number, height: number, extent: [number, number]): number {
  return 0.94 * Math.min(width / extent[0], height / extent[1]);
}

export function toScreen(
  world: number,
  axis: 'x' | 'y',
  camera: Camera,
  width: number,
  height: number,
  extent: [number, number],
): number {
  const scale = baseScale(width, height, extent) * camera.zoom;
  return axis === 'x'
    ? width / 2 + (world - 0.5) * scale + camera.panX
    : height / 2 + (world - 0.5) * scale + camera.panY;
}

/** Пределы увеличения. Верхний нужен большим: в географической раскладке
 *  половина МО сидит в европейской части, и чтобы разглядеть там отдельные
 *  точки, карту приходится увеличивать во много раз. */
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 80;

/** Масштабирование колесом с сохранением точки под курсором. */
export function zoomAt(camera: Camera, factor: number, x: number, y: number, width: number, height: number): void {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  const applied = next / camera.zoom;
  camera.panX = x - applied * (x - camera.panX) - (1 - applied) * (width / 2);
  camera.panY = y - applied * (y - camera.panY) - (1 - applied) * (height / 2);
  camera.zoom = next;
}

/** Плавное замедление к концу перехода. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Промежуточное положение точек между двумя раскладками. */
export function interpolate(from: Float32Array, to: Float32Array, t: number, out: Float32Array): void {
  if (t <= 0) {
    out.set(from);
    return;
  }
  if (t >= 1) {
    out.set(to);
    return;
  }
  for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * t;
}

/** Ближайший узел к курсору, если курсор достаточно близко. */
export function nodeAt(
  positions: Float32Array,
  radius: Float32Array,
  camera: Camera,
  width: number,
  height: number,
  extent: [number, number],
  x: number,
  y: number,
): number | null {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < radius.length; i++) {
    const dx = toScreen(positions[i * 2], 'x', camera, width, height, extent) - x;
    const dy = toScreen(positions[i * 2 + 1], 'y', camera, width, height, extent) - y;
    const distance = dx * dx + dy * dy;
    // Зона захвата чуть больше самой точки, иначе мелкие узлы не поймать
    const reach = Math.pow(radius[i] + 6, 2);
    if (distance < reach && distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best < 0 ? null : best;
}

/** Навести камеру на узел: сдвинуть его в центр полотна и приблизить. */
export function centerOn(
  camera: Camera,
  worldX: number,
  worldY: number,
  width: number,
  height: number,
  extent: [number, number],
  zoom = 6,
): void {
  camera.zoom = Math.min(zoom, MAX_ZOOM);
  const scale = baseScale(width, height, extent) * camera.zoom;
  camera.panX = -(worldX - 0.5) * scale;
  camera.panY = -(worldY - 0.5) * scale;
}
