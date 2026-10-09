"""Готовит данные для визуализации: results/*.csv -> viz/public/network.json

Ноутбук `clustering.ipynb` сохраняет в `results/` четыре файла, из которых
здесь нужны три: `clusters.csv` (МО -> тип), `network_edges.csv` (рёбра сети)
и `mo_features.csv` (координаты центроидов для географической раскладки).

Раскладка сети считается здесь, а не в браузере: укладка полутора тысяч узлов
силовым алгоритмом занимает несколько секунд и зависит от случайного начала,
поэтому считаем её один раз с фиксированным seed — картинка тогда одна и та же
при каждом открытии страницы.

Запуск из корня проекта:

    python viz/export_network.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

SEED = 42

# Минимальный зазор между точками в единицах квадрата 0-1. Силовая укладка
# стягивает плотные сообщества в комки, где при любом увеличении точки сидят
# одна на другой. После укладки точки раздвигаются до этого зазора: сдвиги
# локальные, взаимное расположение и форма комков сохраняются
MIN_GAP = 0.006
RELAX_ROUNDS = 200

# Желаемое расстояние между узлами в силовой укладке. По умолчанию networkx
# берёт 1/sqrt(n); увеличение растягивает картинку и разводит сообщества
SPRING_SPACING = 1.6

# Человеческие названия типов. Ноутбук пишет в clusters.csv то, что лежит
# в names_by_cluster: либо чистовые названия, либо черновые, собранные
# автоматически из профиля. Чистовые задаются здесь — после каждого нового
# прогона их надо сверить с медоидами, нумерация типов между прогонами
# не сохраняется. Тип, которого тут нет, берёт название из clusters.csv.
TYPE_NAMES = {
    0: 'сырьевые районы',
    1: 'ядра агломераций',
    2: 'промышленные города',
    3: 'аграрная периферия',
}

TOP_FEATURES = 12   # сколько признаков показывать на диаграмме важности

# Подписи для диаграммы важности. Автоматическое правило ниже справляется
# с отраслевыми долями, но не с сокращениями в именах геопризнаков
FEATURE_LABELS = {
    'geo_area_km2': 'Площадь территории',
    'geo_compactness': 'Компактность территории',
    'geo_neighbors': 'Соседей по границе',
    'geo_density_per_km2': 'Плотность населения',
    'geo_dist_to_city_100k_km': 'Расстояние до города от 100 тыс.',
    'geo_dist_to_city_500k_km': 'Расстояние до города от 500 тыс.',
    'geo_dist_to_region_center_km': 'Расстояние до центра региона',
    'geo_pop_within_100km': 'Население в радиусе 100 км',
    'geo_market_potential': 'Потенциал рынка',
    'geo_is_suburb': 'Пригород крупного города',
    'rs_население_среднегод': 'Население',
    'rs_зарплата_крупные': 'Зарплата в крупных организациях',
    'rs_инвестиции_на_душу': 'Инвестиции на душу',
    'rs_организации_на_1000': 'Организаций на 1000 жителей',
    'rs_ип_на_1000': 'ИП на 1000 жителей',
    'rs_коэф_рождаемости': 'Коэффициент рождаемости',
    'rs_коэф_смертности': 'Коэффициент смертности',
    'rs_коэф_естприроста': 'Естественный прирост населения',
    'rs_лпу': 'Медицинских учреждений',
    'rs_улицы': 'Протяжённость улиц',
}

# Отраслевые доли: 'rs_отгружено_доля_Раздел C Обрабатывающие…' слишком длинно
SHARE_PREFIXES = {'отгружено_доля_': 'Отгрузка', 'работники_доля_': 'Занятость'}

# Колонки из ноутбука переименовываем в латиницу: дальше с ними работают
# numpy и json, и кириллические имена только мешают
COLUMNS = {'мо': 'name', 'кластер': 'type', 'название': 'type_name',
           'geo_centroid_lat': 'lat', 'geo_centroid_lon': 'lon'}


def pretty_feature(name: str) -> str:
    """Техническое имя признака -> читаемая подпись для диаграммы."""
    if name in FEATURE_LABELS:
        return FEATURE_LABELS[name]

    stem = re.sub(r'^(rs|geo)_', '', name)
    for prefix, title in SHARE_PREFIXES.items():
        if stem.startswith(prefix):
            section = re.sub(r'^Раздел [A-Za-zА-Яа-я]{1,2} ', '', stem[len(prefix):])
            # У разделов ОКВЭД длинные названия с перечислениями: для подписи
            # хватает первой части до запятой
            section = section.split(',')[0].strip()
            return f'{title}: {section[:1].lower()}{section[1:]}'

    label = stem.replace('_', ' ')
    return label[:1].upper() + label[1:] if label else name


def load_importance(results: Path) -> list[dict]:
    """Доля различий по признаку, объяснённая типом (eps² Краскела-Уоллиса)."""
    path = results / 'feature_importance.csv'
    if not path.exists():
        print(f'{path} не найден: диаграмма важности признаков будет пропущена')
        return []
    table = pd.read_csv(path, index_col=0).iloc[:, 0].sort_values(ascending=False)
    return [{'name': pretty_feature(str(name)), 'value': round(float(value), 3)}
            for name, value in table.head(TOP_FEATURES).items()]


def load(results: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    clusters = pd.read_csv(results / 'clusters.csv', dtype={'oktmo': str}).set_index('oktmo')
    features = pd.read_csv(results / 'mo_features.csv', dtype={'oktmo': str}).set_index('oktmo')

    missing = [c for c in ('geo_centroid_lat', 'geo_centroid_lon') if c not in features.columns]
    if missing:
        raise SystemExit(f'В mo_features.csv нет колонок {missing}: '
                         'географическая раскладка не соберётся')

    table = clusters.join(features[['geo_centroid_lat', 'geo_centroid_lon']])
    table = table.rename(columns=COLUMNS)
    if 'name' not in table.columns:
        table['name'] = table.index
    if 'type_name' not in table.columns:
        table['type_name'] = 'тип ' + table['type'].astype(str)
    table = table.dropna(subset=['lat', 'lon'])

    edges = pd.read_csv(results / 'network_edges.csv', dtype={'source': str, 'target': str})
    known = set(table.index)
    edges = edges[edges['source'].isin(known) & edges['target'].isin(known)]
    return table, edges


def layout(nodes: pd.Index, edges: pd.DataFrame) -> np.ndarray:
    """Силовая укладка сети: связанные МО притягиваются друг к другу."""
    graph = nx.Graph()
    graph.add_nodes_from(nodes)
    graph.add_weighted_edges_from(edges[['source', 'target', 'weight']].itertuples(index=False))
    positions = nx.spring_layout(graph, weight='weight', seed=SEED, iterations=200,
                                 k=SPRING_SPACING / math.sqrt(max(len(nodes), 1)))
    return np.array([positions[key] for key in nodes])


def spread(points: np.ndarray, min_gap: float = MIN_GAP, rounds: int = RELAX_ROUNDS) -> np.ndarray:
    """Раздвинуть точки, оказавшиеся ближе min_gap друг к другу.

    Каждый раунд находит пары ближе порога и разводит их ровно настолько,
    чтобы зазор стал равен порогу. Дерево отрезков (cKDTree) ищет такие пары
    сразу, без перебора всех пар: на полутора тысячах точек это доли секунды.
    """
    points = points.astype(float).copy()
    rng = np.random.default_rng(SEED)
    # Совпавшие точка в точку узлы разводить некуда: задаём направление случайно
    points += rng.normal(0, min_gap * 1e-3, points.shape)

    # Сошедшиеся пары стоят ровно на расстоянии min_gap, и дерево продолжает
    # их возвращать. Поэтому «слишком близко» считаем с небольшим допуском
    tolerance = min_gap * 0.99

    for round_number in range(rounds):
        pairs = np.array(list(cKDTree(points).query_pairs(min_gap)), dtype=int)
        if len(pairs):
            delta = points[pairs[:, 0]] - points[pairs[:, 1]]
            distance = np.hypot(delta[:, 0], delta[:, 1])
            tight = distance < tolerance
            pairs, delta, distance = pairs[tight], delta[tight], distance[tight]
        if not len(pairs):
            print(f'Точки раздвинуты за {round_number} раундов')
            return points

        left, right = pairs[:, 0], pairs[:, 1]
        distance[distance == 0] = min_gap * 1e-6
        # Половину недостающего зазора забирает каждая точка пары
        push = 0.5 * (min_gap - distance) / distance
        shift = delta * push[:, None]
        np.add.at(points, left, shift)
        np.add.at(points, right, -shift)

    print(f'Осталось пар ближе {min_gap} после {rounds} раундов: {len(pairs)}')
    return points


def fit_unit_square(points: np.ndarray) -> np.ndarray:
    """Привести координаты к квадрату 0–1, сохранив пропорции."""
    low, high = points.min(axis=0), points.max(axis=0)
    span = float((high - low).max()) or 1.0
    return (points - (low + high) / 2) / span + 0.5


def build(results: Path, out: Path) -> dict:
    table, edges = load(results)
    order = list(table.index)
    position = {key: i for i, key in enumerate(order)}

    xy = fit_unit_square(spread(layout(table.index, edges)))

    degree = pd.Series(0, index=table.index, dtype=int)
    degree.update(pd.concat([edges['source'], edges['target']]).value_counts())

    source_type = table.loc[edges['source'], 'type'].to_numpy()
    target_type = table.loc[edges['target'], 'type'].to_numpy()
    inside = source_type == target_type

    types = []
    for type_id, group in table.groupby('type'):
        # detail — то, как тип назван в ноутбуке: если названия там черновые,
        # это перечисление главных отличий, и оно остаётся на странице
        detail = str(group['type_name'].iloc[0])
        types.append({'id': int(type_id),
                      'name': TYPE_NAMES.get(int(type_id), detail),
                      'detail': detail,
                      'count': int(len(group)),
                      'inside': int((inside & (source_type == type_id)).sum())})

    data = {
        'meta': {
            'nodes': len(order),
            'edges': int(len(edges)),
            # Доля рёбер, соединяющих МО одного типа: согласие сети с разбиением
            'internal_share': round(float(inside.mean()), 3) if len(edges) else None,
            'types': types,
            'importance': load_importance(results),
        },
        # Узлы: название, тип, координаты раскладки, широта и долгота, степень
        'nodes': [{'n': str(table['name'].iloc[i]), 't': int(table['type'].iloc[i]),
                   'x': round(float(xy[i, 0]), 4), 'y': round(float(xy[i, 1]), 4),
                   'lat': round(float(table['lat'].iloc[i]), 4),
                   'lon': round(float(table['lon'].iloc[i]), 4),
                   'd': int(degree.iloc[i])}
                  for i in range(len(order))],
        # Рёбра: индексы узлов в массиве nodes и вес
        'edges': [[position[s], position[t], round(float(w), 3)]
                  for s, t, w in edges[['source', 'target', 'weight']].itertuples(index=False)],
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, default=Path('results'))
    parser.add_argument('--out', type=Path, default=Path('viz/public/network.json'))
    args = parser.parse_args()

    meta = build(args.results, args.out)['meta']
    print(f'{args.out}: {meta["nodes"]} МО, {meta["edges"]} связей, '
          f'внутри типов {meta["internal_share"]:.0%}')
    for t in meta['types']:
        print(f'  тип {t["id"]}: {t["name"]} — {t["count"]} МО, '
              f'{t["inside"]} связей внутри типа')


if __name__ == '__main__':
    main()
