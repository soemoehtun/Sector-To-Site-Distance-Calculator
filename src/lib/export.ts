import JSZip from "jszip";
import { saveAs } from "file-saver";
import { engineBuildKmz, engineBuildXlsx } from "./engine";
import * as XLSX from "xlsx";
import type {
  CalcMethod,
  Connection,
  DistanceUnit,
  FacePair,
  IconConfig,
  Site,
  SiteWithNeighbors,
} from "@/types";

import { LAYER_COLORS } from "@/types";
import { getUnitMultiplier } from "./distance";
import { VECTOR_CIRCLE } from "./kmlIcons";
import type { VoronoiCellPolygonFeature } from "./voronoi";

import type { BeamFeature } from "./beam";

/** Human reason for a NOT FACE-TO-FACE pair. */
export function faceReason(r: FacePair): string {
  const parts: string[] = [];
  if (!r.aFaces) parts.push("Sector A does not point toward Site B");
  if (!r.bFaces) parts.push("Sector B does not point toward Site A");
  return parts.join("; ") || "Both sectors are outside beamwidth";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** #rrggbb + alpha (0..1) → KML aabbggrr */
export function hexToKmlColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = m ? m[1] : "ff0000";
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${a}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toLowerCase();
}

/** Flat circle PNG generated locally so a vector-circle export needs no network. */
function circlePng(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fillStyle = "#ffffff";
  g.fill();
  return c.toDataURL("image/png").split(",")[1];
}

/* ---------------------------------------------------------------- GeoJSON Export */

export function buildGeoJSON(
  allSites: Site[],
  connections: Connection[],
): GeoJSON.FeatureCollection {
  const pointFeatures: GeoJSON.Feature[] = allSites.map((s) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    properties: { id: s.id, ...(s.originalData || {}) },
  }));

  const lineFeatures: GeoJSON.Feature[] = connections
    .map((c) => {
      const p1 = allSites.find((s) => s.id === c.from);
      const p2 = allSites.find((s) => s.id === c.to);
      if (!p1 || !p2) return null;
      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [p1.lng, p1.lat],
            [p2.lng, p2.lat],
          ],
        },
        properties: { from: c.from, to: c.to, distance: c.distance },
      } as GeoJSON.Feature;
    })
    .filter(Boolean) as GeoJSON.Feature[];

  return {
    type: "FeatureCollection",
    features: [...pointFeatures, ...lineFeatures],
  };
}

