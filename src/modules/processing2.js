// processing2.js
// Fixed: Better error handling, no scary warnings for expected errors

import {
    calcResize,
    loadVideo,
    getCanvas,
    emitEvent,
    requestIdleCB,
    canvToBlob,
} from "./helpers";
import { removeBlurryStart } from "./style";
import { STATUSES } from "../constants.js";

const FRAME_RATE = 1000 / 25; // 25 fps
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

// ============================================================================
// PROCESS IMAGE — Fixed error handling
// ============================================================================
const processImage = (node, STATUSES) => {
    try {
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
                removeBlurryStart(node);

                // Handle error responses silently (tracking pixels, CORS, etc.)
                if (!response) {
                    // No response - probably a tracking pixel or CORS issue
                    // Don't log error, just mark as processed (no blur)
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    return;
                }

                if (response.type === "error") {
                    // Expected errors: tracking pixels, CORS blocks, load failures
                    // Silently mark as processed without blur
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    return;
                }

                // Handle string results (normal detection)
                if (response === "face" || response === "nsfw") {
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    node.classList.add("hb-blur");
                    node.dataset.HBresult = response;
                } else if (
                    response === false ||
                    response === "clear" ||
                    response === RESULTS.CLEAR
                ) {
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                    node.classList.remove("hb-blur");
                    delete node.dataset.HBresult;
                } else {
                    // Unknown response - log at debug level only
                    console.debug(
                        "HB==Unknown response from processing image:",
                        response
                    );
                    node.dataset.HBstatus = STATUSES.PROCESSED;
                }
            }
        );
    } catch (e) {
        // Silently handle any unexpected errors
        node.dataset.HBstatus = STATUSES.PROCESSED;
        removeBlurryStart(node);
    }
};

// ============================================================================
// PROCESS FRAME — Same as before
// ============================================================================
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
                    resolve(response);
                }
            );
        } catch (e) {
            reject(e);
        }
    });
};

// ============================================================================
// VIDEO DETECTION LOOP — Same as before
// ============================================================================
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
                        .then(({ result, timestamp }) => {
                            if (result === "error") {
                                throw new Error("HB==Error from processFrame");
                            }

                            if (result === "skipped") {
                                return;
                            }

                            if (video.currentTime - timestamp > 0.5) {
                                return;
                            }

                            processVideoDetections(result, video);
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

// ============================================================================
// PROCESS VIDEO — Same as before
// ============================================================================
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

        removeBlurryStart(node);

        requestIdleCB(() => {
            videoDetectionLoop(node, { width: newWidth, height: newHeight });
        });
    } catch (e) {
        console.log("HB== processVideo error", e);
    }
};

// ============================================================================
// PROCESS VIDEO DETECTIONS — Same as before
// ============================================================================
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
