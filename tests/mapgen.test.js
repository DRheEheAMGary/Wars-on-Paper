import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../src/shared/mapgen.js';
import { pointInPolygon, polygonArea, polygonBounds } from '../src/shared/geometry.js';
import { createRng } from '../src/shared/rng.js';

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

test('city count matches the request and every city has land', () => {
  assert.equal(MAP.cities.length, 60);
  assert.equal(MAP.meta.cityCount, 60);
  assert.ok(MAP.meta.candidateCount >= 60);
  for (const city of MAP.cities) {
    assert.ok(city.polygon.length >= 3);
    assert.ok(city.area > 0);
  }
  const areaSum = MAP.cities.reduce((sum, city) => sum + city.area, 0);
  assert.ok(Math.abs(areaSum - MAP.meta.landArea) < 1e-6);
});

test('land territories do not overlap and ocean exists around them', () => {
  const rng = createRng('sample-points');
  let landPoints = 0;
  let oceanPoints = 0;

  for (let i = 0; i < 600; i += 1) {
    const point = [rng.range(0, MAP.width), rng.range(0, MAP.height)];
    const owners = MAP.cities.filter((city) => pointInPolygon(point, city.polygon));
    assert.ok(owners.length <= 1, `point ${point} owned by ${owners.length} cities`);
    if (owners.length === 1) landPoints += 1;
    else oceanPoints += 1;
  }

  assert.ok(landPoints > 100, `only ${landPoints} land sample points`);
  assert.ok(oceanPoints > 50, `only ${oceanPoints} ocean sample points`);
});

/** @param {import('../src/shared/mapgen.js').GameMap} map */
function groupByContinent(map) {
  /** @type {Map<number, import('../src/shared/mapgen.js').MapCity[]>} */
  const groups = new Map();
  for (const city of map.cities) {
    const list = groups.get(city.continent) ?? [];
    list.push(city);
    groups.set(city.continent, list);
  }
  return groups;
}

/**
 * @param {import('../src/shared/mapgen.js').GameMap} map
 * @param {import('../src/shared/mapgen.js').MapCity[]} cities
 */
function assertConnected(map, cities) {
  const members = new Set(cities.map((city) => city.id));
  const seen = new Set([cities[0].id]);
  const stack = [cities[0].id];
  while (stack.length > 0) {
    const id = /** @type {number} */ (stack.pop());
    for (const neighbourId of map.cities[id].neighbors) {
      if (!members.has(neighbourId) || seen.has(neighbourId)) continue;
      seen.add(neighbourId);
      stack.push(neighbourId);
    }
  }
  assert.equal(seen.size, cities.length);
}

test('the map has several connected continents and no lakes', () => {
  assert.ok(MAP.meta.continentCount >= 2);
  assert.equal(MAP.meta.continentCount, MAP.meta.continentSizes.length);
  assert.equal(
    MAP.meta.continentSizes.reduce((sum, size) => sum + size, 0),
    MAP.cities.length,
  );
  assert.equal(MAP.meta.lakeCount, 0);

  const groups = groupByContinent(MAP);
  assert.equal(groups.size, MAP.meta.continentCount);
  for (const cities of groups.values()) {
    assert.ok(cities.length > 0);
    assertConnected(MAP, cities);
    // Continents must not touch each other, otherwise they would be one.
    const members = new Set(cities.map((city) => city.id));
    for (const city of cities) {
      for (const neighbourId of city.neighbors) {
        assert.ok(members.has(neighbourId), 'continents are adjacent');
      }
    }
  }
});

test('adjacency is symmetric and cities have neighbours', () => {
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

test('city names are unique English names', () => {
  const names = new Set();
  for (const city of MAP.cities) {
    assert.match(city.name, /^[A-Z][A-Za-z]+$/, `unexpected name ${city.name}`);
    assert.ok(!names.has(city.name), `duplicate name ${city.name}`);
    names.add(city.name);
  }
});

test('center points lie inside their territory', () => {
  for (const city of MAP.cities) {
    assert.ok(
      pointInPolygon(city.center, city.polygon),
      `${city.name} center is outside its polygon`,
    );
  }
});

test('the rectangular world contains every territory', () => {
  for (const city of MAP.cities) {
    for (const [x, y] of city.polygon) {
      assert.ok(x >= -0.001 && x <= MAP.width + 0.001, `x ${x} outside world`);
      assert.ok(y >= -0.001 && y <= MAP.height + 0.001, `y ${y} outside world`);
    }
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

test('land occupies a plausible share of the world', () => {
  assert.ok(
    MAP.meta.landAreaFraction > 0.15 && MAP.meta.landAreaFraction < 0.85,
    `land fraction was ${MAP.meta.landAreaFraction}`,
  );
});

test('single-city maps are valid', () => {
  const single = generateMap({ seed: 3, cityCount: 1 });
  assert.equal(single.cities.length, 1);
  assert.equal(single.cities[0].neighbors.length, 0);
  const area = Math.abs(polygonArea(single.cities[0].polygon));
  assert.ok(area > 0);
  assert.ok(single.meta.landAreaFraction > 0 && single.meta.landAreaFraction < 1);
});

test('large maps keep every continent connected and lake-free', () => {
  const large = generateMap({ seed: 11, cityCount: 240 });
  assert.equal(large.cities.length, 240);
  assert.ok(large.meta.continentCount >= 2);
  assert.equal(large.meta.lakeCount, 0);

  for (const cities of groupByContinent(large).values()) {
    assertConnected(large, cities);
  }

  const rng = createRng('large-sample');
  for (let i = 0; i < 300; i += 1) {
    const point = [rng.range(0, large.width), rng.range(0, large.height)];
    const owners = large.cities.filter((city) => pointInPolygon(point, city.polygon));
    assert.ok(owners.length <= 1);
  }
});
