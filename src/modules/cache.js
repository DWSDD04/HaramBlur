// cache.js
// LRU cache for detection results to avoid re-analyzing identical images

class LRUCache {
    constructor(max = 300) {
        this.max = max;
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (item) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, item);
        }
        return item ?? null;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.max) {
            // Evict least recently used (first item)
            const first = this.cache.keys().next().value;
            this.cache.delete(first);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

// Global singleton — persists across the session
export const detectionCache = new LRUCache(300);

/**
 * Build a cache key from image metadata.
 * Uses src + dimensions + strictness so that changing strictness invalidates old results.
 */
export const buildCacheKey = (src, width, height, strictness) => {
    // Normalize src: strip query params that are often cache-busting noise
    try {
        const url = new URL(src);
        // Keep pathname but strip common tracking params
        url.searchParams.delete("_");
        url.searchParams.delete("t");
        url.searchParams.delete("cb");
        src = url.toString();
    } catch {
        // Invalid URL, keep raw src
    }
    return `${src}|${width}x${height}|s${strictness}`;
};
