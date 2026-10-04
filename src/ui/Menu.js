export class Menu {
  constructor(game) {
    this.game = game;
    this.mainMenu = document.getElementById('main-menu');
    this.controlsOverlay = document.getElementById('controls-overlay');
    this.settingsOverlay = document.getElementById('settings-overlay');
    this.bindEvents();
  }

  bindEvents() {
    // FIX 3: dalawang mode - "START MISSIONS" at "FREE ROAM"
    document.getElementById('btn-start').addEventListener('click', () => {
      this.game.startGame(true);
    });
    document.getElementById('btn-freeroam').addEventListener('click', () => {
      this.game.startGame(false);
    });
    document.getElementById('btn-controls').addEventListener('click', () => {
      this.controlsOverlay.classList.remove('hidden');
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      this.settingsOverlay.classList.remove('hidden');
    });
    document.getElementById('btn-close-controls').addEventListener('click', () => {
      this.controlsOverlay.classList.add('hidden');
    });
    document.getElementById('btn-close-settings').addEventListener('click', () => {
      this.settingsOverlay.classList.add('hidden');
    });
    // Settings handlers
    document.getElementById('setting-sfx-volume')?.addEventListener('input', (e) => {
      this.game.audio?.setVolume(Number(e.target.value) / 100);
    });
    document.getElementById('setting-time').addEventListener('change', (e) => {
      this.game.settings.timeOfDay = e.target.value;
      this.game.setTimeOfDay(e.target.value);
    });
    document.getElementById('setting-traffic').addEventListener('change', (e) => {
      this.game.setTraffic(e.target.value);
    });
    document.getElementById('setting-shadows').addEventListener('change', (e) => {
      this.game.settings.shadows = e.target.value;
      this.game.renderer.shadowMap.enabled = e.target.value === 'on';
    });
  }

  showMainMenu() {
    this.mainMenu.style.display = 'flex';
  }

  hideAll() {
    this.mainMenu.style.display = 'none';
    this.controlsOverlay.classList.add('hidden');
    this.settingsOverlay.classList.add('hidden');
  }
}
