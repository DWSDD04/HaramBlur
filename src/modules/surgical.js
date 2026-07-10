// surgical.js
// Surgical blur: overlay divs on detected regions instead of blurring the whole image

/**
 * Normalize a face box from Human.js to [x, y, width, height]
 */
const normalizeBox = (box) => {
    if (Array.isArray(box)) return box;
    if (box && typeof box === "object") {
        return [box.x ?? 0, box.y ?? 0, box.width ?? 0, box.height ?? 0];
    }
    return [0, 0, 0, 0];
};

/**
 * Apply surgical blur overlays to specific regions of an image.
 * Creates absolutely-positioned divs over each detected box.
 */
export const applySurgicalBlur = (node, boxes, blurAmount, gray) => {
    removeSurgicalBlur(node);

    if (!node.naturalWidth || !node.naturalHeight) {
        // Image not fully loaded — fall back to full blur
        node.classList.add("hb-blur");
        return;
    }

    const imgRect = node.getBoundingClientRect();
    const scaleX = imgRect.width / node.naturalWidth;
    const scaleY = imgRect.height / node.naturalHeight;

    let parent = node.parentElement;
    if (!parent) return;

    // Ensure parent is positioned so absolute children anchor correctly
    const parentStyle = window.getComputedStyle(parent);
    if (parentStyle.position === "static") {
        parent.style.position = "relative";
    }

    const parentRect = parent.getBoundingClientRect();
    const offsetX = imgRect.left - parentRect.left;
    const offsetY = imgRect.top - parentRect.top;

    const grayFilter = gray ? "grayscale(100%)" : "";

    boxes.forEach((box) => {
        const [x, y, w, h] = normalizeBox(box);
        if (w <= 0 || h <= 0) return;

        const overlay = document.createElement("div");
        overlay.className = "hb-surgical-blur";
        overlay.dataset.hbOverlay = "true";
        overlay.style.cssText = `
            position: absolute;
            left: ${offsetX + x * scaleX}px;
            top: ${offsetY + y * scaleY}px;
            width: ${w * scaleX}px;
            height: ${h * scaleY}px;
            backdrop-filter: blur(${blurAmount}px) ${grayFilter};
            -webkit-backdrop-filter: blur(${blurAmount}px) ${grayFilter};
            background: rgba(0,0,0,0.05);
            pointer-events: none;
            z-index: 9999;
            border-radius: 6px;
        `;
        parent.appendChild(overlay);
    });

    node.dataset.hbSurgical = "true";
};

/**
 * Remove all surgical blur overlays associated with a node.
 */
export const removeSurgicalBlur = (node) => {
    if (!node.dataset.hbSurgical) return;

    const parent = node.parentElement;
    if (parent) {
        parent
            .querySelectorAll('[data-hb-overlay="true"]')
            .forEach((el) => el.remove());
    }
    delete node.dataset.hbSurgical;
};
