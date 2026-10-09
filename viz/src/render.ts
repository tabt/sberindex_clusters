/** Рисование сети на canvas.
 *
 *  Порядок важен: сначала все рёбра, потом узлы, потом подсветка. Иначе рёбра
 *  перечёркивают точки, и облако выглядит грязным.
 */

import type { Network } from './data';
import type { Palette } from './theme';
import { typeColor } from './theme';
import type { Camera } from './view';
import { toScreen } from './view';

export interface Scene {
  ctx: CanvasRenderingContext2D;
  network: Network;
  positions: Float32Array;
  camera: Camera;
  palette: Palette;
  width: number;
  height: number;
  extent: [number, number];
  /** Включённые типы: остальные не рисуются вовсе */
  visible: Set<number>;
  /** Узел под курсором */
  hover: number | null;
  /** Узел, найденный поиском: помечен кольцом и подписан */
  focus: number | null;
  neighbors: number[][];
}

const EDGE_ALPHA = 0.5; // ребро внутри типа
const EDGE_ALPHA_BETWEEN = 0.16; // ребро между типами

function alphaColor(hex: string, alpha: number): string {
  // Цвета приходят из CSS в виде #rrggbb
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function draw(scene: Scene): void {
  const { ctx, network, positions, camera, palette, width, height, extent, visible, hover, focus } = scene;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.clearRect(0, 0, width, height);

  const screenX = (i: number) => toScreen(positions[i * 2], 'x', camera, width, height, extent);
  const screenY = (i: number) => toScreen(positions[i * 2 + 1], 'y', camera, width, height, extent);
  const shown = (i: number) => visible.has(network.nodes[i].t);

  // --- рёбра. Ребро внутри типа окрашено в цвет типа: так видно, совпадает ли
  // разбиение со структурой связей. Ребро между типами остаётся серым.
  ctx.lineWidth = Math.min(1.4, 0.7 * camera.zoom);
  network.edges.forEach(([a, b], index) => {
    if (!shown(a) || !shown(b)) return;
    const inside = network.edgeInside[index] === 1;
    const type = network.nodes[a].t;
    ctx.strokeStyle = inside
      ? alphaColor(typeColor(palette, type), EDGE_ALPHA)
      : alphaColor(palette.edge, EDGE_ALPHA_BETWEEN);
    ctx.beginPath();
    ctx.moveTo(screenX(a), screenY(a));
    ctx.lineTo(screenX(b), screenY(b));
    ctx.stroke();
  });

  // --- узлы
  for (let i = 0; i < network.nodes.length; i++) {
    if (!shown(i)) continue;
    ctx.fillStyle = typeColor(palette, network.nodes[i].t);
    ctx.beginPath();
    ctx.arc(screenX(i), screenY(i), network.radius[i], 0, Math.PI * 2);
    ctx.fill();
  }

  const ring = (i: number, extra: number) => {
    ctx.beginPath();
    ctx.arc(screenX(i), screenY(i), network.radius[i] + extra, 0, Math.PI * 2);
    ctx.fillStyle = typeColor(palette, network.nodes[i].t);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.ring;
    ctx.stroke();
  };

  // --- подсветка: связи наведённого МО и кольца на нём и его соседях
  if (hover !== null && shown(hover)) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = alphaColor(palette.text, 0.55);
    for (const other of scene.neighbors[hover]) {
      if (!shown(other)) continue;
      ctx.beginPath();
      ctx.moveTo(screenX(hover), screenY(hover));
      ctx.lineTo(screenX(other), screenY(other));
      ctx.stroke();
    }
    for (const other of scene.neighbors[hover]) if (shown(other)) ring(other, 0.6);
    ring(hover, 2);
  }

  // --- найденное поиском МО: заметное кольцо и подпись, которая не исчезает
  if (focus !== null && shown(focus)) {
    const x = screenX(focus);
    const y = screenY(focus);
    ctx.beginPath();
    ctx.arc(x, y, network.radius[focus] + 9, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.text;
    ctx.stroke();
    ring(focus, 1.5);

    const label = network.nodes[focus].n;
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    const textWidth = ctx.measureText(label).width;
    // Подпись слева от точки, если справа не помещается
    const left = x + 14 + textWidth + 8 < width ? x + 14 : x - 14 - textWidth - 8;
    ctx.fillStyle = alphaColor(palette.surface, 0.9);
    ctx.fillRect(left - 4, y - 18, textWidth + 8, 18);
    ctx.fillStyle = palette.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, left, y - 9);
  }
}

/** Привести размер canvas к размеру блока с учётом плотности экрана. */
export function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  return { width: rect.width, height: rect.height };
}
