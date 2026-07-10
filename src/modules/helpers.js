// helpers.js
// Fixed: Silently skip tracking pixels and CORS-blocked images

import { STATUSES } from "../constants.js";

const MAX_IMG_HEIGHT = 300;
const MAX_IMG_WIDTH = 400;
const MIN_IMG_WIDTH = 32;
const MIN_IMG_HEIGHT = 32;
const MAX_VIDEO_WIDTH = 1920 / 4.5;
const MAX_VIDEO_HEIGHT = 1080 / 4.5;

// ============================================================================
// TRACKING PIXEL / BEACON DETECTION
// Skip these URLs entirely — they're not content images
// ============================================================================
const TRACKING_PATTERNS = [
    /bat\.bing\.net/, // Microsoft tracking
    /google-analytics\.com/, // Google Analytics
    /googleadservices\.com/, // Google Ads
    /doubleclick\.net/, // Google DoubleClick
    /facebook\.com\/tr/, // Facebook Pixel
    /connect\.facebook\.net/, // Facebook SDK
    /analytics/, // Generic analytics
    /pixel\./, // Generic pixel
    /beacon\./, // Generic beacon
    /track\./, // Generic tracking
    /1x1/, // Explicit 1x1 pixel
    /transparent\.gif/, // Common transparent pixel
    /clear\.gif/, // Common clear pixel
    /spacer\.gif/, // Common spacer pixel
    /\/\/t\.co\//, // Twitter t.co shortener (tracking)
    /fonts\.googleapis/, // Google Fonts (not images)
    /fonts\.gstatic/, // Google Fonts CDN
];

const isTrackingPixel = (src) => {
    if (!src) return true;
    return TRACKING_PATTERNS.some((pattern) => pattern.test(src));
};

// ============================================================================
// LOAD IMAGE — With silent error handling for tracking pixels
// ============================================================================
const loadImage = async (imgSrc, imgWidth, imgHeight) => {
    // Silently skip tracking pixels and beacons
    if (isTrackingPixel(imgSrc)) {
        throw new Error("TRACKING_PIXEL_SKIPPED");
    }

    const img = new Image(224, 224);
    return await new Promise((resolve, reject) => {
        img.setAttribute("crossorigin", "anonymous");

        img.onload = () => {
            resolve(img);
        };

        img.onerror = (e) => {
            reject(e);
        };

        try {
            img.src = imgSrc;
        } catch (e) {
            reject(e);
        }
    });
};

// ============================================================================
// LOAD VIDEO — Same as before
// ============================================================================
const loadVideo = async (video) => {
    return await new Promise((resolve, reject) => {
        video.setAttribute("crossorigin", "anonymous");
        if (video.readyState >= 3 && video.videoHeight) {
            resolve(true);
        }
        video.onloadeddata = () => {
            video.videoHeight ? resolve(true) : reject();
        };
        video.onerror = (e) => {
            reject("Failed to load video", video);
        };
    });
};

// ============================================================================
// IMAGE SIZE CHECK
// ============================================================================
const isImageTooSmall = (img) => {
    return img.width < MIN_IMG_WIDTH || img.height < MIN_IMG_HEIGHT;
};

// ============================================================================
// RESIZE CALCULATION
// ============================================================================
const calcResize = (width, height, type = "image") => {
    let newWidth = width;
    let newHeight = height;

    if (!width || !height) return { newWidth, newHeight };

    let actualMaxWidth = type === "image" ? MAX_IMG_WIDTH : MAX_VIDEO_WIDTH;
    let actualMaxHeight = type === "image" ? MAX_IMG_HEIGHT : MAX_VIDEO_HEIGHT;

    if (newWidth < newHeight) {
        const temp = actualMaxWidth;
        actualMaxWidth = actualMaxHeight;
        actualMaxHeight = temp;
    }

    if (!(newWidth < actualMaxWidth && newHeight < actualMaxHeight)) {
        const ratio = Math.min(
            actualMaxWidth / newWidth,
            actualMaxHeight / newHeight
        );
        newWidth = newWidth * ratio;
        newHeight = newHeight * ratio;
    }

    return { newWidth, newHeight };
};

