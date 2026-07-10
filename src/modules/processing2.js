import {
    calcResize,
    loadVideo,
    getCanvas,
    emitEvent,
    requestIdleCB,
    canvToBlob,
} from "./helpers";
import { removeBlurryStart, removeImmediateBlur } from "./style";
import { STATUSES } from "../constants.js";
import { detectionCache, buildCacheKey } from "./cache.js";
import { applySurgicalBlur, removeSurgicalBlur } from "./surgical.js";

const FRAME_RATE = 1000 / 25;
const POSITIVE_THRESHOLD = 1;
const NEGATIVE_THRESHOLD = 3;

const RESULTS = {
    CLEAR: "CLEAR",
    NSFW: "NSFW",
    FACE: "FACE",
    ERROR: "ERROR",
};

let activeFrame = false;
let canv, ctx;

/**
 * Apply a cached result to a DOM node without re-running detection.
 */
const applyCachedResult = (node, result, STATUSES, settings) => {
    removeImmediateBlur(node);
    removeBlurryStart(node);

    if (result === false) {
        removeSurgicalBlur(node);
        node.dataset.HBstatus = STATUSES.PROCESSED;
        node.classList.remove("hb-blur");
        delete node.dataset.HBresult;
    } else if (result === "error") {
        removeSurgicalBlur(node);
        node.classList.add("hb-blur");
        node.dataset.HBstatus = STATUSES.ERROR;
    } else if (
        typeof result === "object" &&
        result !== null &&
        result.result === "face" &&
        result.boxes
    ) {
        // Surgical blur
        node.dataset.HBstatus = STATUSES.PROCESSED;
        node.classList.remove("hb-blur");
        delete node.dataset.HBresult;
        const blurAmount = settings?.getBlurAmount?.() ?? 20;
        const gray = settings?.isGray?.() ?? true;
        applySurgicalBlur(node, result.boxes, blurAmount, gray);
    } else {
        // Full blur fallback (nsfw or face without boxes)
        removeSurgicalBlur(node);
        node.dataset.HBstatus = STATUSES.PROCESSED;
        node.classList.add("hb-blur");
        node.dataset.HBresult =
            typeof result === "string" ? result : result.result;
    }
};

const processImage = (node, STATUSES, settings = null) => {
    try {
        // ------------------------------------------------------------------
        // CACHE CHECK
        // ------------------------------------------------------------------
        const strictness = settings?.getStrictness?.() ?? 0.5;
        const cacheKey = buildCacheKey(
            node.src,
            node.naturalWidth || node.width,
            node.naturalHeight || node.height,
            strictness
        );
        const cached = detectionCache.get(cacheKey);
        if (cached !== null) {
            applyCachedResult(node, cached, STATUSES, settings);
            return;
        }

        node.dataset.HBstatus = STATUSES.PROCESSING;
        chrome.runtime.sendMessage(
            {
                type: "imageDetection",
                image: {
                    src: node.src,
                    width: node.width || node.naturalWidth,
                    height: node.height || node.naturalHeight,
                },
            },
            (response) => {
                // Always remove pending blur — final state decided below
                removeImmediateBlur(node);
                removeBlurryStart(node);

                // Chrome messaging failure (offscreen not ready, disconnected, etc.)
                if (chrome.runtime.lastError) {
                    node.dataset.HBstatus = STATUSES.ERROR;
                    // Stay blurred — security default
                    return;
                }

                // Normalize every possible response type into a safe, predictable value
                let result;
                if (response === false) {
                    result = false; // explicitly safe
                } else if (
                    typeof response === "object" &&
                    response !== null &&
                    response.result
                ) {
                    result = response; // object with result + boxes
                } else if (response === "face" || response === "nsfw") {
                    result = response; // explicitly unsafe
                } else if (response === "error") {
                    result = "error"; // load or processing failure
                } else {
                    // null, undefined, objects, unexpected strings — treat as error
                    result = "error";
                }

                // Cache the result before applying it
                detectionCache.set(cacheKey, result);

                applyCachedResult(node, result, STATUSES, settings);
            }
        );
    } catch (e) {
        // Exception in sendMessage — keep blurred
        node.classList.add("hb-blur");
        node.dataset.HBstatus = STATUSES.ERROR;
    }
};

const processFrame = async (video, { width, height }) => {
    if (!video || video.ended) {
        return;
    }
    return new Promise(async (resolve, reject) => {
        try {
            ctx.drawImage(video, 0, 0, width, height);

            const blob = await canvToBlob(canv, {
                type: "image/jpeg",
                quality: 0.6,
            });
            let data = URL.createObjectURL(blob);
            chrome.runtime.sendMessage(
                {
                    type: "videoDetection",
                    frame: {
                        data: data,
                        timestamp: video.currentTime,
                    },
                },
                (response) => {
                    URL.revokeObjectURL(data);
                    if (chrome.runtime.lastError) {
                        resolve(null);
                        return;
                    }
                    resolve(response);
                }
            );
        } catch (e) {
            reject(e);
        }
    });
};

