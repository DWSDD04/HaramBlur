// detector.js
// Robust version for Human.js 3.3.6
// Works with local ../tfjs/human.js loaded via script tag

// Human is loaded globally via <script src="../tfjs/human.js"> in offscreen.html
// v2.x exposes window.Human.Human, v3.x exposes window.Human directly
const HumanClass = window.Human?.Human || window.Human;
if (!HumanClass) {
    console.error(
        "HB== Human library not loaded! Check ../tfjs/human.js file."
    );
}

const nsfwUrl = chrome.runtime.getURL("src/assets/models/nsfwjs/model.json");

// ============================================================================
// HUMAN CONFIG — Minimal config, let Human v3 use its smart defaults
// ============================================================================
const HUMAN_CONFIG = {
    // Backend: 'webgl' is the standard name (was 'humangl' in v2.x)
    backend: "webgl",

    // Model base path
    modelBasePath: "https://cdn.jsdelivr.net/npm/@vladmandic/human/models/",

    // Process asynchronously for better performance
    async: true,

    // Face detection configuration
    face: {
        enabled: true,
        iris: { enabled: false },
        mesh: { enabled: false },

        // In Human v3, default detector is already blazeface-back
        // We don't specify modelPath to avoid path issues
        detector: {
            maxDetected: 2,
            minConfidence: 0.25,
        },

        description: {
            enabled: true,
        },

        emotion: { enabled: false },
    },

    // Disable everything else we don't need
    body: { enabled: false },
    hand: { enabled: false },
    gesture: { enabled: false },
    object: { enabled: false },
};

// ============================================================================
// NSFW CONFIG
// ============================================================================
const NSFW_CONFIG = {
    size: 224,
    tfScalar: 255,
    topK: 3,
    skipTime: 4000,
    skipFrames: 99,
    cacheSensitivity: 0.9,
};

// ============================================================================
// NSFW CLASS THRESHOLDS
// ============================================================================
const getNsfwClasses = (factor = 0) => {
    return {
        0: { className: "Drawing", nsfw: false, thresh: 0.5 },
        1: {
            className: "Hentai",
            nsfw: true,
            thresh: 0.5 + (1 - factor) * 0.5,
        },
        2: { className: "Neutral", nsfw: false, thresh: 0.5 + factor * 0.5 },
        3: { className: "Porn", nsfw: true, thresh: 0.1 + (1 - factor) * 0.4 },
        4: { className: "Sexy", nsfw: true, thresh: 0.1 + (1 - factor) * 0.4 },
    };
};

// ============================================================================
// DETECTOR CLASS — With robust error handling
// ============================================================================
class Detector {
    constructor() {
        this._human = null;
        this._nsfwModel = null;
        this.nsfwCache = {
            predictions: [],
            timestamp: 0,
            skippedFrames: 0,
            lastInputTensor: null,
        };
        this._initError = null;
    }

    get human() {
        return this._human;
    }

    get nsfwModel() {
        return this._nsfwModel;
    }

    // ------------------------------------------------------------------------
    // INIT HUMAN — With detailed error logging
    // ------------------------------------------------------------------------
    initHuman = async () => {
        if (!HumanClass) {
            throw new Error(
                "Human library not available - check ../tfjs/human.js"
            );
        }

        try {
            console.log("HB== Initializing Human...");
            this._human = new HumanClass(HUMAN_CONFIG);
            console.log("HB== Human instance created");

            await this._human.load();
            console.log("HB== Human models loaded");

            this._human.tf.enableProdMode();

            // Warmup
            const tensor = this._human.tf.zeros([1, 224, 224, 3]);
            await this._human.detect(tensor);
            this._human.tf.dispose(tensor);

            const version = this._human.version || "unknown";
            console.log("HB== Human model warmed up (v" + version + ")");
        } catch (error) {
            console.error("HB== Failed to initialize Human:", error.message);
            this._initError = error;
            throw error;
        }
    };

