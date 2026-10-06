# Sector To Site/Sector Distance Calculator

A high-performance, privacy-focused, browser-local geospatial analysis tool designed to calculate sector-to-site and sector-to-sector geodesic distances. For every telecom sector (azimuth + beamwidth), it ranks the nearest in-beam neighbors between geographic coordinate datasets (CSV, Excel, KML, GPX, TXT) with interactive WebGL satellite mapping and Google Earth KMZ / Excel export. A dedicated **Face-to-Face** mode determines, for every sector pair, whether both sectors physically point at each other within their beamwidths.

---

## 1. Overview & Core Philosophy

**Sector To Site/Sector Distance Calculator** is engineered for telecom network planning engineers, RF surveyors, GIS professionals, and spatial data analysts who need to measure distances and spatial proximity between infrastructure sites (such as cellular base stations, 4G/5G sectors, towers, fiber nodes, or facility points) without uploading sensitive network data to external cloud servers.

- **100% Client-Side Privacy**: All dataset parsing, spatial trigonometry, sector beam filtering, and KMZ archive compression execute entirely in your web browser. No site data or coordinates are ever transmitted over the network.
- **High-Performance Spatial Engine**: Computationally heavy operations (spherical distance matrices, spatial grid index, sector bearing/beam filtering, binary KMZ archive compilation, and XLSX generation) are optimized with asynchronous chunking and Web Workers to keep the UI responsive at 60 FPS.
- **GPU-Accelerated WebGL Visualization**: Powered by MapLibre GL JS to smoothly render tens of thousands of coordinate points, connection vectors, and azimuth beam wedges across satellite and vector basemaps.
- **Self-Contained Single-File Application**: The entire application, styles, workers, and assets compile into a single portable `.html` file that can be distributed and run completely offline.

---

## 2. Calculation Methods & Spatial Algorithms

### A. Calculation Modes
| Mode | Description | Typical Use Case |
|---|---|---|
| **All Sites (Self-Matrix)** | Measures pairwise distances among all sectors within a single dataset. | Identifying nearest neighboring cell towers within an existing network for handover and neighbor-list planning. |
| **Source & Target (Pairwise / Bipartite)** | Measures each site in the **File Dataset** against sites in an independent **Target Dataset**. | Measuring new site candidate locations against existing live towers or competitor sites. |

---

### B. Calculation Methods

#### 1. Sector Beam Mode (Default)
Models each site as a directional telecom sector with an **azimuth** and **beamwidth**. Only target sites falling inside the sector's directional radiation beam are ranked as neighbors.

- **Azimuth**: Sector direction in degrees clockwise from true north ($0^\circ$–$360^\circ$).
- **Beamwidth**: Angular span of the sector ($10^\circ$ to $360^\circ$, default $65^\circ$). Direct numeric input box and slider controls.
- **Angle Filtering**: A target is inside the beam iff:
  $$\text{angleDiff}(\text{bearing}, \text{azimuth}) \le \frac{\text{beamWidth}}{2}$$
- **Bearing**: Computed using the standard initial great-circle bearing:
  $$y = \sin(\Delta\lambda)\cos\phi_2, \quad x = \cos\phi_1\sin\phi_2 - \sin\phi_1\cos\phi_2\cos(\Delta\lambda), \quad \theta = \text{atan2}(y, x)$$
- **Distance**: Calculated with the Great-Circle (Haversine) spherical metric:
  $$\Delta\sigma = 2 \arcsin \left( \sqrt{\sin^2\left(\frac{\Delta\phi}{2}\right) + \cos\phi_1 \cos\phi_2 \sin^2\left(\frac{\Delta\lambda}{2}\right)} \right), \quad d = R \cdot \Delta\sigma$$

#### 2. Face-to-Face Mode
Determines, for every sector pair, whether the two sectors **point directly at each other** within their respective horizontal beamwidths:
1. Calculates mutual great-circle distance and reciprocal bearings (Bearing A→B and Bearing B→A).
2. Computes the angular difference between each sector's azimuth and the line of sight:
   $$\text{Diff A} = \text{angleDiff}(\text{Azimuth A}, \text{Bearing A}\to\text{B})$$
   $$\text{Diff B} = \text{angleDiff}(\text{Azimuth B}, \text{Bearing B}\to\text{A})$$
