import {
    containsNsfw,
    containsGenderFace,
    Detector,
} from "./modules/detector.js";
import Queue from "./modules/queues.js";
import Settings from "./modules/settings.js";

var settings;
var queue;
var detector = new Detector();

// ============================================================================
// HEARTBEAT — Auto-reload offscreen document if it freezes
// ============================================================================
let lastHeartbeat = Date.now();

const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastHeartbeat > 30000) {
        console.warn("HB== Offscreen heartbeat stale (>30s), reloading");
        clearInterval(heartbeatInterval);
        location.reload();
    }
}, 30000);

const loadModels = async () => {
    try {
        await detector.initHuman();
        await detector.initNsfwModel();
        detector.human.events?.addEventListener("error", (e) => {
            chrome.runtime.sendMessage({ type: "reloadExtension" });
        });
    } catch (e) {
        console.log("Error loading models", e);
    }
};

const handleImageDetection = (request, sender, sendResponse) => {
    queue.add(
        request.image,
        (result) => {
            sendResponse(result);
        },
        (error) => {
            // FIX: Send simple string instead of object — content script expects string/boolean only
            sendResponse("error");
        }
    );
};

let activeFrame = false;
let frameImage = new Image();

const handleVideoDetection = async (request, sender, sendResponse) => {
    const { frame } = request;
    const { data, timestamp } = frame;
    if (activeFrame) {
        sendResponse({ result: "skipped" });
        return;
    }
    activeFrame = true;
    frameImage.onload = () => {
        runDetection(frameImage, true)
            .then((result) => {
                activeFrame = false;
                sendResponse({ type: "detectionResult", result, timestamp });
            })
            .catch((e) => {
                activeFrame = false;
                sendResponse({ result: "error" });
            });
    };
    frameImage.onerror = (e) => {
        activeFrame = false;
        sendResponse({ result: "error" });
    };
    frameImage.src = data;
};

const startListening = () => {
    settings.listenForChanges();
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        lastHeartbeat = Date.now(); // keepalive on every message

        if (request.type === "imageDetection") {
            handleImageDetection(request, sender, sendResponse);
        }
        if (request.type === "videoDetection") {
            handleVideoDetection(request, sender, sendResponse);
        }
        return true;
    });
};

const runDetection = async (img, isVideo = false) => {
    if (!settings?.shouldDetect() || !img) return false;
    const tensor = detector.human.tf.browser.fromPixels(img);
    const nsfwResult = await detector.nsfwModelClassify(tensor);
    const strictness = settings.getStrictness() * (isVideo ? 0.75 : 1);
    activeFrame = false;
    if (containsNsfw(nsfwResult, strictness)) {
        detector.human.tf.dispose(tensor);
        return "nsfw";
    }
    if (!settings.shouldDetectGender()) {
        detector.human.tf.dispose(tensor);
        return false;
    }
    const predictions = await detector.humanModelClassify(tensor);
    detector.human.tf.dispose(tensor);

    const genderResult = containsGenderFace(
        predictions,
        settings.shouldDetectMale(),
        settings.shouldDetectFemale()
    );
    if (genderResult) return genderResult;
    return false;
};

const init = async () => {
    let _settings = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "getSettings" }, (settings) => {
            resolve(settings);
        });
    });
    settings = await Settings.init(_settings["hb-settings"]);
    console.log("Settings loaded", settings);
    try {
        await loadModels();
        console.log("Models loaded", detector.human, detector.nsfwModel);
    } catch (error) {
        console.log("Error loading models", error);
        chrome.runtime.sendMessage({ type: "reloadExtension" });
        return;
    }

    queue = new Queue(runDetection);
    startListening();
};

init();
