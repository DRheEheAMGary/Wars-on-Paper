// @ts-check
/**
 * 2D camera for the map view: world <-> screen transforms, pan and
 * cursor-anchored zoom. Pure view state, nothing game related.
 */

export class Camera {
  /**
   * @param {number} worldWidth
   * @param {number} worldHeight
   */
  constructor(worldWidth, worldHeight) {
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.centerX = worldWidth / 2;
    this.centerY = worldHeight / 2;
    this.zoom = 1;
    this.minZoom = 0.05;
    this.maxZoom = 12;
    this.initialized = false;
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.viewWidth = width;
    this.viewHeight = height;
    if (!this.initialized && width > 0 && height > 0) {
      this.fit();
      this.initialized = true;
      return;
    }
    this.zoom = Math.min(Math.max(this.zoom, this.minZoom), this.maxZoom);
    this.clampCenter();
  }

  /** Fit the whole map into the viewport. */
  fit() {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return;
    this.zoom =
      Math.min(this.viewWidth / this.worldWidth, this.viewHeight / this.worldHeight) * 0.92;
    this.minZoom = this.zoom * 0.5;
    this.maxZoom = this.zoom * 14;
    this.centerX = this.worldWidth / 2;
    this.centerY = this.worldHeight / 2;
    this.clampCenter();
  }

  /** @param {number} x @param {number} y @returns {[number, number]} */
  worldToScreen(x, y) {
    return [
      (x - this.centerX) * this.zoom + this.viewWidth / 2,
      (y - this.centerY) * this.zoom + this.viewHeight / 2,
    ];
  }

  /** @param {number} x @param {number} y @returns {[number, number]} */
  screenToWorld(x, y) {
    return [
      (x - this.viewWidth / 2) / this.zoom + this.centerX,
      (y - this.viewHeight / 2) / this.zoom + this.centerY,
    ];
  }

  /** @param {number} dx @param {number} dy Pixels. */
  panPixels(dx, dy) {
    this.centerX -= dx / this.zoom;
    this.centerY -= dy / this.zoom;
    this.clampCenter();
  }

  /**
   * @param {number} screenX
   * @param {number} screenY
   * @param {number} factor
   */
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    const next = Math.min(
      Math.max(this.zoom * factor, this.minZoom),
      this.maxZoom,
    );
    if (next === this.zoom) return;
    this.zoom = next;
    const after = this.screenToWorld(screenX, screenY);
    this.centerX += before[0] - after[0];
    this.centerY += before[1] - after[1];
    this.clampCenter();
  }

  /** Keep the map covering the viewport; center it when it is smaller. */
  clampCenter() {
    const halfWidth = this.viewWidth / (2 * this.zoom);
    const halfHeight = this.viewHeight / (2 * this.zoom);

    if (this.worldWidth <= halfWidth * 2) {
      this.centerX = this.worldWidth / 2;
    } else {
      this.centerX = Math.min(
        Math.max(this.centerX, halfWidth),
        this.worldWidth - halfWidth,
      );
    }

    if (this.worldHeight <= halfHeight * 2) {
      this.centerY = this.worldHeight / 2;
    } else {
      this.centerY = Math.min(
        Math.max(this.centerY, halfHeight),
        this.worldHeight - halfHeight,
      );
    }
  }
}
