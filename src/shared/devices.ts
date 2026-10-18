// The devices Helm's builders capture each page on, for the Screens view. The human picks from
// this list (no typing, so a name is never wrong); names are the simulator or emulator model
// names, sizes are the screen in points (iOS) or dp (Android), upright.

export type DeviceOs = "ios" | "android";
export type DeviceForm = "phone" | "tablet";

export interface DeviceSpec {
  /** The model as Xcode or Android Studio names it. */
  name: string;
  os: DeviceOs;
  form: DeviceForm;
  w: number;
  h: number;
}

export const DEVICE_CATALOG: DeviceSpec[] = [
  { name: "iPhone 18 Pro", os: "ios", form: "phone", w: 402, h: 874 },
  { name: "iPhone 18 Pro Max", os: "ios", form: "phone", w: 440, h: 956 },
  { name: "iPhone Air", os: "ios", form: "phone", w: 420, h: 912 },
  { name: "iPhone 17", os: "ios", form: "phone", w: 402, h: 874 },
  { name: "iPhone 17 Pro Max", os: "ios", form: "phone", w: 440, h: 956 },
  { name: "iPhone 17e", os: "ios", form: "phone", w: 390, h: 844 },
  { name: "iPhone SE (3rd generation)", os: "ios", form: "phone", w: 375, h: 667 },
  { name: "Pixel 9", os: "android", form: "phone", w: 412, h: 923 },
  { name: "Pixel 9 Pro XL", os: "android", form: "phone", w: 448, h: 998 },
  { name: "Samsung Galaxy S25", os: "android", form: "phone", w: 384, h: 832 },
  { name: "Samsung Galaxy S25 Ultra", os: "android", form: "phone", w: 412, h: 891 },
  { name: "iPad Pro 11-inch (M5)", os: "ios", form: "tablet", w: 834, h: 1210 },
  { name: "iPad Air 11-inch (M4)", os: "ios", form: "tablet", w: 820, h: 1180 },
  { name: "iPad mini (A17 Pro)", os: "ios", form: "tablet", w: 744, h: 1133 },
  { name: "Pixel Tablet", os: "android", form: "tablet", w: 800, h: 1280 },
];

/** The six most common phones: what every phone app is captured on until the human picks. */
export const DEFAULT_DEVICES = ["iPhone 18 Pro", "iPhone 18 Pro Max", "iPhone Air", "iPhone SE (3rd generation)", "Pixel 9", "Samsung Galaxy S25"];

/** At most this many devices are picked (each one is a capture of every page). */
export const MAX_DEVICES = 8;

/** Computer apps and web apps: the window sizes chosen for them (nothing to pick). */
export const COMPUTER_SIZES = [
  { name: "Laptop", w: 1440, h: 900 },
  { name: "Desktop", w: 1920, h: 1080 },
];
/** A web app is also captured at a phone's width. */
export const WEB_PHONE_SIZE = { name: "Phone width", w: 390, h: 844 };

export const deviceSpec = (name: string): DeviceSpec | null => DEVICE_CATALOG.find((d) => d.name.toLowerCase() === name.trim().toLowerCase()) ?? null;

/** Keep only catalog names, in catalog order, at most MAX_DEVICES; nothing valid → the default. */
export function cleanDevices(v: unknown): string[] {
  const want = new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()));
  const out = DEVICE_CATALOG.filter((d) => want.has(d.name.toLowerCase())).map((d) => d.name).slice(0, MAX_DEVICES);
  return out.length ? out : [...DEFAULT_DEVICES];
}

/** The picked devices that suit an app's platforms (an iOS app gets the Apple ones, an Android app the Android ones). */
export function devicesForPlatforms(picked: string[], platforms: string[]): string[] {
  const oses = new Set<DeviceOs>([...(platforms.includes("ios") ? ["ios" as const] : []), ...(platforms.includes("and") ? ["android" as const] : [])]);
  if (!oses.size) return [];
  const list = picked.map(deviceSpec).filter((d): d is DeviceSpec => !!d && oses.has(d.os)).map((d) => d.name);
  if (list.length) return list;
  // none picked for this platform: its default phones
  return DEFAULT_DEVICES.map(deviceSpec).filter((d): d is DeviceSpec => !!d && oses.has(d.os)).map((d) => d.name);
}
