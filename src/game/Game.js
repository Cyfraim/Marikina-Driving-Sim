import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { Input } from './Input.js';
import { CameraController } from './Camera.js';
import { Map } from '../world/Map.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';
import { MissionSystem } from '../ui/MissionSystem.js';
import { Minimap } from '../ui/Minimap.js';
import { NPCManager } from '../npcs/NPCVehicle.js';
import { PedestrianManager } from '../npcs/Pedestrian.js';
import { TrafficLightSystem } from '../world/TrafficLights.js';
import { SpeedSignSystem } from '../world/SpeedSigns.js';
import { Weather } from '../world/Weather.js';
import { AudioFX } from '../utils/Audio.js';
import { MAP_ORIGIN } from '../world/roadData.js';
import { hasApiKey, loadSatelliteImage, metersPerPixel } from '../utils/mapLoader.js';

// Dev overlay: 640x640 satellite tile (max ng Google Static API)
const OVERLAY = { zoom: 16, size: 640 };

export class Game {
  constructor() {
    this.scene = null;
    this.renderer = null;
    this.clock = new THREE.Clock();
    this.isRunning = false;
    this.isPaused = true;
    this.vehicle = null;
    this.input = null;
    this.cameraController = null;
    this.map = null;
    this.hud = null;
    this.menu = null;
    this.minimap = null;
    this.satellitePlane = null; // dev reference plane (M key)
    this.settings = {
      timeOfDay: 'day',
      traffic: 'on',
      shadows: 'on'
    };
  }

  init() {
    try {
      // Create scene
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x87ceeb);
      // Fog: nagtatago sa mga border ng malaking road network (1.5 km+)
      this.scene.fog = new THREE.Fog(0xc8d8e8, 150, 950);

      // Create camera (far plane: sakop ang buong Nangka map)
      const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);
      camera.position.set(0, 10, 20);

      // Create renderer
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.domElement.id = 'game-canvas';
      document.getElementById('app').appendChild(this.renderer.domElement);

      // Lighting
      this.setupLighting();

      // Create world
      this.map = new Map(this.scene);
      this.map.build();

      // Create vehicle
      this.vehicle = new Vehicle(this.scene);
      this.vehicle.build();
      // Start ON Bayan-Bayanan Avenue (real GPS: 3.4 m from centreline),
      // facing east (+x) along the avenue, nasa antas ng lupa
      this.vehicle.reset();

      // Give vehicle collision data from map
      this.vehicle.setCollisionObjects(this.map.getCollisionBoxes());
      // FIX invisible-wall: buildings use OBB (oriented), not AABB
      this.vehicle.setObbColliders(this.map.getObbColliders());
    // FIX 1: invisible boundary walls - road confinement + map boundary
    this.vehicle.setConfinement(this.map.confinement);

      // Input handler
      this.input = new Input();
      this.input.setup();
      // Wire up input callbacks
      this.input.onReset = () => { this.vehicle.reset(); };
      this.input.onCameraToggle = () => { this.cameraController.toggleMode(); };
      this.input.onPause = () => { this.togglePause(); };
      this.input.onSatelliteToggle = () => { this.toggleSatellitePlane(); };
    // PHASE 2C: H = horn
    this.input.onHorn = () => { if (this.audio) this.audio.horn(); };
    // PHASE 2D: F = weather toggle (Clear -> Light -> Heavy -> Clear)
    this.input.onWeatherToggle = () => { this.cycleWeather(); };

      // Camera controller
      this.cameraController = new CameraController(camera, this.vehicle);

      // UI
      this.hud = new HUD(this);
      this.menu = new Menu(this);
      this.minimap = new Minimap(this);

      // FIX 3: mission system. Ang scene at camera ay kailangan para sa mga
      // 3D beacon (cylinder) at checkpoint rings (torus).
      this.missionSystem = new MissionSystem(this);
      this.missionSystem.init(this.scene, this.cameraController
        ? this.cameraController.camera
        : this.camera);

      // PHASE 1: 1B - NPC vehicles (15 tricycle + 8 jeepney) na naka-drive sa
      // kalsada. 1C - 30 pedestrian na naglalakbay sa sidewalk.
      // NOTE: ito ay labas sa tile system (hindi per-tile) - sila ay maliit
      // at nakakalat sa buong lungsod, kaya isang Group lang ang kailangan.
      this.npcManager = new NPCManager(this.scene);
      this.pedestrianManager = new PedestrianManager(this.scene);
      this.weatherSpeedScale = 1;   // Phase 2D: 0.7 sa malakas na ulan

