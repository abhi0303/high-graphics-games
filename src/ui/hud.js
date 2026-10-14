/** DOM HUD: speedometer, gear, camera label, stats. Updates are throttled to avoid layout churn. */
export class Hud {
  constructor() {
    this.el = document.getElementById('hud');
    this.speed = document.getElementById('speed');
    this.unit = document.getElementById('speed-unit');
    this.gear = document.getElementById('gear');
    this.help = document.getElementById('help');
    this.stats = document.getElementById('stats');
    this.camLabel = document.getElementById('camera-label');
    this.promptEl = document.getElementById('prompt');
    this.hintEl = document.getElementById('hint');
    this.metric = true;
    this.t = 0;
    this.frames = 0;
    this.fps = 0;
    this.fpsT = 0;
    this.lastSpeed = -1;
  }

  show() { this.el.classList.remove('hidden'); }
  toggleHelp() { this.help.classList.toggle('hidden'); }
  toggleStats() { this.stats.classList.toggle('hidden'); }
  toggleUnits() { this.metric = !this.metric; this.unit.textContent = this.metric ? 'km/h' : 'mph'; this.lastSpeed = -1; }

  /** 'driving' | 'onfoot': swaps help text, hides the speedometer on foot, shows the controls hint on exit. */
  setMode(mode) {
    this.el.classList.toggle('onfoot', mode === 'onfoot');
    if (mode === 'onfoot') {
      this.hintEl.classList.add('show');
      clearTimeout(this._hintTimer);
      this._hintTimer = setTimeout(() => this.hintEl.classList.remove('show'), 7000);
    } else this.hintEl.classList.remove('show');
  }

  /** Context prompt (e.g. "E  Enter vehicle"); null hides it. */
  prompt(text) {
    if (text) this.promptEl.textContent = text;
    this.promptEl.classList.toggle('show', !!text);
  }

  flashCamera(name) {
    this.camLabel.textContent = name;
    this.camLabel.classList.add('show');
    clearTimeout(this._camTimer);
    this._camTimer = setTimeout(() => this.camLabel.classList.remove('show'), 1400);
  }

  update(dt, vehicle, renderer) {
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) { this.fps = this.frames / this.fpsT; this.frames = 0; this.fpsT = 0; }
    this.t += dt;
    if (this.t < 0.08) return;
    this.t = 0;
    const v = Math.abs(vehicle.speed) * (this.metric ? 3.6 : 2.23694);
    const shown = Math.round(v);
    if (shown !== this.lastSpeed) { this.speed.textContent = shown; this.lastSpeed = shown; }
    const g = vehicle.reversing && vehicle.speed < 0.5 ? 'R' : Math.abs(vehicle.speed) < 0.3 ? 'N' : 'D';
    if (this.gear.textContent !== g) this.gear.textContent = g;
    if (!this.stats.classList.contains('hidden')) {
      const i = renderer.info;
      this.stats.textContent = `fps   ${this.fps.toFixed(0)}\nres   ${(this.resolution?.() ?? 1).toFixed(2)}x\ncalls ${i.render.calls}\ntris  ${(i.render.triangles / 1e6).toFixed(2)}M\ngeom  ${i.memory.geometries}\ntex   ${i.memory.textures}`;
    }
  }
}