export function exportGeoJSONFile(
  allSites: Site[],
  connections: Connection[],
  filename = "distances.geojson",
): void {
  const geojson = buildGeoJSON(allSites, connections);
  const jsonStr = JSON.stringify(geojson, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
  saveAs(blob, filename);
}

/* ---------------------------------------------------------------- Excel Export */

export async function exportExcelFile(
  sitesWithNeighbors: SiteWithNeighbors[],
  distanceUnit: DistanceUnit,
  calcMethod: CalcMethod,
  filename = "distances.xlsx",
  faceRows?: FacePair[],
  allSites?: Site[],
  hasTarget?: boolean,
): Promise<void> {
  const wb = XLSX.utils.book_new();

  // Face-to-face mode: exports all evaluated pairs + non-meeting sectors
  if (calcMethod === "face") {
    const rows: Record<string, unknown>[] = [];
    const sourceIdsWithRows = new Set<string>();

    if (faceRows && faceRows.length > 0) {
      faceRows.forEach((r) => {
        sourceIdsWithRows.add(r.sourceId);
        rows.push({
          "Site A": r.sourceId,
          "Sector A Azimuth (°)": r.azA === undefined ? "" : r.azA,
          "Beam A (°)": r.bwA ?? "",
          "Site B": r.targetId,
          "Sector B Azimuth (°)": r.azB === undefined ? "" : r.azB,
          "Beam B (°)": r.bwB ?? "",
          [`Distance (${distanceUnit})`]: Number(
            (r.distanceKm * getUnitMultiplier(distanceUnit)).toFixed(3),
          ),
          "Bearing A→B (°)": r.bearingAB,
          "Bearing B→A (°)": r.bearingBA,
          "Diff A (°)": r.diffA === undefined ? "" : r.diffA,
          "Diff B (°)": r.diffB === undefined ? "" : r.diffB,
          "Face-to-Face": r.faceToFace ? "YES" : "NO",
          "Criteria Met": r.faceToFace ? "YES" : "NO",
          Reason:
            r.faceToFace
              ? "Both sectors point toward each other within beamwidth"
              : faceReason(r),
        });
      });
    }

    // Include sectors that had NO facing candidate within distance limit
    const sourceCandidates = allSites
      ? allSites.filter((s) => s.isSource || !hasTarget)
      : sitesWithNeighbors;

    sourceCandidates.forEach((s) => {
      if (!sourceIdsWithRows.has(s.id)) {
        rows.push({
          "Site A": s.id,
          "Sector A Azimuth (°)": s.azimuth !== undefined && isFinite(s.azimuth) ? s.azimuth : "",
          "Beam A (°)": s.beamwidth ?? "",
          "Site B": "(None)",
          "Sector B Azimuth (°)": "",
          "Beam B (°)": "",
          [`Distance (${distanceUnit})`]: "",
          "Bearing A→B (°)": "",
          "Bearing B→A (°)": "",
          "Diff A (°)": "",
          "Diff B (°)": "",
          "Face-to-Face": "NO",
          "Criteria Met": "NO",
          Reason:
            s.azimuth === undefined || isNaN(s.azimuth)
              ? "No azimuth mapped (never counts as facing)"
              : "No facing partner found within beamwidth / distance limit",
        });
      }
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Face_to_Face");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveAs(
      new Blob([wbout], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      filename,
    );
    return;
  }

  // Sector Beam, Nearest Neighbors, or Voronoi modes
  const detailedRows: Record<string, unknown>[] = [];

  sitesWithNeighbors.forEach((s) => {
    let currentLayer = -1;
    let layerRank = 0;
    const neighborsForExcel = s.neighbors ? [...s.neighbors] : [];

    if (calcMethod === "voronoi") {
      neighborsForExcel.sort((a, b) => {
        const layerDiff = (a.layer || 1) - (b.layer || 1);
        if (layerDiff !== 0) return layerDiff;
        return a.dist - b.dist;
      });
    }

    if (neighborsForExcel.length > 0) {
      neighborsForExcel.forEach((n, idx) => {
        let rank = idx + 1;
        if (calcMethod === "voronoi") {
          const l = n.layer || 1;
          if (l !== currentLayer) {
            currentLayer = l;
            layerRank = 1;
          } else {
            layerRank++;
          }
          rank = layerRank;
        }

        const row: Record<string, unknown> = {
          "Source Site": s.id,
          "Source Azimuth (°)": s.azimuth !== undefined && isFinite(s.azimuth) ? s.azimuth : "",
          "Neighbor Site": n.to,
          [`Distance (${distanceUnit})`]: Number(n.dist.toFixed(3)),
          Rank: rank,
          "Criteria Met": "YES",
          "Status / Reason":
            calcMethod === "sector" ? "Matched in-beam neighbor" : "Neighbor within criteria",
        };

        if (calcMethod === "voronoi") {
          row["Voronoi Layer"] = n.layer || 1;
        }

        detailedRows.push(row);
      });
    } else {
      // Sector / Site that did NOT meet criteria (e.g. no in-beam neighbor found)
      const row: Record<string, unknown> = {
        "Source Site": s.id,
        "Source Azimuth (°)": s.azimuth !== undefined && isFinite(s.azimuth) ? s.azimuth : "",
        "Neighbor Site": "(None)",
        [`Distance (${distanceUnit})`]: "",
        Rank: "-",
        "Criteria Met": "NO",
        "Status / Reason":
          calcMethod === "sector"
            ? s.azimuth === undefined || isNaN(s.azimuth)
              ? "No azimuth mapped / treated as omni with no candidates in range"
              : "No candidate site located inside sector beamwidth or within distance limit"
            : "No candidate site located within distance limit",
      };

      if (calcMethod === "voronoi") {
        row["Voronoi Layer"] = "-";
      }

      detailedRows.push(row);
    }
  });

  const wsDetailed = XLSX.utils.json_to_sheet(detailedRows);
  XLSX.utils.book_append_sheet(wb, wsDetailed, "Detailed_Distances");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  saveAs(blob, filename);
}

/* ---------------------------------------------------------------- KMZ Export */

export interface KmzExportOptions {
  filename?: string;
  sourceIcon: IconConfig;
  neighborIcon: IconConfig;
  allSites: Site[];
  sitesWithNeighbors: SiteWithNeighbors[];
  connections: Connection[];
  lineColor: string;
  lineThickness: number;
  lineOpacity: number;
  showVoronoi: boolean;
  distanceUnit: DistanceUnit;
  calcMethod: CalcMethod;
  voronoiLayers: number;
  nNeighbors: number;
  popupColumns: Set<string>;
  popupColumnsTarget: Set<string>;
  hasTarget: boolean;
  /** Sector beam fan polygons to include in the KMZ */
  beams?: BeamFeature[];
  /** Voronoi cell polygons to include in the KMZ (voronoi method only). */
  voronoiPolygons?: VoronoiCellPolygonFeature[];
}


export async function exportKmzFile(opts: KmzExportOptions): Promise<void> {
  const {
    filename = "distances.kmz",
    sourceIcon,
    neighborIcon,
    allSites,
    sitesWithNeighbors,
    connections,
    lineColor,
    lineThickness,
    lineOpacity,
    distanceUnit,
    calcMethod,
    voronoiLayers,
    nNeighbors,
    popupColumns,
    popupColumnsTarget,
    hasTarget,
    beams,
    voronoiPolygons,
  } = opts;

  const zip = new JSZip();

  const getKmlIconHref = (iconUrl: string) => {
    if (!iconUrl || iconUrl === VECTOR_CIRCLE) {
      return "http://maps.google.com/mapfiles/kml/paddle/wht-blank.png";
    }
    if (iconUrl.startsWith("http")) return iconUrl;
    return "http://maps.google.com/mapfiles/kml/" + iconUrl;
  };

  const srcIconHref = getKmlIconHref(sourceIcon.url);
  const nbrIconHref = getKmlIconHref(neighborIcon.url);
  const srcIconColor = hexToKmlColor(sourceIcon.color, sourceIcon.opacity);
  const nbrIconColor = hexToKmlColor(neighborIcon.color, neighborIcon.opacity);
  const srcIconScale = Math.max(0.1, Math.min(sourceIcon.scale || 1.0, 4.0));
  const nbrIconScale = Math.max(0.1, Math.min(neighborIcon.scale || 1.0, 4.0));
  const kmlLineColor = hexToKmlColor(lineColor, lineOpacity / 100);

  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Sector To Site/Sector Distance Calculator Export</name>
  <open>1</open>
  <Style id="sourceStyle">
    <IconStyle>
      <color>${srcIconColor}</color>
      <scale>${srcIconScale}</scale>
      <Icon>
        <href>${srcIconHref}</href>
      </Icon>
      <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
    </IconStyle>
    <LabelStyle>
      <color>ffffffff</color>
      <scale>0.8</scale>
    </LabelStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="neighborStyle">
    <IconStyle>
      <color>${nbrIconColor}</color>
      <scale>${nbrIconScale}</scale>
      <Icon>
        <href>${nbrIconHref}</href>
      </Icon>
      <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
    </IconStyle>
    <LabelStyle>
      <color>ffffffff</color>
      <scale>0.8</scale>
    </LabelStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="lineStyle">
    <LineStyle>
      <color>${kmlLineColor}</color>
      <width>${lineThickness}</width>
    </LineStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="beamMatchedStyle">
    <LineStyle>
      <color>${hexToKmlColor("#22c55e", 0.85)}</color>
      <width>1.5</width>
    </LineStyle>
    <PolyStyle>
      <color>${hexToKmlColor("#22c55e", 0.25)}</color>
      <fill>1</fill>
      <outline>1</outline>
    </PolyStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="beamUnmatchedStyle">
    <LineStyle>
      <color>${hexToKmlColor("#ef4444", 0.65)}</color>
      <width>1.2</width>
    </LineStyle>
    <PolyStyle>
      <color>${hexToKmlColor("#ef4444", 0.15)}</color>
      <fill>1</fill>
      <outline>1</outline>
    </PolyStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="voronoiPolyStyle">
    <LineStyle>
      <color>${hexToKmlColor("#8b5cf6", 0.9)}</color>
      <width>1.5</width>
    </LineStyle>
    <PolyStyle>
      <color>${hexToKmlColor("#8b5cf6", 0.15)}</color>
      <fill>1</fill>
      <outline>1</outline>
    </PolyStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Folder>
    <name>Sites</name>
    <open>1</open>
`;

  const neighborDataMap = new Map<string, SiteWithNeighbors>();
  sitesWithNeighbors.forEach((s) => neighborDataMap.set(s.id, s));
  const allSitesMap = new Map<string, Site>();
  allSites.forEach((s) => allSitesMap.set(s.id, s));

  allSites.forEach((s) => {
    let extraInfoHtml = "";
    if (s.originalData) {
      const colsToUse =
        hasTarget && s.isTarget && !s.isSource
          ? popupColumnsTarget
          : popupColumns;
      colsToUse.forEach((col) => {
        const val = s.originalData![col];
        if (val !== undefined && val !== null && val !== "") {
          extraInfoHtml += `<div style="margin-bottom:4px;font-size:12px;color:#1e293b;">
            <strong>${escapeXml(col)}:</strong> ${escapeXml(String(val))}
          </div>`;
        }
      });
    }

    let neighborHtml = "";
    const siteData = neighborDataMap.get(s.id);

    if (s.isSource || !hasTarget) {
      let neighborList = "";
      const neighbors = siteData?.neighbors || [];

      if (calcMethod === "voronoi" && neighbors.length > 0) {
        const layerGroups: Record<number, typeof neighbors> = {};
        neighbors.forEach((n) => {
          const layerNum = n.layer || 1;
          if (!layerGroups[layerNum]) layerGroups[layerNum] = [];
          layerGroups[layerNum].push(n);
        });

        neighborList = Object.keys(layerGroups)
          .sort((a, b) => Number(a) - Number(b))
          .map((layerNumStr) => {
            const ln = Number(layerNumStr);
            const layerColor = LAYER_COLORS[(ln - 1) % LAYER_COLORS.length];
            const items = layerGroups[ln]
              .map(
                (n) =>
                  `<div style="margin-bottom:2px;font-size:12px;color:#1e293b;padding-left:4px;">
                    <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${layerColor};margin-right:4px;vertical-align:middle;"></span><strong>${escapeXml(
                      n.to,
                    )}</strong> &ndash; ${(n.dist || 0).toFixed(3)} ${distanceUnit}
                  </div>`,
              )
              .join("");
            return `<div style="margin-top:6px;margin-bottom:2px;padding:3px 0;border-bottom:1px solid #f1f5f9;">
                <div style="font-size:10px;font-weight:700;color:${layerColor};text-transform:uppercase;letter-spacing:0.04em;">Layer ${ln}</div>
                ${items}
              </div>`;
          })
          .join("");
      } else if (neighbors.length > 0) {
        neighborList = neighbors
          .map(
            (n, idx) =>
              `<div style="margin-bottom:4px;font-size:12px;color:#1e293b;">
                <strong>${idx + 1}. ${escapeXml(n.to)}:</strong> ${(
                n.dist || 0
              ).toFixed(3)} ${distanceUnit}
              </div>`,
          )
          .join("");
      } else {
        neighborList = `<div style="margin-bottom:4px;font-size:12px;color:#64748b;">None</div>`;
      }

      const assignedCount = neighbors.length || 0;
      const headerLabel =
        calcMethod === "voronoi"
          ? `Voronoi Neighbors (${voronoiLayers}-Layer)`
          : calcMethod === "sector"
            ? `Nearest ${nNeighbors || 3} Neighbors in Beam (${assignedCount} assigned)`
            : `Nearest ${nNeighbors || 3} Neighbors (${assignedCount} assigned)`;
      neighborHtml = `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0;">
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;text-transform:uppercase;">${headerLabel}</div>
        ${neighborList}
      </div>`;
    }

    const descHtml = `<div style="font-family:'Inter',Arial,sans-serif;min-width:160px;max-height:280px;overflow-y:auto;">
      <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;padding-right:16px;">
        ${escapeXml(s.id)}
      </div>
      <div>
        ${extraInfoHtml}
      </div>
      ${neighborHtml}
    </div>`;

    const styleUrl =
      hasTarget && s.isTarget && !s.isSource
        ? "#neighborStyle"
        : "#sourceStyle";

    kml += `    <Placemark>
      <name>${escapeXml(s.id)}</name>
      <description><![CDATA[${descHtml}]]></description>
      <styleUrl>${styleUrl}</styleUrl>
      <Point>
        <coordinates>${s.lng},${s.lat},0</coordinates>
      </Point>
    </Placemark>
`;
  });

  kml += `  </Folder>
`;

  // Sector Beams: add visual polygon wedges folder
  if (beams && beams.length > 0) {
    kml += `  <Folder>
    <name>Sector Beams</name>
    <open>1</open>
`;

    beams.forEach((b) => {
      const ring = b.geometry.coordinates[0];
      if (!ring || ring.length < 3) return;
      const coords = ring.map((pt) => `${pt[0]},${pt[1]},0`).join(" ");
      const styleUrl = b.properties.matched ? "#beamMatchedStyle" : "#beamUnmatchedStyle";
      const statusText = b.properties.matched
        ? "Matched in-beam neighbor(s)"
        : "No in-beam neighbor found";
      const radiusInUnit = (b.properties.radiusKm * getUnitMultiplier(distanceUnit)).toFixed(3);
      const desc = `<div style="font-family:'Inter',Arial,sans-serif;font-size:12px;color:#1e293b;">
        <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:6px;">${escapeXml(
          b.properties.siteId,
        )} Sector Beam</div>
        <div style="margin-bottom:3px;"><strong>Azimuth:</strong> ${b.properties.azimuth}°</div>
        <div style="margin-bottom:3px;"><strong>Beamwidth:</strong> ${b.properties.beamWidth}°</div>
        <div style="margin-bottom:3px;"><strong>Radius:</strong> ${radiusInUnit} ${distanceUnit}</div>
        <div><strong>Status:</strong> ${statusText}</div>
      </div>`;

      kml += `    <Placemark>
      <name>${escapeXml(b.properties.siteId)} Beam (${b.properties.azimuth}° / ${b.properties.beamWidth}°)</name>
      <description><![CDATA[${desc}]]></description>
      <styleUrl>${styleUrl}</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
