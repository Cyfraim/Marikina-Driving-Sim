# Marikina Driving Simulator

A browser-based 3D driving simulator of Marikina City, Philippines, built on real OpenStreetMap road data.

## Features

- 3D low-poly environment built with Three.js
- **Real road network of Marikina City** - ~4,700 real road polylines (1,040 km) from OpenStreetMap
  data, converted from GPS to scene units (1 unit = 1 metre)
  - Bayan-Bayanan Avenue (14 m, 4 lanes), J. P. Rizal Street (9 m primary), plus 135
    residential/service streets
  - Intersections formed naturally; sidewalks, curbs and dashed lane markings are
    clipped at junctions
- **Road-relative environment** - houses, sari-sari stores, electric posts with
  sagging overhead wires, street lights, open drainage canals, palm + mango trees,
  and parked tricycles/jeepneys are all positioned relative to real road centerlines
  (see `src/utils/roadLayout.js`)
- Arcade-style driving physics
- HUD: analog speedometer with gear indicator (bottom right), subtle
  "MARIKINA CITY" watermark with live street name (bottom left),
  rotating satellite minimap (top right)
- Start screen with the **Marikina Driving Simulator** title, plus a 3-mission campaign and Free Roam mode
- Day/night cycle
- Minimap
- Mobile touch controls

## World layout

- `src/world/roadData.js` - hardcoded real GPS road polylines (regenerate with
  `tools/generate-road-data.ps1` from an Overpass API dump)
- `src/utils/geo.js` - GPS -> scene conversion (`MAP_ORIGIN` = 14.6508, 121.1080)
- `src/utils/roadLayout.js` - road sampling, junction detection, placement checks
- `src/utils/coloredMesh.js` - merged vertex-colored mesh builder (low draw calls)
- `tools/check-*.mjs` - headless validation scripts (geometry, NaN, road overlap)


## Requirements

- Node.js (v16 or higher recommended)
- A modern web browser with WebGL support

## Setup & Running

1. Open the project folder in VS Code:
   ```bash
   code "d:\Downloads\Nangka Driving Sim"
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser to the URL shown (typically `http://localhost:3000/`)

## Controls

| Key | Action |
|-----|--------|
| W / Arrow Up | Accelerate |
| S / Arrow Down | Brake / Reverse |
| A / Arrow Left | Steer Left |
| D / Arrow Right | Steer Right |
| Space | Handbrake |
| R | Reset Vehicle |
| V | First / Third Person camera |
| Q / E | Look around (first person) |
| Mouse drag | Look around (first person) |
| M | Satellite overlay on the ground (dev, needs API key) |
| Escape | Pause Menu |

## Project Structure

```
marikina-driving-simulator/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json          # Vercel build/deploy config
├── public/
│   └── favicon.svg
├── src/
│   ├── main.js
│   ├── style.css
│   ├── game/
│   │   ├── Game.js
│   │   ├── Vehicle.js
│   │   ├── Camera.js
│   │   └── Input.js
│   ├── world/
│   │   ├── Map.js
│   │   ├── Roads.js
│   │   ├── Buildings.js
│   │   ├── Vegetation.js
│   │   ├── StreetObjects.js
│   │   ├── Landmarks.js
│   │   ├── TrafficLights.js
│   │   ├── SpeedSigns.js
│   │   ├── Weather.js
│   │   └── roadData.js
│   ├── npcs/
│   │   ├── NPCVehicle.js
│   │   └── Pedestrian.js
│   ├── ui/
│   │   ├── HUD.js
│   │   ├── Menu.js
│   │   ├── Minimap.js
│   │   ├── MissionSystem.js
│   │   └── Speedometer.js
│   └── utils/
│       ├── geo.js
│       ├── roadLayout.js
│       ├── RoadGraph.js
│       ├── boundary.js
│       ├── coloredMesh.js
│       ├── mapLoader.js
│       └── Audio.js
└── tools/               # headless validation + OSM data generation scripts
```

## Deploying

This is a standard Vite app, so it deploys to Vercel with no extra setup -
`vercel.json` already declares the build settings.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Marikina Driving Simulator"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

`.env` and `.cache/` are already in `.gitignore`, so your API key and the 4 MB
Overpass dump stay local.

### 2. Deploy to Vercel

**Option A - Dashboard (easiest)**

1. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
2. Framework preset **Vite** is detected automatically. Keep:
   - Build Command: `npm run build`
   - Output Directory: `dist`
3. Click **Deploy**.

**Option B - CLI**

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production deployment
```

After the first link, every push to `main` redeploys automatically.

### Google Maps API key (optional)

The satellite overlay (`M` key) needs an API key. Add it in Vercel under
**Project Settings → Environment Variables**:

| Name | Value |
|------|-------|
| `GOOGLE_MAPS_API_KEY` | your key from [Google Cloud Console](https://console.cloud.google.com/) with "Maps Static API" enabled |

Set it for **Production**, **Preview**, and **Development**, then redeploy.
Without a key the game still runs - the minimap simply falls back to the
vector map built from `roadData.js`.

## License

MIT - see [LICENSE](./LICENSE). A game-inspired approximation of Marikina City
for educational/entertainment purposes. Road data (c) OpenStreetMap
contributors, ODbL.
