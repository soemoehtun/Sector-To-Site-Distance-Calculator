/**
 * Official Google Earth / KML icon palettes.
 *
 * The named `shapes` set plus the pushpin and paddle sets shown in the
 * Google Earth "Icon" dialog.
 *
 * Used for KMZ export only — the web map always draws vector points.
 */
export const VECTOR_CIRCLE = "VECTOR_CIRCLE";
export const NO_ICON = "NO_ICON";

const BASE = "https://maps.google.com/mapfiles/kml";

export interface IconGroup {
  id: string;
  label: string;
  icons: string[];
}

/** The named `shapes` icons — confirmed-existing files only. */
const SHAPES = [
  // Placemarks / geometry
  "placemark_circle", "placemark_circle_highlight",
  "placemark_square", "placemark_square_highlight",
  "shaded_dot", "donut", "open-diamond",
  "square", "triangle", "star", "target",
  "cross-hairs", "cross-hairs_highlight",
  "polygon", "arrow", "flag",
  // Info / warning
  "info", "info-i", "info_circle", "caution", "forbidden",
  // People / accessibility
  "man", "woman", "wheel_chair_accessible",
  // Transport — road
  "parking_lot", "cabs", "truck",
  // Transport — public
  "bus", "rail", "subway", "tram",
  // Transport — air / water
  "airports", "heliport", "ferry", "sailing", "marina",
  // Outdoors / sport
  "swimming", "fishing", "campground", "campfire", "picnic",
  "hiker", "trail", "cycling", "horsebackriding",
  "golf", "ski", "snowflake_simple",
  // Nature
  "mountains", "volcano", "earthquake", "water",
  // Food / drink / shopping
  "dining", "coffee", "bars", "snack_bar",
  "grocery", "shopping", "convenience", "gas_stations",
  // Services
  "mechanic", "toilets", "post_office", "phone", "wifi",
  "electronics", "camera", "movies", "arts",
  "homegardenbusiness", "realestate", "salon",
  // Currency
  "euro", "dollar", "yen",
  // Emergency / civic
  "police", "firedept", "hospitals", "pharmacy", "schools",
  "library", "church", "ranger_station",
  // Capital markers
  "capital_big", "capital_big_highlight",
  "capital_small", "capital_small_highlight",
  // Weather
  "sunny", "partly_cloudy", "rainy", "thunderstorm",
  // Misc
  "poi", "webcam", "motorcycling",
].map((n) => `${BASE}/shapes/${n}.png`);

/** Coloured pushpins. */
const PUSHPINS = [
  "ylw", "blue", "grn", "ltblu", "pink", "purple", "red", "wht",
].map((c) => `${BASE}/pushpin/${c}-pushpin.png`);

/** Coloured paddles: circles, blanks, letters, numbers. */
const PADDLE_COLORS = ["red", "blu", "grn", "ylw", "purple", "pink", "orange", "ltblu", "wht"];
const PADDLE_SHAPES = ["circle", "blank", "diamond", "square", "stars"];
const PADDLES = [
  ...PADDLE_COLORS.flatMap((c) => PADDLE_SHAPES.map((s) => `${BASE}/paddle/${c}-${s}.png`)),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${BASE}/paddle/${l}.png`),
  ...Array.from({ length: 10 }, (_, i) => `${BASE}/paddle/${i + 1}.png`),
];

export const ICON_GROUPS: IconGroup[] = [
  { id: "shapes", label: "Shapes", icons: SHAPES },
  { id: "pushpin", label: "Pushpins", icons: PUSHPINS },
  { id: "paddle", label: "Paddles", icons: PADDLES },
];

/** Flat list of every icon across all groups. */
export const ALL_ICONS: string[] = ICON_GROUPS.flatMap((g) => g.icons);

/** Human-readable name from an icon href, for tooltips. */
export function iconName(url: string): string {
  if (url === VECTOR_CIRCLE) return "Vector circle";
  if (url === NO_ICON) return "No icon";
  const file = url.split("/").pop() ?? url;
  return file.replace(/\.png$/, "").replace(/[-_]/g, " ");
}

/** Back-compat alias used elsewhere in the app. */
export const KML_ICONS = ALL_ICONS.map((url) => ({ name: iconName(url), url }));