`;
    });

    kml += `  </Folder>
`;
  }

  // Brute-force: add connection lines folder
  if (calcMethod !== "voronoi" && connections.length > 0) {
    kml += `  <Folder>
    <name>Connections</name>
    <open>1</open>
`;

    connections.forEach((c) => {
      const p1 = allSitesMap.get(c.from);
      const p2 = allSitesMap.get(c.to);
      if (!p1 || !p2) return;

      const arrow = !hasTarget ? " ⇄ " : " → ";
      kml += `    <Placemark>
      <name>${escapeXml(c.from)}${arrow}${escapeXml(c.to)} | ${c.distance.toFixed(
        3,
      )} ${distanceUnit}</name>
      <styleUrl>#lineStyle</styleUrl>
      <LineString>
        <coordinates>${p1.lng},${p1.lat},0 ${p2.lng},${p2.lat},0</coordinates>
      </LineString>
    </Placemark>
`;
    });

    kml += `  </Folder>
`;
  }

  // Voronoi: add polygon layer
  if (calcMethod === "voronoi" && voronoiPolygons && voronoiPolygons.length > 0) {
    kml += `  <Folder>
    <name>Voronoi Polygons</name>
    <open>1</open>
`;

    voronoiPolygons.forEach((feature) => {
      const ring = feature.geometry.coordinates[0];
      if (!ring || ring.length < 3) return;
      const coords = ring.map((pt) => `${pt[0]},${pt[1]},0`).join(" ");
      kml += `    <Placemark>
      <name>${escapeXml(feature.properties.siteId)}</name>
      <styleUrl>#voronoiPolyStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
`;
    });

    kml += `  </Folder>
`;
  }

  kml += `</Document>
</kml>`;

  zip.file("doc.kml", kml);
  zip.folder("files")!.file("circle.png", circlePng(), { base64: true });

  const content = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.google-earth.kmz",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  saveAs(content, filename);
}