3. Evaluates mutual visibility: **FACE-TO-FACE** iff:
   $$\text{Diff A} \le \frac{\text{Beamwidth A}}{2} \quad \text{AND} \quad \text{Diff B} \le \frac{\text{Beamwidth B}}{2}$$
4. Ranks and connects the top $N$ nearest facing neighbors per sector.
5. Optimized with a $O(N)$ 2D spatial grid index for instant multi-thousand sector analysis.

#### 3. Nearest Neighbors (Omni KNN)
Calculates the closest $N$ neighbors for each site in all directions ($360^\circ$ isotropic search), ignoring sector azimuth.

#### 4. Voronoi Diagram
Generates Delaunay triangulation and Voronoi Thiessen polygon cells to partition the geographic service area for each site.

---

### C. Configurable Parameters & Beam Radius Display

- **Output Distance Unit**: Kilometers (`km`), Meters (`m`), Miles (`mi`), or Feet (`ft`).
- **Horizontal Beamwidth**: Direct numeric input box + slider ($10^\circ$ to $360^\circ$, default $65^\circ$).
- **Beam Radius Display**: Controls the visual fan wedge radius on the map:
  - **Fixed (Default)**: Set a fixed radius from **30 m to 800 m** (default **350 m**).
  - **Auto**: Automatically scales each sector's wedge to $1.15\times$ the distance of its farthest matched neighbor.
  - **Column Assign**: Select any attribute column (e.g. `Band`, `Frequency`, `Technology`, `Layer`) to assign custom radius values (30–800 m) per distinct category, with a customizable default fallback.
- **Max Nearest Neighbors ($N$)**: 1 to 50 nearest candidates per sector.
- **Distance Limit**: Filter connections by distance operators (`<`, `<=`, `=`, `>`, `>=`) with explicit **`km`** unit limit.

---

## 3. Google Earth KMZ & Excel Export System

### A. Google Earth KMZ Export
Generates a fully styled `.kmz` archive viewable in Google Earth Pro (Desktop), Google Earth Web, and mobile GIS apps:
- **Sites Folder**: Placemarks with custom vector pins, mapped metadata attributes, azimuth headings, and formatted popup summaries.
- **Sector Beams Folder**: True-to-scale directional 3D polygon wedges with azimuth angle, beamwidth, calculated radius, and matched/unmatched status styling.
- **Connections Folder**: Color-coded 3D geodesic line vectors with midpoint distance labels connecting matched sector pairs.
- **Voronoi Polygons Folder**: Polygon boundaries for Voronoi partition coverage cells (when in Voronoi mode).

### B. Excel (.xlsx) Export
Produces a comprehensive, multi-column analysis workbook that accounts for **all sectors** (both meeting and not meeting search criteria):
- In **Sector Beam / KNN Mode**: Exports `Detailed_Distances` with source site, azimuth, neighbor site, distance (in selected output unit), rank ($1$ to $N$), `Criteria Met` status (`YES`/`NO`), and descriptive reason for sectors with no in-beam candidate in range.
- In **Face-to-Face Mode**: Exports `Face_to_Face` with Site A, Azimuth A, Site B, Azimuth B, Beamwidths, Distance, Bearings, Angular Diffs, `Face-to-Face` and `Criteria Met` status flags, plus explicit reasons for non-facing or out-of-range sectors.

---

