# Sector to Site Distance Calculator

A web-based tool for calculating distances between telecommunications sectors and sites with beam coverage analysis.

---

## Overview

This application calculates distances between sector locations (TX) and site locations (RX), displaying results on an interactive map with marker clustering visualization. It uses the Haversine formula for accurate geodesic distance calculations and applies azimuth-based beam filtering to determine which sites fall within a sector's coverage area.

---

## Features

- **Dual Mode** - Use a single sector file (combined) or separate sector & site files
- **CSV/Excel Import** - Load data from CSV, TXT, XLS, or XLSX files
- **Interactive Map** - Visualize data on a Leaflet-powered map with marker clustering
- **Distance Calculation** - Calculate distances using the Haversine algorithm
- **Beam Coverage Analysis** - Filter results based on sector azimuth and beamwidth
- **KMZ Export** - Export results to KMZ format for Google Earth
- **Excel Export** - Export results to XLSX format
- **Search & Filter** - Find specific sectors/sites by name, column value, or beam match status
- **Icon Picker** - Customize TX and RX marker icons with color, scale, and opacity
- **Visual Beam Display** - Show sector beam coverage polygons with match/no-match colors
- **Link Lines** - Display connection lines between matched TX-RX pairs
- **Map Layer Switcher** - Choose between Light, Dark, Satellite, or OSM base maps
- **Visibility Controls** - Toggle labels, beams, markers, and legend independently

---

## Calculation Concepts

### 1. Distance Calculation - Haversine Formula

The tool uses the **Haversine formula** to calculate the great-circle distance between two points on a sphere (Earth). This provides accurate results for geographic coordinates.

#### Formula:
```
a = sin²(Δlat/2) + cos(lat1) × cos(lat2) × sin²(Δlon/2)
c = 2 × atan2(√a, √(1-a))
distance = R × c
```

#### Where:
- `Δlat` = difference in latitude (radians)
- `Δlon` = difference in longitude (radians)
- `lat1, lat2` = latitudes in radians
- `R` = Earth's radius (6,371 km)
- `distance` = result in kilometers

### 2. Bearing Calculation

**Bearing** (azimuth) is the direction from point 1 to point 2, measured in degrees clockwise from North.

### 3. Angular Difference

To determine if a site falls within a sector's beam, calculate the angular difference between the bearing to the site and the sector's azimuth.

```
angularDiff = |bearing - azimuth| mod 360
if (angularDiff > 180) then angularDiff = 360 - angularDiff
```

### 4. Beam Coverage Filter

A site is considered "covered" by a sector if:
```
angularDiff(bearingToSite, sectorAzimuth) ≤ (beamwidth / 2)
```

Example: If a sector has azimuth 90° and beamwidth 65°, the coverage spans from 57.5° to 122.5°.

### 5. Distance Units Support

- **Kilometers (km)** - Default, native unit from Haversine
- **Meters (m)** - Multiply km by 1000
- **Feet (ft)** - Multiply km by 3280.84
- **Miles (mi)** - Multiply km by 0.621371

---

## Calculation Modes

### Combined Mode (Sector File Only)
- Upload a single sector file containing both site and sector data
- RX sites are automatically derived from unique TX site locations
- Ideal when all sites are in one spreadsheet

### Separate Mode (Sector & Site)
- Upload a TX sector file and a separate RX site file independently
- Useful when sector and site data come from different sources
- Allows analysis between two different site databases

---

## Complete Data Flow

```
1. User selects calculation mode (Combined or Separate)

2. User imports TX (Sector) file
   └─→ Parse CSV/Excel → Extract: Site, Sector, Lat, Lng, Azimuth

3. [Separate Mode] User imports RX (Site) file
   └─→ Parse CSV/Excel → Extract: Site, Lat, Lng

4. User maps columns and configures settings

5. User clicks "Calculate & Draw"
   └─→ For each TX sector:
       ├─→ Calculate bearing to each RX site
       ├─→ Filter by beamwidth (angular difference)
       ├─→ Filter by max distance (if set)
       ├─→ Sort by distance (nearest first)
       └─→ Return top N nearest sites

6. Results displayed on Map with beams, lines, and markers
```

---

## File Format Requirements

### TX (Sector) Data - Required Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| Site Name | String | Yes | TX site identifier |
| Sector Name | String | Yes | Sector identifier (e.g., CellID, SectorID) |
| Latitude | Number | Yes | GPS latitude (-90 to 90) |
| Longitude | Number | Yes | GPS longitude (-180 to 180) |
| Azimuth | Number | Yes | Beam direction in degrees (0-360) |

### RX (Site) Data - Required Fields (Separate Mode)
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| Site Name | String | Yes | RX site identifier |
| Latitude | Number | Yes | GPS latitude (-90 to 90) |
| Longitude | Number | Yes | GPS longitude (-180 to 180) |