const videoDetectionLoop = async (video, { width, height }) => {
    const currTime = performance.now();

    if (!video?.HBprevTime) {
        video.HBprevTime = currTime;
    }

    const diffTime = currTime - video.HBprevTime;

    if (video.dataset.HBstatus === STATUSES.DISABLED) {
        video.classList.remove("hb-blur");
    }

    if (
        !video.ended &&
        !video.paused &&
        video.dataset.HBstatus !== STATUSES.DISABLED
    ) {
        try {
            if (diffTime >= FRAME_RATE) {
                video.HBprevTime = currTime;

                if (!activeFrame) {
                    activeFrame = true;
                    processFrame(video, { width, height })
                        .then((response) => {
                            if (!response || response.result === "error") {
                                throw new Error("HB==Error from processFrame");
                            }

                            if (response.result === "skipped") {
                                return;
                            }

                            if (video.currentTime - response.timestamp > 0.5) {
                                return;
                            }

                            processVideoDetections(response.result, video);
                        })
                        .catch((error) => {
                            throw error;
                        })
                        .finally(() => {
                            activeFrame = false;
                        });
                }
            }
        } catch (error) {
            console.log("HB==Video detection loop error", error, video);
            video.dataset.HBerrored =
                parseInt(video.dataset.HBerrored ?? 0) + 1;
        }
    }

    if (video.dataset.HBerrored > 10) {
        video.onplay = null;
        cancelAnimationFrame(video.HBrafId);
        video.removeAttribute("crossorigin");
        return;
    }

    if (!video.paused) {
        video.HBrafId = requestAnimationFrame(() =>
            videoDetectionLoop(video, { width, height })
        );
    } else {
        video.onplay = () => {
            video.HBrafId = requestAnimationFrame(() =>
                videoDetectionLoop(video, { width, height })
            );
        };
    }
};

const processVideo = async (node) => {
    try {
        node.dataset.HBstatus = STATUSES.LOADING;
        await loadVideo(node);
        node.dataset.HBstatus = STATUSES.PROCESSING;

        const { newWidth, newHeight } = calcResize(
            node.videoWidth ?? node.clientWidth,
            node.videoHeight ?? node.clientHeight,
            "video"
        );

        if (!canv) {
            canv = getCanvas(newWidth, newHeight, true);
            ctx = canv.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
            });
        }

        node.width = newWidth;
        node.height = newHeight;

        if (canv.width !== newWidth || canv.height !== newHeight) {
            canv.width = newWidth;
            canv.height = newHeight;
        }

        removeImmediateBlur(node);
        removeBlurryStart(node);

        requestIdleCB(() => {
            videoDetectionLoop(node, { width: newWidth, height: newHeight });
        });
    } catch (e) {
        // Video load failure — pending blur stays, remains blurred
        console.log("HB== processVideo error", e);
    }
};

const processVideoDetections = (result, video) => {
    const prevResult = video.dataset.HBresult;
    const isPrevResultClear = prevResult === RESULTS.CLEAR || !prevResult;
    const currentPositiveCount = parseInt(video.HBpositiveCount ?? 0);
    const currentNegativeCount = parseInt(video.HBnegativeCount ?? 0);
    let shouldBlur = null;

    if (result === "nsfw") {
        video.dataset.HBresult = RESULTS.NSFW;
        video.HBpositiveCount = currentPositiveCount + !isPrevResultClear;
        video.HBnegativeCount = 0;
        if (currentPositiveCount + !isPrevResultClear >= POSITIVE_THRESHOLD) {
            shouldBlur = true;
            video.HBpositiveCount = 0;
        }
    } else if (result === "face") {
        video.dataset.HBresult = RESULTS.FACE;
        video.HBpositiveCount = currentPositiveCount + !isPrevResultClear;
        video.HBnegativeCount = 0;
        if (currentPositiveCount + !isPrevResultClear >= POSITIVE_THRESHOLD) {
            shouldBlur = true;
            video.HBpositiveCount = 0;
        }
    } else {
        video.dataset.HBresult = RESULTS.CLEAR;
        video.HBnegativeCount = currentNegativeCount + isPrevResultClear;
        video.HBpositiveCount = 0;
        if (currentNegativeCount + isPrevResultClear >= NEGATIVE_THRESHOLD) {
            shouldBlur = false;
            video.HBnegativeCount = 0;
        }
    }

    if (shouldBlur !== null) {
        shouldBlur
            ? video.classList.add("hb-blur")
            : video.classList.remove("hb-blur");
    }
};

export { processImage, processVideo };
