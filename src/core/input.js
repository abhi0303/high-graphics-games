/** Keyboard + mouse state. Pressed-once events are delivered through `on(key, fn)`. */
export class Input {
  constructor(element) {
    this.keys = new Set();
    this.handlers = new Map();
    this.mouse = { dx: 0, dy: 0, wheel: 0, dragging: false, lastMove: 0 };
    this.buttons = new Set();
    this.mouseHandlers = new Map();
    this.element = element;
    this.locked = false;
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === element; });
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.handlers.get(e.code)?.forEach((fn) => fn());
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    element.addEventListener('pointerdown', (e) => {
      this.buttons.add(e.button);
      this.mouse.dragging = true;
      if (!this.locked) element.setPointerCapture(e.pointerId);
      this.mouseHandlers.get(e.button)?.forEach((fn) => fn(e));
    });
    element.addEventListener('pointerup', (e) => {
      this.buttons.delete(e.button);
      this.mouse.dragging = this.buttons.size > 0;
      if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    });
    window.addEventListener('blur', () => this.buttons.clear());
    element.addEventListener('pointermove', (e) => {
      // drag to orbit, or free mouse-look while the pointer is locked
      if (!this.mouse.dragging && !this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
      this.mouse.lastMove = performance.now();
    });
    element.addEventListener('wheel', (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  /** Mouse button press handler (0 = left, 2 = right). */
  onMouse(button, fn) {
    if (!this.mouseHandlers.has(button)) this.mouseHandlers.set(button, []);
    this.mouseHandlers.get(button).push(fn);
  }

  /** Capture the mouse for free look (needs a user gesture; Esc releases it). */
  lock() {
    if (this.locked || !this.element.requestPointerLock) return;
    try { this.element.requestPointerLock()?.catch?.(() => {}); } catch { /* not allowed here */ }
  }

  unlock() { if (this.locked) document.exitPointerLock(); }

  /** On-foot movement axes: forward (W/↑ − S/↓), right (D/→ − A/←), run (Shift). */
  onFoot() {
    return {
      forward: (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0),
      right: (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0),
      run: this.down('ShiftLeft', 'ShiftRight'),
      block: this.buttons.has(2),
    };
  }

  on(code, fn) {
    if (!this.handlers.has(code)) this.handlers.set(code, []);
    this.handlers.get(code).push(fn);
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  controls() {
    const throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    const brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    const steer = (this.down('KeyA', 'ArrowLeft') ? 1 : 0) - (this.down('KeyD', 'ArrowRight') ? 1 : 0);
    return { throttle, brake, steer, handbrake: this.down('Space') };
  }

  consumeMouse() {
    const m = { dx: this.mouse.dx, dy: this.mouse.dy, wheel: this.mouse.wheel, idleMs: performance.now() - this.mouse.lastMove };
    this.mouse.dx = this.mouse.dy = this.mouse.wheel = 0;
    return m;
  }
}
