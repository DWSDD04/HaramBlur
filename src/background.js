// background.js
// Fixed: Prevents duplicate context menu and offscreen document errors

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

// ============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT
// ============================================================================

let creatingOffscreen = null;

const createOffscreenDoc = async () => {
    const offscreenUrl = chrome.runtime.getURL("src/offscreen.html");

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

// ============================================================================
// INSTALL / UPDATE — Settings, context menu, onboarding
// ============================================================================

chrome.runtime.onInstalled.addListener(function (details) {
    // 1. Initialize settings
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

    // 2. FIX: Remove all context menus, then create to prevent duplicate ID error
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: "enable-detection",
            title: "Enable for this video",
            contexts: ["all"],
            type: "checkbox",
            enabled: true,
            checked: true,
        });
    });

    // 3. Onboarding on first install
    if (details?.reason === "install") {
        chrome.tabs.create({
            url: "https://onboard.haramblur.com/",
        });
    }
});

// ============================================================================
// STARTUP — Create offscreen document (service worker wake)
// ============================================================================

createOffscreenDoc();

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

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
        chrome?.offscreen
            ?.closeDocument()
            .then(() => {
                createOffscreenDoc();
            })
            .catch(() => {
                createOffscreenDoc();
            });
    }
});

// ============================================================================
// CONTEXT MENU CLICK HANDLER
// ============================================================================

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

// ============================================================================
// UNINSTALL
// ============================================================================

chrome.runtime.setUninstallURL("https://forms.gle/RovVrtp29vK3Z7To7");