### Example CSV Format (TX Sectors):
```csv
Site,Sector,Lat,Lng,Azimuth
SiteA,Alpha,40.7128,-74.0060,45
SiteA,Beta,40.7128,-74.0060,135
SiteA,Gamma,40.7128,-74.0060,225
SiteB,Alpha,40.7580,-73.9855,90
```

### Example CSV Format (RX Sites):
```csv
Site,Lat,Lng
SiteX,40.7300,-74.0200
SiteY,40.7500,-73.9800
SiteZ,40.7800,-73.9500
```

---

## Usage Guide

### Step 1: Select Mode
1. Open `index.html` in a web browser
2. In the **Upload** tab, expand **Mode**
3. Choose **Sector File Only** (combined) or **Sector & Site** (separate)

### Step 2: Import TX Sectors
1. Expand **Sector File**
2. Drag & drop or browse to select your CSV/Excel file
3. Confirm the record count loads successfully

### Step 3: Import RX Sites (Separate Mode Only)
1. Expand **Site File**
2. Drag & drop or browse to select your CSV/Excel file

### Step 4: Map Columns
1. Switch to the **Columns** tab
2. Map each required field (Site, Sector, Lat, Lng, Azimuth) to the correct column from your file

### Step 5: Configure Style (Optional)
1. Switch to the **Style** tab
2. Customize marker icons, beam colors, line settings, and visibility

### Step 6: Configure Analysis Settings
1. Switch to the **Analysis** tab
2. Set **Beamwidth** (default: 65°)
3. Set **Beam Radius Display** (Fixed or Auto)
4. Set **Max Nearest Neighbors** (default: 3)
5. Set **Distance Unit** (km, m, mi, ft)
6. Set **Distance Limit** (optional)

### Step 7: Run Calculation
1. Click **Calculate & Draw**
2. Wait for the progress bar to complete
3. View results on the map

### Step 8: Export Results
1. Click **Export KMZ** for Google Earth, or **Export Excel** for spreadsheet
2. Save the file to your computer

---

## Calculation Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Beamwidth | Horizontal beam angle in degrees | 65° |
| Beam Radius Display | Fixed (manual km) or Auto (based on result) | Fixed |
| Max Nearest Neighbors | Number of nearest sites to return per sector | 3 |
| Distance Unit | Output unit for distances | km |
| Distance Limit | Filter results by distance with operator (<, <=, >, >=, =) | None |

---

## Map Visualization

### Marker Types
- **TX Markers** - Represent sector source locations (default: green blank paddle)
- **RX Markers** - Represent nearest neighbor sites (default: red blank paddle)

### Beam Display
- **Matched Beams** - Solid polygons for sectors with found neighbors
- **Unmatched Beams** - Dashed polygons for sectors with no matches
- **Link Lines** - Dashed lines connecting TX to matched RX sites

### Map Layers
- **Light** - CartoDB light basemap
- **Dark** - CartoDB dark basemap
- **Satellite** - ArcGIS satellite imagery
- **OSM** - OpenStreetMap standard tiles

### Visibility Controls
- TX/RX Site Markers toggle
- Site Labels toggle
- Beam Labels toggle
- Legend toggle

---

## Search & Filter

- **Text Search** - Filter sites by name (partial match)
- **Column Filter** - Filter TX sectors by a specific column value
- **Beam Match Filter** - Show all, matched only, or unmatched only

---

## Troubleshooting

### "Missing TX or RX data" Error
- Ensure the sector file is loaded and columns are mapped
- In separate mode, ensure the site file is also loaded

### No Results After Calculation
- Increase beamwidth value
- Increase max distance limit
- Check azimuth values are in range 0-360
- Verify the beam match filter is set to "All"

### Incorrect Distances
- Verify coordinate format (decimal degrees)
- Ensure latitude/longitude columns are correctly mapped

### File Upload Issues
- Supported formats: CSV, TXT, XLS, XLSX
- CSV files should be UTF-8 encoded
- Excel files should have data in the first sheet

---

## Technology Stack

- **React 18** - UI framework (via CDN)
- **Babel Standalone** - JSX transformation in browser
- **Leaflet 1.9.4** - Interactive maps
- **Leaflet MarkerCluster 1.5.3** - Map marker clustering
- **PapaParse 5.4.1** - CSV parsing
- **SheetJS (XLSX) 0.18.5** - Excel file handling
- **JSZip 3.10.1** - KMZ archive generation
- **Google Earth KML Icons** - Marker icon library

---

## Browser Compatibility

- Chrome (latest) - Recommended
- Firefox (latest)
- Safari (latest)
- Edge (latest)

---

## File Structure

```
.
├── README.md
└── index.html
```

---

## License

All rights reserved.
