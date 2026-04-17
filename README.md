# RF Sector-To-Site Distance Calculator

A professional, high-performance GIS tool for RF engineers and site planners. This tool facilitates the analysis of spatial relationships between transmitter (TX) sectors and receiver (RX) candidate sites, featuring real-time visualization and comprehensive reporting.

## 🚀 Key Features

- **Interactive GIS Mapping**: Powered by Leaflet, supporting multiple map styles (Satellite, Terrain, Dark Mode, OSM) and professional layer switching.
- **Bulk Data Processing**: Seamlessly load TX and RX data from CSV, TXT, or Excel (`.xls`, `.xlsx`) files.
- **Advanced RF Logic**: 
  - Dynamic horizontal beamwidth analysis.
  - Nearest N sites calculation per sector.
  - Maximum distance filtering.
  - Automatic or fixed beam radius rendering.
- **High-Fidelity Visualization**:
  - Color-coded matched vs. unmatched beams.
  - Connection lines for links.
  - Custom site marker sizing and fill opacity.
  - Interactive tooltips and labels.
- **Professional Exports**:
  - Detailed CSV results for data analysis.
  - High-fidelity KML exports for Google Earth, preserving all visual styling and metadata.

## 🛠️ Getting Started

1.  **Open the Tool**: Simply open `soe.html` in any modern web browser.
2.  **Load TX Data**: Upload your sector file. Ensure it contains Latitude, Longitude, and Azimuth columns. The tool will attempt to auto-map these fields.
3.  **Load RX Data**: Upload your candidate site file. Ensure it contains Latitude and Longitude columns.
4.  **Configure Settings**: Adjust the beamwidth, distance limits, and map markers to suit your analysis requirements.
5.  **Calculate**: Click **"Calculate & Show Results"** to perform the analysis and render the data on the map.

## 📋 Data Requirements

### TX Sector File (Required Columns)
- **Site Name**: Identifier for the base station.
- **Sector ID**: Specific identifier for the sector/cell.
- **Latitude & Longitude**: Decimal coordinates (WGS84).
- **Azimuth**: The orientation of the sector in degrees ($0^{\circ}$ to $360^{\circ}$).

### RX Site File (Required Columns)
- **Site Name**: Identifier for the candidate site.
- **Latitude & Longitude**: Decimal coordinates (WGS84).

## 🧰 Dependencies

This application is a standalone HTML tool using the following libraries via CDN:
- **Leaflet.js**: Interactive mapping engine.
- **PapaParse**: High-speed CSV parsing.
- **XLSX.js (SheetJS)**: Excel file processing.
- **Inter Font**: Modern, readable typography from Google Fonts.

---
*Created for professional RF network planning and optimization.*
