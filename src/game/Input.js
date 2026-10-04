export class Input {
  constructor() {
    this.forward = false;
    this.backward = false;
    this.left = false;
    this.right = false;
    this.handbrake = false;
    this.reset = false;
    this.cameraToggle = false;
    this.satelliteToggle = false;
    this.lookLeft = false;     // Q/E - pagtingin sa first person
    this.lookRight = false;
    this.keys = {};
    this.onReset = null;
    this.onCameraToggle = null;
    this.onPause = null;
    this.onSatelliteToggle = null;
    // PHASE 2: 2C horn (H), 2D weather (F - hindi R, yan ang reset)
    this.onHorn = null;
    this.onWeatherToggle = null;
    this.horn = false;
    this.weatherToggle = false;
    this.listeners = [];
    this.isSetup = false;
    this.keyDownListener = (e) => this.onKeyDown(e);
    this.keyUpListener = (e) => this.onKeyUp(e);
    this.blurListener = () => this.resetStates();
    this.visibilityListener = () => {
      if (document.hidden) this.resetStates();
    };
  }

  setup() {
    if (this.isSetup) return;
    this.isSetup = true;
    this.listen(window, 'keydown', this.keyDownListener);
    this.listen(window, 'keyup', this.keyUpListener);
    this.listen(window, 'blur', this.blurListener);
    this.listen(document, 'visibilitychange', this.visibilityListener);
    // Touch controls
    this.setupTouch();
  }

  listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  resetStates() {
    for (const prop of ['forward', 'backward', 'left', 'right', 'handbrake',
      'reset', 'cameraToggle', 'satelliteToggle', 'lookLeft', 'lookRight',
      'horn', 'weatherToggle']) this[prop] = false;
    for (const code of Object.keys(this.keys)) this.keys[code] = false;
  }

  onKeyDown(e) {
    this.keys[e.code] = true;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': this.forward = true; break;
      case 'KeyS': case 'ArrowDown': this.backward = true; break;
      case 'KeyA': case 'ArrowLeft': this.left = true; break;
      case 'KeyD': case 'ArrowRight': this.right = true; break;
      case 'Space': this.handbrake = true; e.preventDefault(); break;
      case 'KeyR':
        if (!this.reset) { this.reset = true; if (this.onReset) this.onReset(); }
        break;
      case 'KeyM':
        if (!this.satelliteToggle) {
          this.satelliteToggle = true;
          if (this.onSatelliteToggle) this.onSatelliteToggle();
        }
        break;
      case 'KeyC':
        if (!this.cameraToggle) { this.cameraToggle = true; if (this.onCameraToggle) this.onCameraToggle(); }
        break;
      case 'KeyV':
        if (!this.cameraToggle) { this.cameraToggle = true; if (this.onCameraToggle) this.onCameraToggle(); }
        break;
      case 'KeyQ': this.lookLeft = true; break;
      case 'KeyE': this.lookRight = true; break;
      // PHASE 2C: H = horn
      case 'KeyH':
        if (!this.horn) { this.horn = true; if (this.onHorn) this.onHorn(); }
        break;
      // PHASE 2D: F = weather toggle (R ang reset, kaya hindi F)
      case 'KeyF':
        if (!this.weatherToggle) {
          this.weatherToggle = true;
          if (this.onWeatherToggle) this.onWeatherToggle();
        }
        break;
      case 'Escape':
        if (this.onPause) this.onPause();
        break;
    }
  }

  onKeyUp(e) {
    this.keys[e.code] = false;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': this.forward = false; break;
      case 'KeyS': case 'ArrowDown': this.backward = false; break;
      case 'KeyA': case 'ArrowLeft': this.left = false; break;
      case 'KeyD': case 'ArrowRight': this.right = false; break;
      case 'Space': this.handbrake = false; break;
      case 'KeyR': this.reset = false; break;
      case 'KeyC': this.cameraToggle = false; break;
      case 'KeyV': this.cameraToggle = false; break;
      case 'KeyQ': this.lookLeft = false; break;
      case 'KeyE': this.lookRight = false; break;
      case 'KeyM': this.satelliteToggle = false; break;
      case 'KeyH': this.horn = false; break;
      case 'KeyF': this.weatherToggle = false; break;
    }
  }

  setupTouch() {
    const bindTouch = (id, prop) => {
      const el = document.getElementById(id);
      if (!el) return;
      const touchStart = (e) => { e.preventDefault(); this[prop] = true; };
      const touchEnd = (e) => { e.preventDefault(); this[prop] = false; };
      const mouseDown = () => { this[prop] = true; };
      const mouseUp = () => { this[prop] = false; };
      this.listen(el, 'touchstart', touchStart, { passive: false });
      this.listen(el, 'touchend', touchEnd, { passive: false });
      this.listen(el, 'touchcancel', touchEnd, { passive: false });
      this.listen(el, 'mousedown', mouseDown);
      this.listen(el, 'mouseup', mouseUp);
      this.listen(el, 'mouseleave', mouseUp);
    };
    bindTouch('touch-left', 'left');
    bindTouch('touch-right', 'right');
    bindTouch('touch-gas', 'forward');
    bindTouch('touch-brake', 'backward');
  }

  destroy() {
    for (const { target, type, listener, options } of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    this.listeners.length = 0;
    this.isSetup = false;
    this.resetStates();
  }
}