## 4. User Guide & Step-by-Step Workflow

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [≡] Sector To Site/Sector Distance         [🔍 Search site name or any field…]   [10,000 points]│
├──────────────────────┬───────────────────────────────────────────────────────────────────────────┤
│ [File Input] [Fields]│                                                                           │
│ [Style]      [Export]│                         INTERACTIVE MAP                                   │
│ ─────────────────────┤                       (MapLibre GL WebGL)                                 │
│ Step 01: Data Input  │                                                                           │
│ Step 02: Fields      │               [Selected Site Focus & Zoom-in]                             │
│ Step 03: Style       │            [Directional Fans / Connection Lines]                          │
│ Step 04: Analysis &  │                                                                           │
│          Export      │                                                                           │
│ ─────────────────────┤                                                                           │
│ [Calculate & Draw]   │                                                                           │
└──────────────────────┴───────────────────────────────────────────────────────────────────────────┘
```

### Step 01: File Input
- Open the **File Input** tab.
- Drag & drop your coordinate file (`.csv`, `.xlsx`, `.xls`, `.txt`, `.kml`, `.gpx`).
- Choose **All Sites** (intra-dataset analysis) or **Source & Target** (inter-dataset analysis).
- For multi-sheet Excel files, select the active worksheet from the dropdown.

### Step 02: Fields Mapping
- Open the **Fields** tab.
- Map the core fields: **Site Name**, **Latitude**, **Longitude**, and optional **Azimuth** ($0$–$360^\circ$).
- Select which extra columns to include in interactive map popups.

### Step 03: Style
- Open the **Style** tab to customize:
  - Marker icon shape, color, and scale ($0.5\times$–$3\times$).
  - Connection line color, thickness ($1$–$10\text{px}$), and opacity.
  - Sector beam fan wedge visibility and site label display.

### Step 04: Analysis & Export
- Open the **Export** tab:
  - Choose the **Calculation Method** (Sector Beam, Face to Face, Nearest Neighbors, or Voronoi).
  - Select the **Output Distance Unit** (`km`, `m`, `mi`, `ft`).
  - Configure **Horizontal Beamwidth** (type in numeric box or adjust slider).
  - Set **Beam Radius Display** mode (`Fixed` @ 350m, `Auto`, or `Column Assign`).
  - Set **Max Nearest Neighbors ($N$)** and optional **Distance Limit (km)**.
- Click **Calculate & Draw** (or press `Ctrl` + `Enter` / `Cmd` + `Enter`).
- Review visual connections on the map, click any site for attribute inspection, or search site names in the top search bar.
- Click **Export KMZ** or **Export Excel** to save the results.

---

## 5. Supported File Formats & Auto-Detection

| Extension | Format | Features / Behavior |
|---|---|---|
| `.csv` | Comma-Separated Values | Auto-detects delimiters (comma, tab, semicolon, pipe), strips UTF-8 BOM, supports quoted multiline values. |
| `.xlsx` / `.xls` | Microsoft Excel | High-speed binary parsing with multi-sheet workbook dropdown picker. |
| `.txt` | Delimited Text Files | Tab- or comma-delimited coordinate tables. |
| `.kml` | Keyhole Markup Language | Extracts `Point` coordinates and `ExtendedData` XML attributes. |
| `.gpx` | GPS Exchange Format | Extracts Waypoints (`<wpt>`) and track points with metadata. |

### Smart Column Detection
The engine automatically matches standard telecom and GIS column naming conventions:
- **Site Name**: `site name`, `sitename`, `site_id`, `cellid`, `cell_name`, `sector`, `name`, `id`
- **Latitude**: `latitude`, `lat`, `y`, `lat_dd`, `site_lat`, `cell_lat`, `northing`
- **Longitude**: `longitude`, `long`, `lon`, `lng`, `x`, `site_lon`, `cell_lon`, `easting`
- **Azimuth**: `azimuth`, `azi`, `az`, `bearing`, `dir`, `direction`

---

## 6. Technical Stack

- **UI Layer**: React 19, TypeScript 5, Tailwind CSS 4, Vite 7
- **Mapping Canvas**: MapLibre GL JS `v5.6.0` (WebGL vector tiles, satellite rasters, polygon fans, and connection lines)
- **Spatial Geometry**: Great-Circle / Haversine trigonometry, $O(N)$ 2D spatial grid indexing, spherical bearing math
- **File Parsers**: SheetJS (`xlsx`), PapaParse, `@tmcw/togeojson`
- **Export Packaging**: JSZip `v3.10.1`, FileSaver.js `v2.0.5`
- **Single-File Bundler**: `vite-plugin-singlefile` (compiles all HTML, CSS, JS, and assets into a single portable `dist/index.html` file)

---

## 7. Development & Build

### Prerequisites
- Node.js `18.0.0` or higher
- npm `9.0.0` or higher

```bash
# 1. Install dependencies
npm install

# 2. Start local dev server
npm run dev

# 3. Build standalone single-file production asset
npm run build

# 4. Preview production build
npm run preview
```

The compiled application is generated at `dist/index.html`. It runs completely standalone and offline in any modern web browser.

---

## 8. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl` + `Enter` / `Cmd` + `Enter` | Run Distance Calculation & Draw Map |
| `Ctrl` + `E` / `Cmd` + `E` | Export to Google Earth KMZ |
| `Ctrl` + `L` / `Cmd` + `L` | Toggle Map Legend |
| `Ctrl` + `B` / `Cmd` + `B` | Toggle Configuration Sidebar |

---

## License

This project is licensed under the MIT License.
