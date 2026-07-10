// style.js
import { emitEvent, listenToEvent } from "./helpers.js";

const BLURRY_START_MODE_TIMEOUT = 7000;
let hbStyleSheet, _settings;

const initStylesheets = ({ detail }) => {
    _settings = detail;
    hbStyleSheet = document.createElement("style");
    hbStyleSheet.id = "hb-stylesheet";
    document.head.appendChild(hbStyleSheet);
};

const setStyle = ({ detail: settings }) => {
    _settings = settings;
    if (!hbStyleSheet) {
        initStylesheets();
    }
    if (!_settings.shouldDetect()) {
        hbStyleSheet.innerHTML = "";
        return;
    }
    const shouldBlurImages = _settings.shouldBlurImages();
    const shouldBlurVideos = _settings.shouldBlurVideos();
    const shouldUnblurImagesOnHover = _settings.shouldUnblurImages();
    const shouldUnblurVideosOnHover = _settings.shouldUnblurVideos();

    let blurSelectors = [];
    if (shouldBlurImages) blurSelectors.push("img" + ".hb-blur");
    if (shouldBlurVideos) blurSelectors.push("video" + ".hb-blur");
    blurSelectors = blurSelectors.join(", ");

    let unblurSelectors = [];
    if (shouldUnblurImagesOnHover)
        unblurSelectors.push("img" + ".hb-blur:hover");
    if (shouldUnblurVideosOnHover)
        unblurSelectors.push("video" + ".hb-blur:hover");
    unblurSelectors = unblurSelectors.join(", ");

    const blurAmount = _settings.getBlurAmount();
    const gray = _settings.isGray() ? "grayscale(100%)" : "";

    hbStyleSheet.innerHTML = `
		${blurSelectors} {
			filter: blur(${blurAmount}px) ${gray} !important;
			transition: filter 0.1s ease !important;
			opacity: unset !important;
		}
	`;

    if (unblurSelectors) {
        hbStyleSheet.innerHTML += `
			${unblurSelectors} {
				filter: blur(0px) ${_settings.isGray() ? "grayscale(0%)" : ""} !important;
				transition: filter 0.5s ease !important;
				transition-delay: 1s !important;
			}
		`;
    }

    hbStyleSheet.innerHTML += `
		.hb-blur-temp {
			animation: hb-blur-temp ${BLURRY_START_MODE_TIMEOUT}ms ease-in-out forwards !important;
		}

		/* FIX: Blur everything immediately on discovery, unblur only if safe */
		img.hb-pending-blur, video.hb-pending-blur {
			filter: blur(${blurAmount}px) ${gray} !important;
			transition: filter 0.25s ease !important;
			opacity: unset !important;
		}

		#hb-in-canvas {
			display: none !important;
			visibility: hidden !important;
		}

		@keyframes hb-blur-temp {
			0% { filter: blur(${blurAmount}px) ${gray}; }
			95% { filter: blur(${blurAmount}px) ${gray}; }
			100% { filter: blur(0px) ${_settings.isGray() ? "grayscale(0%)" : ""}; }
		}
	`;
};

const applyBlurryStart = (node) => {
    if (_settings?.isBlurryStartMode()) {
        node.classList.add("hb-blur-temp");
    }
};

const removeBlurryStart = (node) => {
    node.classList.remove("hb-blur-temp");
};

const applyImmediateBlur = (node) => {
    node.classList.add("hb-pending-blur");
};

const removeImmediateBlur = (node) => {
    node.classList.remove("hb-pending-blur");
};

const attachStyleListener = () => {
    listenToEvent("settingsLoaded", initStylesheets);
    listenToEvent("toggleOnOffStatus", setStyle);
    listenToEvent("changeBlurAmount", setStyle);
    listenToEvent("changeGray", setStyle);
};

export {
    attachStyleListener,
    applyBlurryStart,
    removeBlurryStart,
    applyImmediateBlur,
    removeImmediateBlur,
};