    // ------------------------------------------------------------------------
    // HUMAN CLASSIFY
    // ------------------------------------------------------------------------
    humanModelClassify = async (tensor, needToResize) => {
        if (!this._human) await this.initHuman();

        try {
            const promise = needToResize
                ? this._human.detect(tensor, {
                      filter: {
                          enabled: true,
                          width: needToResize?.newWidth,
                          height: needToResize?.newHeight,
                      },
                  })
                : this._human.detect(tensor);

            return promise;
        } catch (error) {
            console.error("HB== Human detection error:", error.message);
            throw error;
        }
    };

    // ------------------------------------------------------------------------
    // INIT NSFW MODEL
    // ------------------------------------------------------------------------
    initNsfwModel = async () => {
        try {
            const indexedDBModel =
                typeof indexedDB !== "undefined" &&
                (await this._human.tf.io.listModels());

            if (indexedDBModel?.["indexeddb://nsfw-model"]) {
                this._nsfwModel = await this._human.tf.loadGraphModel(
                    "indexeddb://nsfw-model"
                );
                console.log("HB== NSFW model loaded from IndexedDB");
            } else {
                this._nsfwModel = await this._human.tf.loadGraphModel(nsfwUrl);
                await this._nsfwModel.save("indexeddb://nsfw-model");
                console.log("HB== NSFW model loaded from bundle and cached");
            }

            const tensor = this._human.tf.zeros([1, 224, 224, 3]);
            await this._nsfwModel.predict(tensor);
            this._human.tf.dispose(tensor);
            console.log("HB== NSFW model warmed up");
        } catch (error) {
            console.error(
                "HB== Failed to initialize NSFW model:",
                error.message
            );
            throw error;
        }
    };

    // ------------------------------------------------------------------------
    // NSFW FRAME SKIP
    // ------------------------------------------------------------------------
    nsfwModelSkip = async (input, config) => {
        const tf = this._human.tf;
        let skipFrame = false;

        if (
            config.cacheSensitivity === 0 ||
            !input?.shape ||
            input?.shape.length !== 4 ||
            input?.shape[1] > 3840 ||
            input?.shape[2] > 2160
        )
            return skipFrame;

        if (!this.nsfwCache.lastInputTensor) {
            this.nsfwCache.lastInputTensor = tf.clone(input);
        } else if (
            this.nsfwCache.lastInputTensor.shape[1] !== input.shape[1] ||
            this.nsfwCache.lastInputTensor.shape[2] !== input.shape[2]
        ) {
            tf.dispose(this.nsfwCache.lastInputTensor);
            this.nsfwCache.lastInputTensor = tf.clone(input);
        } else {
            const t = {};
            t.diff = tf.sub(input, this.nsfwCache.lastInputTensor);
            t.squared = tf.mul(t.diff, t.diff);
            t.sum = tf.sum(t.squared);
            const diffSum = await t.sum.data();
            const diffRelative =
                diffSum[0] /
                (input.shape[1] || 1) /
                (input.shape[2] || 1) /
                255 /
                3;
            tf.dispose([
                this.nsfwCache.lastInputTensor,
                t.diff,
                t.squared,
                t.sum,
            ]);
            this.nsfwCache.lastInputTensor = tf.clone(input);
            skipFrame = diffRelative <= (config.cacheSensitivity || 0);
        }
        return skipFrame;
    };