// ============================================================================
// PROCESS NODE — Skip tracking pixels before they even reach the queue
// ============================================================================
// ============================================================================
// DEEP DOM WALKER — Pierces shadow roots recursively
// ============================================================================
const walkDeepNodes = function* (root) {
    if (!(root instanceof Element) && !(root instanceof ShadowRoot)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
        yield el;
        if (el.shadowRoot) {
            yield* walkDeepNodes(el.shadowRoot);
        }
    }
};

// ============================================================================
// PROCESS NODE — Finds all img/video including inside shadow DOM
// ============================================================================
const processNode = (node, callBack) => {
    if (!node) return;
    for (const el of walkDeepNodes(node)) {
        if (el.tagName === "VIDEO") {
            callBack(el);
        } else if (el.tagName === "IMG") {
            // Skip tracking pixels and tiny images
            if (el.complete && isImageTooSmall(el) && el.naturalHeight) {
                // Too small, skip
            } else if (isTrackingPixel(el.src)) {
                // Tracking pixel, skip silently
            } else {
                callBack(el);
            }
        }
    }
};

// ============================================================================
// OTHER HELPERSPERS — Same as before
// ============================================================================
const hasBeenProcessed = (element) => {
    if (!element) throw new Error("No element provided");
    if (
        element.dataset.HBstatus &&
        element.dataset.HBstatus >= STATUSES.PROCESSING
    )
        return true;
    return false;
};

const resetElement = (element) => {
    element.removeAttribute("crossOrigin");
    element.classList.remove("hb-blur-temp");
    element.classList.remove("hb-blur");
};

const emitEvent = (eventName, detail = "") => {
    const event = new CustomEvent(eventName, { detail });
    document.dispatchEvent(event);
};

const listenToEvent = (eventName, callBack) => {
    document.addEventListener(eventName, callBack);
};

const now = () => {
    return performance?.now?.() || Date.now();
};

const timeTaken = (fnToRun) => {
    const beforeRun = now();
    fnToRun();
    const afterRun = now();
    return afterRun - beforeRun;
};

const getCanvas = (width, height, offscreen = true) => {
    let c;

    if (!offscreen) {
        c =
            document.getElementById("hb-in-canvas") ??
            document.createElement("canvas");
        c.id = "hb-in-canvas";
        c.width = width;
        c.height = height;
        if (!c.parentElement) {
            document.body.appendChild(c);
        }
    } else {
        c = new OffscreenCanvas(width, height);
    }

    return c;
};

const canvToBlob = (canv, options) => {
    if (canv.convertToBlob) {
        return canv.convertToBlob(options);
    }
    return new Promise((resolve, reject) => {
        canv.toBlob(
            (blob) => {
                resolve(blob);
            },
            options?.type || "image/jpeg",
            options?.quality || 0.8
        );
    });
};

const disableVideo = (video) => {
    video.dataset.HBstatus = STATUSES.DISABLED;
    video.classList.remove("hb-blur");
};

const enableVideo = (video) => {
    video.dataset.HBstatus = STATUSES.PROCESSING;
};

function updateBGvideoStatus(videosInProcess) {
    const disabledVideos =
        videosInProcess.filter(
            (video) =>
                video.dataset.HBstatus === STATUSES.DISABLED &&
                !video.paused &&
                video.currentTime > 0
        ) ?? [];

    chrome.runtime.sendMessage({
        type: "video-status",
        status: disabledVideos.length === 0,
    });
}

const requestIdleCB =
    window.requestIdleCallback ||
    function (cb) {
        var start = Date.now();
        return setTimeout(function () {
            cb({
                didTimeout: false,
                timeRemaining: function () {
                    return Math.max(0, 50 - (Date.now() - start));
                },
            });
        }, 1);
    };

const cancelIdleCB =
    window.cancelIdleCallback ||
    function (id) {
        clearTimeout(id);
    };

export {
    walkDeepNodes,
    loadImage,
    loadVideo,
    calcResize,
    hasBeenProcessed,
    processNode,
    emitEvent,
    listenToEvent,
    now,
    timeTaken,
    resetElement,
    isImageTooSmall,
    getCanvas,
    disableVideo,
    enableVideo,
    updateBGvideoStatus,
    requestIdleCB,
    cancelIdleCB,
    canvToBlob,
    isTrackingPixel,
};
