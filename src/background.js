// background.js
// Fixed: Prevents "Only a single offscreen document may be created" error

const defaultSettings = {
    status: true,
    blurryStartMode: false,
    blurAmount: 20,
    blurImages: true,
    blurVideos: true,
    blurMale: false,
    blurFemale: true,
    unblurImages: false,
    unblurVideos: false,
    gray: true,
    strictness: 0.5,
    whitelist: [],
};

chrome.runtime.onInstalled.addListener(function () {
    chrome.storage.sync.get(["hb-settings"], function (result) {
        if (
            result["hb-settings"] === undefined ||
            result["hb-settings"] === null
        ) {
            chrome.storage.sync.set({ "hb-settings": defaultSettings });
        } else {
            chrome.storage.sync.set({
                "hb-settings": { ...defaultSettings, ...result["hb-settings"] },
            });
        }
    });
});

// ============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT — Fixed to prevent duplicates
// ============================================================================

let creatingOffscreen = null;

const createOffscreenDoc = async () => {
    const offscreenUrl = chrome.runtime.getURL("src/offscreen.html");

    // Check if offscreen document already exists (Chrome 116+)
    if ("getContexts" in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl],
        });
        if (contexts.length > 0) {
            console.log("HB== Offscreen document already exists");
            return;
        }
    }

    // Prevent concurrent creation attempts
    if (creatingOffscreen) {
        await creatingOffscreen;
        return;
    }

    try {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ["DOM_PARSER"],
            justification: "Process Images",
        });
        await creatingOffscreen;
        console.log("HB== Offscreen document created");
    } catch (error) {
        // If error is "already exists", ignore it
        if (
            error.message &&
            error.message.includes("Only a single offscreen")
        ) {
            console.log("HB== Offscreen document already exists (caught)");
        } else {
            console.error("HB== Error creating offscreen document:", error);
        }
    } finally {
        creatingOffscreen = null;
    }
};

// Create on startup
createOffscreenDoc();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "getSettings") {
        chrome.storage.sync.get(["hb-settings"], function (result) {
            sendResponse(result["hb-settings"]);

            const isVideoEnabled =
                result["hb-settings"].status &&
                result["hb-settings"].blurVideos;
            chrome.contextMenus.update("enable-detection", {
                enabled: isVideoEnabled,
                checked: isVideoEnabled,
                title: isVideoEnabled
                    ? "Enabled for this video"
                    : "Please enable video detection in settings",
            });
        });
        return true;
    } else if (request.type === "video-status") {
        chrome.contextMenus.update("enable-detection", {
            checked: request.status,
        });
        return true;
    } else if (request.type === "reloadExtension") {
        // Close and recreate offscreen document
        chrome?.offscreen
            ?.closeDocument()
            .then(() => {
                createOffscreenDoc();
            })
            .catch(() => {
                // If close fails (maybe already closed), just create
                createOffscreenDoc();
            });
    }
});

// context menu: "enable detection on this video"
chrome.contextMenus.create({
    id: "enable-detection",
    title: "Enable for this video",
    contexts: ["all"],
    type: "checkbox",
    enabled: true,
    checked: true,
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    console.log("HB== context menu clicked", info, tab);
    if (info.menuItemId === "enable-detection") {
        if (info.checked) {
            chrome.tabs.sendMessage(tab.id, {
                type: "enable-detection",
            });
        } else {
            chrome.tabs.sendMessage(tab.id, {
                type: "disable-detection",
            });
        }
    }
    return true;
});

// on install, onboarding
chrome.runtime.onInstalled.addListener(function (details) {
    if (details?.reason === "install") {
        chrome.tabs.create({
            url: "https://onboard.haramblur.com/",
        });
    }
});

// on uninstall
chrome.runtime.setUninstallURL("https://forms.gle/RovVrtp29vK3Z7To7");
