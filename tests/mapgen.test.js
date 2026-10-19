import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../src/shared/mapgen.js';
import {
  pointInPolygon,
  polygonArea,
  polygonBounds,
} from '../src/shared/geometry.js';

const MAP = generateMap({ seed: 7, cityCount: 60 });

test('same seed and options reproduce the same map', () => {
  const again = generateMap({ seed: 7, cityCount: 60 });
  assert.equal(JSON.stringify(again), JSON.stringify(MAP));
});

test('different seeds produce different maps', () => {
  const other = generateMap({ seed: 8, cityCount: 60 });
  assert.notDeepEqual(
    other.cities.map((city) => city.name),
    MAP.cities.map((city) => city.name),
  );
});

test('city polygons tile the outline without gaps or overlaps', () => {
  assert.equal(MAP.cities.length, 60);
  assert.ok(
    Math.abs(MAP.meta.coverage - 1) < 1e-3,
    `coverage was ${MAP.meta.coverage}`,
  );
});

test('every interior sample point belongs to exactly one city', () => {
  let checked = 0;
  for (let gx = 0; gx < 20; gx += 1) {
    for (let gy = 0; gy < 20; gy += 1) {
      const point = [MAP.width * (0.1 + 0.04 * gx), MAP.height * (0.1 + 0.04 * gy)];
      if (!pointInPolygon(point, MAP.outline)) continue;

      const owners = MAP.cities.filter((city) => pointInPolygon(point, city.polygon));
      assert.equal(owners.length, 1, `point ${point} owned by ${owners.length} cities`);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `only ${checked} sample points inside the outline`);
});

test('adjacency is symmetric and cities have neighbours', () => {
  assert.ok(MAP.cities.length > 1);
  for (const city of MAP.cities) {
    assert.ok(city.neighbors.length > 0, `${city.name} has no neighbours`);
    for (const neighbourId of city.neighbors) {
      const neighbour = MAP.cities[neighbourId];
      assert.ok(
        neighbour.neighbors.includes(city.id),
        `${city.name} -> ${neighbour.name} is not symmetric`,
      );
    }
    assert.equal(new Set(city.neighbors).size, city.neighbors.length);
  }
});

test('city names are unique and centers lie inside their territory', () => {
  const names = new Set(MAP.cities.map((city) => city.name));
  assert.equal(names.size, MAP.cities.length);
  for (const city of MAP.cities) {
    assert.ok(
      pointInPolygon(city.center, city.polygon),
      `${city.name} center is outside its polygon`,
    );
    assert.ok(city.polygon.length >= 3);
    assert.ok(city.area > 0);
  }
});

test('city names are English-style', () => {
  for (const city of MAP.cities) {
    assert.match(city.name, /^[A-Z][A-Za-z]+$/, `unexpected name ${city.name}`);
  }
});

test('territory sizes and aspect ratios vary noticeably', () => {
  const areas = MAP.cities.map((city) => city.area).sort((a, b) => a - b);
  const areaSpread = areas[areas.length - 1] / areas[0];
  assert.ok(areaSpread > 2.5, `area max/min was only ${areaSpread.toFixed(2)}`);

  const aspects = MAP.cities
    .map((city) => {
      const bounds = polygonBounds(city.polygon);
      return (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
    })
    .sort((a, b) => a - b);
  const aspectSpread = aspects[aspects.length - 1] / aspects[0];
  assert.ok(aspectSpread > 1.5, `aspect max/min was only ${aspectSpread.toFixed(2)}`);
});

test('single-city maps are valid', () => {
  const single = generateMap({ seed: 3, cityCount: 1 });
  assert.equal(single.cities.length, 1);
  assert.equal(single.cities[0].neighbors.length, 0);
  const outlineArea = Math.abs(polygonArea(single.outline));
  assert.ok(Math.abs(single.cities[0].area / outlineArea - 1) < 1e-6);
});

test('large maps still tile correctly', () => {
  const large = generateMap({ seed: 11, cityCount: 240 });
  assert.equal(large.cities.length, 240);
  assert.ok(Math.abs(large.meta.coverage - 1) < 1e-3);
  for (const city of large.cities) {
    assert.ok(city.neighbors.length > 0);
  }
});
