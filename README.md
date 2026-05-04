# Sector to Site Distance Calculator

A web-based tool for calculating distances between telecommunications sectors and sites with beam coverage analysis.

---

## Overview

This application calculates distances between sector locations (TX) and site locations (RX), displaying results on an interactive map with marker clustering visualization. It uses the Haversine formula for accurate geodesic distance calculations and applies azimuth-based beam filtering to determine which sites fall within a sector's coverage area.

---

## Features

- **CSV/Excel Import** - Load sector and site data from CSV or Excel files
- **Interactive Map** - Visualize data on a Leaflet-powered map with marker clustering
- **Distance Calculation** - Calculate distances between sectors and sites using Haversine algorithm
- **Beam Coverage Analysis** - Filter results based on sector azimuth and beamwidth
- **Data Export** - Export results to CSV, Excel, or KML format
- **Search & Filter** - Find specific sectors or sites by name
- **Grid View** - View data in tabular format with sorting and filtering
- **Visual Beam Display** - Show sector beam coverage polygons on the map

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

#### Implementation:
```javascript
function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)² + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)²;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

### 2. Bearing Calculation

**Bearing** (azimuth) is the direction from point 1 to point 2, measured in degrees clockwise from North.

#### Formula:
```
θ = atan2(sin(Δlon) × cos(lat2), cos(lat1) × sin(lat2) - sin(lat1) × cos(lat2) × cos(Δlon))
bearing = (θ × 180/π + 360) % 360
```

#### Implementation:
```javascript
function bearingDeg(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
```

### 3. Angular Difference

To determine if a site falls within a sector's beam, calculate the angular difference between the bearing to the site and the sector's azimuth.

#### Formula:
```
angularDiff = |bearing - azimuth| mod 360
if (angularDiff > 180) then angularDiff = 360 - angularDiff
```

#### Implementation:
```javascript
function angularDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}
```

### 4. Beam Coverage Filter

A site is considered "covered" by a sector if:
```
angularDiff(bearingToSite, sectorAzimuth) ≤ (beamwidth / 2)
```

Example: If a sector has azimuth 90° and beamwidth 65°, the coverage spans from 57.5° to 122.5°.

### 5. Distance Units Support

The tool supports multiple distance units with automatic conversion:
- **Kilometers (km)** - Default, native unit from Haversine
- **Meters (m)** - Multiply km by 1000
- **Feet (ft)** - Multiply km by 3280.84
- **Miles (mi)** - Multiply km by 0.621371

---

## Complete Data Flow

```
1. User imports TX (Sector) file
   └─→ Parse CSV/Excel → Extract: Site, Sector, Lat, Lng, Azimuth

2. User imports RX (Site) file
   └─→ Parse CSV/Excel → Extract: Site, Lat, Lng

3. User clicks "Calculate"
   └─→ For each TX sector:
       ├─→ Calculate bearing to each RX site
       ├─→ Filter by beamwidth (angular difference)
       ├─→ Filter by max distance (if set)
       ├─→ Sort by distance (nearest first)
       └─→ Return top N nearest sites

4. Display results on Map and Grid
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

### RX (Site) Data - Required Fields
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

### Step 1: Prepare Your Data
- Export sector data with azimuth values from your network planning tool
- Export site data with GPS coordinates
- Ensure latitude/longitude are in decimal degrees format
- Save as CSV or Excel (.xlsx)

### Step 2: Import TX Sectors
1. Open `Sector To Site Version 2.html` in a web browser
2. Click the **Sectors** tab in the left panel
3. Drag & drop or browse to select your CSV/Excel file
4. Map column names (Site, Sector, Lat, Lng, Azimuth)
5. Click **Load Data**

### Step 3: Import RX Sites
1. Click the **Sites** tab in the left panel
2. Drag & drop or browse to select your CSV/Excel file
3. Map column names (Site, Lat, Lng)
4. Click **Load Data**

### Step 4: Configure Calculation
1. Expand the **Calculation Settings** accordion
2. Set **Beamwidth** (default: 65°, range: 10-360)
3. Set **Max Distance** filter (optional)
4. Set **Number of Neighbors** (how many sites per sector)
5. Select **Distance Unit** (km, m, ft, mi)

### Step 5: Run Calculation
1. Click **Calculate** button
2. Wait for progress bar to complete
3. View results in Map or Grid view

### Step 6: Export Results
1. Click **Export** button
2. Choose format: CSV, Excel, or KML
3. Save file to your computer

---

## Calculation Settings Explained

| Setting | Description | Default |
|---------|-------------|---------|
| Beamwidth | Horizontal beam angle in degrees | 65° |
| Max Distance | Filter results by maximum distance | None |
| Distance Operator | Comparison operator (<, <=, >, >=, =) | < |
| Neighbors | Number of nearest sites to return per sector | 5 |
| Distance Unit | Output unit for distances | km |
| Exclude Zero | Skip sites at exact same coordinates | Enabled |

---

## Map Visualization

### Marker Types
- **TX Markers (Circles)** - Represent sectors with azimuth direction
- **RX Markers (Dots)** - Represent receive sites
- **Beam Polygons** - Show sector coverage area

### Beam Display Modes
- **Fixed Radius** - Display beam as circle with fixed kilometer radius
- **Match Only** - Show beams only for sectors with matching sites
- **No Match** - Show beams for sectors without matching sites

### Map Layers
- **Standard** - Default OpenStreetMap tiles
- **Satellite** - Satellite imagery
- **Terrain** - Topographic map view
- **Dark** - Dark mode map

---

## Troubleshooting

### "Missing TX or RX data" Error
- Ensure both sector and site files are loaded
- Check that all required columns are mapped

### No Results After Calculation
- Increase beamwidth value
- Increase max distance limit
- Check azimuth values are in range 0-360

### Incorrect Distances
- Verify coordinate format (decimal degrees)
- Ensure latitude/longitude columns are correctly mapped

### File Upload Issues
- CSV files should be UTF-8 encoded
- Excel files should have data in first sheet
- Maximum file size: 10MB

---

## Technology Stack

- **React 18** - UI framework (via CDN)
- **Leaflet 1.9.4** - Interactive maps
- **PapaParse 5.4.1** - CSV parsing
- **SheetJS (XLSX) 0.18.5** - Excel file handling
- **Leaflet MarkerCluster 1.5.3** - Map marker clustering

---

## Browser Compatibility

- Chrome (latest) - Recommended
- Firefox (latest)
- Safari (latest)
- Edge (latest)

---

## File Structure

.
├── README.md
└── Sector To Site.html

---

## License

All rights reserved.
