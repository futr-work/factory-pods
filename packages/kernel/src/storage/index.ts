export * from "./types.js";
export * from "./d1.js";

import { D1DatabaseLike, PodStorage, POD_STORAGE_BRAND } from "./types.js";
import { D1Storage } from "./d1.js";

export function isPodStorage(candidate: unknown): candidate is PodStorage {
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return false;
  }
  return (candidate as Record<symbol, unknown>)[POD_STORAGE_BRAND] === true;
}

export function toPodStorage(db: D1DatabaseLike | PodStorage): PodStorage {
  if (isPodStorage(db)) {
    return db;
  }
  return new D1Storage(db as D1DatabaseLike);
}
