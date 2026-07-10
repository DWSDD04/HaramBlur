// observers.js
import {
    disableVideo,
    enableVideo,
    isImageTooSmall,
    listenToEvent,
    processNode,
    updateBGvideoStatus,
} from "./helpers.js";

import { applyImmediateBlur } from "./style.js";
import { processImage, processVideo } from "./processing2.js";
import { STATUSES } from "../constants.js";

let mutationObserver, _settings;
let videosInProcess = [];
let ioObserver = null;
let shadowObservers = new Map(); // shadowRoot -> MutationObserver

// ============================================================================
// INTERSECTION OBSERVER — Only process images/videos that enter viewport
// ============================================================================
const initIntersectionObserver = () => {
    ioObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const node = entry.target;
                    ioObserver.unobserve(node);

                    if (node.tagName === "IMG") {
                        processImage(node, STATUSES, _settings);
                    } else if (node.tagName === "VIDEO") {
                        processVideo(node, STATUSES);
                        videosInProcess.push(node);
                        updateBGvideoStatus(videosInProcess);
                    }
                }
            });
        },
        { rootMargin: "300px" } // Start loading slightly before scroll into view
    );
};

// ============================================================================
// SHADOW DOM OBSERVER — Watch for mutations inside shadow roots
// ============================================================================
const observeShadowRoot = (shadowRoot) => {
    if (shadowObservers.has(shadowRoot)) return;

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === "childList") {
                mutation.addedNodes.forEach((node) => {
                    if (
                        !(node instanceof HTMLElement) ||
                        node.tagName === "LINK" ||
                        node.tagName === "STYLE" ||
                        node.tagName === "SCRIPT" ||
                        node.tagName === "META"
                    ) {
                        return;
                    }
                    // Recursively observe nested shadow roots
                    if (node.shadowRoot) {
                        observeShadowRoot(node.shadowRoot);
                    }
                    processNode(node, (n) => observeNode(n, false));
                });
            } else if (
                mutation.type === "attributes" &&
                mutation.attributeName === "src"
            ) {
                observeNode(mutation.target, true);
            }
        });
    });

    shadowObservers.set(shadowRoot, observer);
    observer.observe(shadowRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
    });

    // Process existing content inside this shadow root immediately
    processNode(shadowRoot, (n) => observeNode(n, false));
};

// ============================================================================
// SCAN FOR EXISTING SHADOW ROOTS
// ============================================================================
const scanForShadowRoots = (root = document.documentElement) => {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
        if (el.shadowRoot) {
            observeShadowRoot(el.shadowRoot);
        }
    }
};

// ============================================================================
// MAIN MUTATION OBSERVER
// ============================================================================
const startObserving = () => {
    if (!mutationObserver) initMutationObserver();

    mutationObserver?.observe(document, {
        childList: true,
        characterData: false,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
    });
};

const initMutationObserver = () => {
    mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === "childList") {
                mutation.addedNodes.forEach((node) => {
                    // Skip non-element nodes and tags that can't contain images/videos
                    if (
                        !(node instanceof HTMLElement) ||
                        node.tagName === "LINK" ||
                        node.tagName === "STYLE" ||
                        node.tagName === "SCRIPT" ||
                        node.tagName === "META"
                    ) {
                        return;
                    }
                    // Watch this element's shadow root if it has one
                    if (node.shadowRoot) {
                        observeShadowRoot(node.shadowRoot);
                    }
                    processNode(node, (node) => {
                        observeNode(node, false);
                    });
                });
            } else if (mutation.type === "attributes") {
                const node = mutation.target;
                observeNode(node, mutation?.attributeName === "src");
            }
        });
    });
    startObserving();
    // Catch shadow roots that were created before the content script loaded
    scanForShadowRoots();
};

const attachObserversListener = () => {
    listenToEvent("settingsLoaded", ({ detail: settings }) => {
        _settings = settings;
        if (!_settings.shouldDetect()) {
            mutationObserver?.disconnect();
            mutationObserver = null;
            shadowObservers.forEach((obs) => obs.disconnect());
            shadowObservers.clear();
        } else {
            if (!mutationObserver) startObserving();
        }
    });

    listenToEvent("toggleOnOffStatus", () => {
        if (!_settings?.shouldDetect()) {
            mutationObserver?.disconnect();
            mutationObserver = null;
            shadowObservers.forEach((obs) => obs.disconnect());
            shadowObservers.clear();
        } else {
            if (!mutationObserver) startObserving();
        }
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === "disable-detection") {
            videosInProcess
                .filter(
                    (video) =>
                        video.dataset.HBstatus === STATUSES.PROCESSING &&
                        !video.paused &&
                        video.currentTime > 0
                )
                .forEach((video) => {
                    disableVideo(video);
                });
        } else if (request.type === "enable-detection") {
            videosInProcess
                .filter(
                    (video) =>
                        video.dataset.HBstatus === STATUSES.DISABLED &&
                        !video.paused &&
                        video.currentTime > 0
                )
                .forEach((video) => {
                    enableVideo(video);
                });
        }
        return true;
    });
};

const killObserver = () => {
    mutationObserver?.disconnect();
    mutationObserver = null;
    ioObserver?.disconnect();
    ioObserver = null;
    shadowObservers.forEach((obs) => obs.disconnect());
    shadowObservers.clear();
};

function observeNode(node, srcAttribute) {
    const isVideo = node.tagName === "VIDEO";
    if (
        !(
            (!isVideo && (_settings ? _settings.shouldDetectImages() : true)) ||
            (isVideo && (_settings ? _settings.shouldDetectVideos() : true))
        )
    )
        return;

    let sourceChildren = isVideo
        ? node.getElementsByTagName("source")?.length
        : 0;

    const conditions =
        (srcAttribute || !node.dataset.HBstatus) &&
        (node.src?.length > 0 || sourceChildren > 0) &&
        (isVideo
            ? true
            : !isImageTooSmall(node) || node.height === 0 || node.width === 0);

    if (!conditions) {
        return;
    }

    // Blur immediately on discovery. Detection will unblur if safe.
    applyImmediateBlur(node);
    node.dataset.HBstatus = STATUSES.OBSERVED;

    // Only process when the element enters the viewport
    if (!ioObserver) initIntersectionObserver();
    ioObserver.observe(node);
}

export {
    attachObserversListener,
    initMutationObserver,
    STATUSES,
    killObserver,
};
