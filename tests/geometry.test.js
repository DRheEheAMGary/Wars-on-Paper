import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chaikin,
  clipPolygonHalfPlane,
  convexHull,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonCentroid,
} from '../src/shared/geometry.js';

/** @type {[number, number][]} */
const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test('signed polygon area', () => {
  assert.equal(polygonArea(square), 100);
  assert.equal(polygonArea(square.slice().reverse()), -100);
});

test('polygon centroid', () => {
  const [x, y] = polygonCentroid(square);
  assert.ok(Math.abs(x - 5) < 1e-9);
  assert.ok(Math.abs(y - 5) < 1e-9);
});

test('polygon bounds', () => {
  assert.deepEqual(polygonBounds(square), {
    minX: 0,
    minY: 0,
    maxX: 10,
    maxY: 10,
  });
});

test('point in polygon', () => {
  assert.ok(pointInPolygon([5, 5], square));
  assert.ok(!pointInPolygon([15, 5], square));
  assert.ok(!pointInPolygon([5, -1], square));
});

test('half-plane clipping keeps the requested side', () => {
  const clipped = clipPolygonHalfPlane(square, 1, 0, 5);
  assert.ok(Math.abs(Math.abs(polygonArea(clipped)) - 50) < 1e-9);
  for (const [x] of clipped) assert.ok(x <= 5 + 1e-9);
});

test('convex hull removes interior points', () => {
  const hull = convexHull([...square, [5, 5], [2, 2], [5, 9]]);
  assert.equal(hull.length, 4);
  assert.equal(Math.abs(polygonArea(hull)), 100);
});

test('chaikin smooths a square without collapsing it', () => {
  const smoothed = chaikin(square, 2);
  assert.equal(smoothed.length, 16);
  const area = Math.abs(polygonArea(smoothed));
  assert.ok(area < 100);
  assert.ok(area > 80);
});
