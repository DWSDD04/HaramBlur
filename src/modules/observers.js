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
                    // FIX: Skip non-element nodes and tags that can't contain images/videos
                    // This also avoids interacting with browser speculation APIs (<link rel="expect">)
                    if (
                        !(node instanceof HTMLElement) ||
                        node.tagName === "LINK" ||
                        node.tagName === "STYLE" ||
                        node.tagName === "SCRIPT" ||
                        node.tagName === "META"
                    ) {
                        return;
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
};

const attachObserversListener = () => {
    listenToEvent("settingsLoaded", ({ detail: settings }) => {
        _settings = settings;
        if (!_settings.shouldDetect()) {
            mutationObserver?.disconnect();
            mutationObserver = null;
        } else {
            if (!mutationObserver) startObserving();
        }
    });

    listenToEvent("toggleOnOffStatus", () => {
        if (!_settings?.shouldDetect()) {
            mutationObserver?.disconnect();
            mutationObserver = null;
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

    if (node.src?.length || sourceChildren > 0) {
        if (node.tagName === "IMG") processImage(node, STATUSES);
        else if (node.tagName === "VIDEO") {
            processVideo(node, STATUSES);
            videosInProcess.push(node);
            updateBGvideoStatus(videosInProcess);
        }
    } else {
        delete node.dataset?.HBstatus;
    }
}

export {
    attachObserversListener,
    initMutationObserver,
    STATUSES,
    killObserver,
};