    // ------------------------------------------------------------------------
    // NSFW CLASSIFY
    // ------------------------------------------------------------------------
    nsfwModelClassify = async (tensor, config = NSFW_CONFIG) => {
        if (!this._human) await this.initHuman();
        if (!this._nsfwModel) await this.initNsfwModel();

        const tf = this._human.tf;
        if (!tensor) return [];

        let resized, expanded;

        try {
            const skipAllowed = await this.nsfwModelSkip(tensor, config);
            const skipFrame =
                this.nsfwCache.skippedFrames < (config.skipFrames || 0);
            const skipTime =
                (config.skipTime || 0) >
                (performance?.now?.() || Date.now()) - this.nsfwCache.timestamp;

            if (
                !skipAllowed ||
                !skipTime ||
                !skipFrame ||
                this.nsfwCache.predictions.length === 0
            ) {
                if (
                    tensor.shape[1] !== config.size ||
                    tensor.shape[2] !== config.size
                ) {
                    resized = tf.image.resizeNearestNeighbor(tensor, [
                        config.size,
                        config.size,
                    ]);
                }
                if (
                    (resized && resized.shape.length === 3) ||
                    tensor.shape.length === 3
                ) {
                    expanded = tf.expandDims(resized || tensor, 0);
                }

                const scalar = tf.scalar(config.tfScalar);
                const normalized = tf.div(
                    expanded || resized || tensor,
                    scalar
                );
                const logits = await this._nsfwModel.predict(normalized);

                this.nsfwCache.predictions = await this.getTopKClasses(
                    logits,
                    config.topK
                );
                this.nsfwCache.timestamp = performance?.now?.() || Date.now();
                this.nsfwCache.skippedFrames = 0;

                tf.dispose(
                    [scalar, normalized, logits]
                        .concat(expanded ? [expanded] : [])
                        .concat(resized ? [resized] : [])
                );
            } else {
                this.nsfwCache.skippedFrames++;
            }

            return this.nsfwCache.predictions;
        } catch (error) {
            console.error("HB== NSFW Detection Error:", error.message);
            return [];
        }
    };

    // ------------------------------------------------------------------------
    // GET TOP K CLASSES
    // ------------------------------------------------------------------------
    getTopKClasses = async (logits, topK) => {
        const values = await logits.data();
        const valuesAndIndices = [];

        for (let i = 0; i < values.length; i++) {
            valuesAndIndices.push({ value: values[i], index: i });
        }

        valuesAndIndices.sort((a, b) => b.value - a.value);

        const topkValues = new Float32Array(topK);
        const topkIndices = new Int32Array(topK);

        for (let i = 0; i < topK; i++) {
            topkValues[i] = valuesAndIndices[i].value;
            topkIndices[i] = valuesAndIndices[i].index;
        }

        const topClassesAndProbs = [];
        for (let i = 0; i < topkIndices.length; i++) {
            topClassesAndProbs.push({
                className: getNsfwClasses()?.[topkIndices[i]]?.className,
                probability: topkValues[i],
                id: topkIndices[i],
            });
        }
        return topClassesAndProbs;
    };
}

// ============================================================================
// NSFW DETECTION HELPER
// ============================================================================
const containsNsfw = (nsfwDetections, strictness) => {
    if (!nsfwDetections?.length) return false;
    let highestNsfwDelta = 0;
    let highestSfwDelta = 0;

    const nsfwClasses = getNsfwClasses(strictness);
    nsfwDetections.forEach((det) => {
        if (nsfwClasses?.[det.id]?.nsfw) {
            highestNsfwDelta = Math.max(
                highestNsfwDelta,
                det.probability - nsfwClasses[det.id].thresh
            );
        } else {
            highestSfwDelta = Math.max(
                highestSfwDelta,
                det.probability - nsfwClasses[det.id].thresh
            );
        }
    });
    return highestNsfwDelta > highestSfwDelta;
};

// ============================================================================
// GENDER DETECTION HELPER
// ============================================================================
const genderPredicate = (gender, score, detectMale, detectFemale) => {
    const mPredicate =
        (gender === "male" && score > 0.3) ||
        (gender === "female" && score < 0.2);

    const fePredicate = gender === "female" && score > 0.25;

    if (detectMale && detectFemale) return mPredicate || fePredicate;
    if (detectMale && !detectFemale) return mPredicate;
    if (!detectMale && detectFemale) return fePredicate;

    return false;
};

const containsGenderFace = (detections, detectMale, detectFemale) => {
    if (!detections?.face?.length) {
        return false;
    }

    const faces = detections.face;
    const boxes = [];

    if (detectMale || detectFemale) {
        for (const face of faces) {
            if (
                face.age > 20 &&
                genderPredicate(
                    face.gender,
                    face.genderScore,
                    detectMale,
                    detectFemale
                )
            ) {
                boxes.push(face.box);
            }
        }
    }

    if (!boxes.length) return false;
    return { result: "face", boxes };
};

export { getNsfwClasses, containsNsfw, containsGenderFace, Detector };