      // PHASE 2A: 20 semaphore sa pinakamataong intersection
      this.trafficLights = new TrafficLightSystem(this.scene);
      // PHASE 2B: speed limit signs (60/40/20 km/h)
      this.speedSigns = new SpeedSignSystem(this.scene);
      // PHASE 2C/2D: audio (horn + rain) at weather
      this.audio = new AudioFX();
      this.audioFocusLost = false;
      this.audioBlurListener = () => { this.audioFocusLost = true; this.audio.setActive(false); };
      this.audioFocusListener = () => {
        this.audioFocusLost = false;
        this.audio.setActive(!this.isPaused && !document.hidden);
      };
      this.audioVisibilityListener = () => {
        if (document.hidden) this.audioBlurListener();
        else this.audioFocusListener();
      };
      window.addEventListener('blur', this.audioBlurListener);
      window.addEventListener('focus', this.audioFocusListener);
      document.addEventListener('visibilitychange', this.audioVisibilityListener);
      this.audioUnloadListener = () => {
        window.removeEventListener('blur', this.audioBlurListener);
        window.removeEventListener('focus', this.audioFocusListener);
        document.removeEventListener('visibilitychange', this.audioVisibilityListener);
        this.audio.destroy();
      };
      window.addEventListener('beforeunload', this.audioUnloadListener, { once: true });
      this.weather = new Weather(this.scene);
      // NOTE: ang fog/original sky ay kailangan para sa weather toggle
      this.baseFogNear = this.scene.fog.near;
      this.baseFogFar = this.scene.fog.far;

      // Window resize
      window.addEventListener('resize', () => this.onResize());

