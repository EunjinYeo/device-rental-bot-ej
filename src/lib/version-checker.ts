import fs from "fs";
import path from "path";

const VERSION_STATE_FILE = path.join(process.cwd(), "version-state.json");

export interface VersionState {
  latest: string;
  notifiedAt: string | null;
  confirmedAt: string | null;
}

export interface VersionStateFile {
  ios: VersionState;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchLatestIosVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://gdmf.apple.com/v2/pmv");
    const data = await res.json() as { PublicAssetSets?: { iOS?: { ProductVersion: string }[] } };
    const versions = (data.PublicAssetSets?.iOS ?? [])
      .map((e) => e.ProductVersion)
      .filter((v) => /^\d+\.\d+/.test(v));

    if (versions.length === 0) return null;

    const latestMajor = Math.max(...versions.map((v) => parseInt(v.split(".")[0])));
    const candidates = versions.filter((v) => parseInt(v.split(".")[0]) === latestMajor);
    candidates.sort((a, b) => compareVersions(b, a));
    return candidates[0];
  } catch {
    return null;
  }
}

export function loadVersionState(): VersionStateFile {
  try {
    return JSON.parse(fs.readFileSync(VERSION_STATE_FILE, "utf-8"));
  } catch {
    return { ios: { latest: "", notifiedAt: null, confirmedAt: null } };
  }
}

export function saveVersionState(state: VersionStateFile): void {
  fs.writeFileSync(VERSION_STATE_FILE, JSON.stringify(state, null, 2));
}