      // Detect mobile for touch controls
      if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        document.getElementById('touch-controls').classList.remove('hidden');
      }

      // Hide loading, show menu
      document.getElementById('loading').classList.add('hidden');
      this.menu.showMainMenu();

      // Start render loop
      this.animate();
    } catch (error) {
      console.error('Game initialization error:', error);
      this.showError(error);
    }
  }

  showError(error) {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.innerHTML = `
        <div class="loading-content">
          <h2 style="color: #e94560;">Error Loading Game</h2>
          <p style="color: #ff6b6b; margin-top: 10px;">${error.message}</p>
          <p style="color: #999; margin-top: 20px; font-size: 0.9rem;">Check the browser console for details.</p>
          <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 30px; background: #e94560; color: #fff; border: none; border-radius: 5px; cursor: pointer;">Reload</button>
        </div>
      `;
    }
  }

  setupLighting() {
    // Ambient light
    const ambient = new THREE.AmbientLight(0xfff5e0, 0.6);
    this.ambient = ambient;
    this.scene.add(ambient);

    // Directional light (sun)
    const sun = new THREE.DirectionalLight(0xffe8b0, 1.0);
    sun.position.set(100, 60, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 300;
    sun.shadow.camera.left = -75;
    sun.shadow.camera.right = 75;
    sun.shadow.camera.top = 75;
    sun.shadow.camera.bottom = -75;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.1;
    this.scene.add(sun.target);
    this.scene.add(sun);
    this.sun = sun;

    // Hemisphere light for sky color
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x444444, 0.4);
    this.scene.add(hemi);
    this.hemi = hemi;
  }

  /**
   * PHASE 2D: i-cycle ang panahon (F key) at i-apply ang lahat ng epekto:
   *  - sky color (background + fog)
   *  - fog distance (heavy rain: -40% visibility)
   *  - rain sound gain (0.15 light / 0.4 heavy)
   *  - NPC speed scale (heavy rain: 0.7)
   *  - wet-road shininess (specular)
   */
  cycleWeather() {
    if (!this.weather) return null;
    const w = this.weather.cycle();
    // sky + fog color
    this.applyAtmosphere();
    // rain sound
    if (this.audio) this.audio.setRainGain(w.rainGain);
    // NPC speed: heavy rain -> 70% (spec)
    this.weatherSpeedScale = w.npcScale;
    // wet road: specular (spec) - dahan-dahang lipat, hindi biglaan
    this.setWetness(w.specular);
    return w;
  }

  /**
   * Basang kalsada: dagdagan ang specular ng mga asphalt mesh. Ang
   * MeshStandardMaterial ay may `metalness` + `roughness`; para sa
   * "mamaya-mahinog" na epekto, binabawasan natin ang roughness.
   * Tinitingnan natin ang TILE MANAGER (dahil doon ang mga kalsada), at
   * sinusuri lahat ng scene para sa asphalt/concrete mesh.
   */
  setWetness(spec) {
    // 0x111111 (dry) -> 0x444444/0x666666 (wet). Isang linear na fade.
    const wet = (spec - 0x111111) / (0x666666 - 0x111111);
    const rough = 0.95 - wet * 0.55;   // 0.95 dry -> 0.40 wet
    if (this.map?.roads) this.map.roads.surfaceRoughness = rough;
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (!m || !m.isMeshStandardMaterial) return;
      // mga kalsada: asphalt (0x444444) at concrete (0x999999) surfaces
      if (m.__isRoad !== true) return;
      m.roughness = rough;
      m.needsUpdate = true;
    });
  }

  setTraffic(value) {
    this.settings.traffic = value === 'off' ? 'off' : 'on';
    if (this.npcManager) this.npcManager.setEnabled(this.settings.traffic === 'on');
    if (this.settings.traffic === 'off' && this.vehicle) this.vehicle.setNpcColliders([]);
  }

  setTimeOfDay(time) {
    this.settings.timeOfDay = time === 'night' ? 'night' : 'day';
    this.applyAtmosphere();
  }

  applyAtmosphere() {
    const time = this.settings.timeOfDay;
    const weather = this.weather?.info;
    const fogScale = weather?.fogScale ?? 1;
    if (time === 'night') {
      this.scene.background = new THREE.Color(0x0a0a2a);
      this.scene.fog = new THREE.Fog(0x0a0a2a, 50, 300);
      this.sun.intensity = 0.2;
      this.hemi.intensity = 0.1;
      this.ambient.intensity = 0.15;
    } else {
      this.scene.background = new THREE.Color(weather?.sky ?? 0x87ceeb);
      this.scene.fog = new THREE.Fog(this.weather?.isRaining ? weather.sky : 0xc8d8e8, 150, 950);
      this.sun.intensity = 1.0;
      this.hemi.intensity = 0.4;
      this.ambient.intensity = 0.6;
    }
    this.scene.fog.near *= fogScale;
    this.scene.fog.far *= fogScale;
  }

  updateShadows() {
    if (!this.sun || !this.vehicle) return;
    const p = this.vehicle.position;
    // Move light AND target together to preserve afternoon direction.
    this.sun.target.position.copy(p);
    this.sun.position.set(p.x + 100, p.y + 60, p.z + 50);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /**
   * Dev reference plane (M): naka-s superimpose ang tunay na satellite
   * image sa lupa para makita kung tugma ang 3D geometry sa totoong Nangka.
   * Eksaktong sukat: metersPerPixel * tileSize, naka-center sa MAP_ORIGIN.
   */
  async toggleSatellitePlane() {
    if (this.satellitePlane) {
      this.scene.remove(this.satellitePlane);
      this.satellitePlane.geometry.dispose();
      this.satellitePlane.material.map?.dispose();
      this.satellitePlane.material.dispose();
      this.satellitePlane = null;
      this.notify('Satellite overlay: OFF');
      return;
    }
    if (!hasApiKey()) {
      this.notify('Wala pang GOOGLE_MAPS_API_KEY sa .env');
      return;
    }
    const img = await loadSatelliteImage({
      center: MAP_ORIGIN,
      zoom: OVERLAY.zoom,
      width: OVERLAY.size,
      height: OVERLAY.size,
      mapType: 'satellite',
    });
    if (!img) {
      this.notify('Hindi ma-load ang satellite image');
      return;
    }
    const mpp = metersPerPixel(MAP_ORIGIN.lat, OVERLAY.zoom);
    const span = OVERLAY.size * mpp; // metro na saklaw ng tile (e.g. ~1479 m)
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9 })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, 0.05, 0); // nasa itaas ng asphalt, sa ilalim ng bangketa
    plane.renderOrder = 1;
    this.scene.add(plane);
    this.satellitePlane = plane;
    this.notify(`Satellite overlay: ON (${Math.round(span)} m)`);
  }

  // Maliit na notification sa gitna ng screen (gaya ng camera mode)
  notify(text) {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'background:rgba(0,0,0,0.7);color:#fff;padding:10px 20px;border-radius:5px;' +
      'font-size:1.1rem;z-index:100;pointer-events:none;';
    el.textContent = text;
    document.getElementById('app').appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  /**
   * @param withMissions true = "Start Missions" (buong campaign),
   *                     false = "Free Roam" (walang mission)
   */
  startGame(withMissions = true) {
    this.isPaused = false;
    this.audio?.setActive(true);
    this.audio?.resume();
    this.hud.show();
    this.menu.hideAll();
    // Reset vehicle to starting position
    this.vehicle.reset();
    // FIX 3: ituloy ang campaign o mag-free-roam
    if (this.missionSystem) {
      if (withMissions) this.missionSystem.startCampaign();
      else this.missionSystem.startFreeRoam();
    }
  }

  /**
   * FIX 2: tile streaming tick.
   *
   * Ang unang load ay malaking bagay (~49 tile), kaya ang TileManager ay
   * may TIME BUDGET: gumagawa ito ng tile hanggang maubos ang badget, at
   * ipinapagpatuloy sa susunod na frame. Kung hindi, mag-hang ang game sa
   * unang 2-3 segundo.
   */
  updateTiles() {
    const stats = this.map.update(this.vehicle.position);
    if (!stats) return;
    if (stats.built !== this._lastTileBuilt) {
      this._lastTileBuilt = stats.built;
      // may bagong tile -> kailangang i-refresh ang collider ng kotse
      this.vehicle.setCollisionObjects(this.map.getCollisionBoxes());
      this.vehicle.setObbColliders(this.map.getObbColliders());
    }
  }

  animate() {
    try {
      const delta = this.clock.getDelta();

      if (!this.isPaused) {
        // Update vehicle physics
        this.vehicle.update(delta, this.input);
        this.audio?.update(this.vehicle, this.input);
        if (this.vehicle.impactStrength) this.audio?.impact(this.vehicle.impactStrength);

        // FIX 2: TILE STREAMING. I-load/unload/cull ang mga 400 m tile
        // ayon sa posisyon, at ire-refresh ang collider ng kotse kapag may
        // bagong tile (dahil per-tile na ang mga ito).
        this.updateTiles();

        // FIX 3: mission tick - live distance, checkpoint detection, pulse
        if (this.missionSystem) this.missionSystem.update(this.vehicle.position, delta);

        // PHASE 1 (1B): i-update ang mga NPC vehicle at ipasa ang kanilang
        // AABB colliders sa kotse. `weatherSpeedScale` ay 1.0 malinis at 0.7
        // sa malakas na ulan (Phase 2D).
        if (this.npcManager) {
          const trafficOn = this.settings.traffic === 'on';
          this.npcManager.setEnabled(trafficOn);
          this.vehicle.setNpcColliders(trafficOn
            ? this.npcManager.update(delta, this.vehicle.position,
              this.weatherSpeedScale, this.trafficLights)
            : []);
        }
        // PHASE 1 (1C): mga pedestrian - culled sa 200 m
        if (this.pedestrianManager) {
          this.pedestrianManager.update(delta, this.vehicle.position);
        }

        // PHASE 2A: i-update ang mga semaphore (absolute time -> state)
        if (this.trafficLights) this.trafficLights.update(this.clock.elapsedTime);
        // PHASE 2D: ulan (particles na nakadikit sa player) + tunog
        if (this.weather) this.weather.update(delta, this.vehicle.position);

        // Update camera
        this.cameraController.update(delta, this.input);

        // Update HUD
        this.hud.update(this.vehicle);

        // Update minimap
        this.minimap.update();
      }

      this.audio?.setActive(!this.isPaused && !this.audioFocusLost && !document.hidden);
      this.updateShadows();
      this.renderer.render(this.scene, this.cameraController.camera);
      // Schedule only after a successful frame: errors stop the loop.
      requestAnimationFrame(() => this.animate());
    } catch (error) {
      console.error('Animation error:', error);
      this.audio?.setActive(false);
      // Stop the animation loop to prevent error spam
      this.showError(error);
    }
  }

  onResize() {
    const camera = this.cameraController.camera;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    this.audio?.setActive(!this.isPaused && !this.audioFocusLost);
    if (!this.isPaused) this.audio?.resume();
    if (this.isPaused) {
      this.menu.showMainMenu();
      this.hud.hide();
    } else {
      this.menu.hideAll();
      this.hud.show();
    }
  }
}


