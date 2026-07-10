import { loadImage } from "./helpers.js";

class Queue {
    constructor(runDetectionFn) {
        this.loadingQueue = [];
        this.detectionQueue = [];
        this.queuingStarted = false;
        this.activeProcessing = 0;
        this.activeLoading = 0;
        this.maxLoading = 100;
        // Dynamic concurrency based on hardware cores
        // Cap at 4 to avoid overwhelming GPU memory
        const cores = navigator.hardwareConcurrency || 2;
        this.maxProcessing = Math.min(cores > 4 ? 4 : 2, 4);
        this.runDetection = runDetectionFn;
    }

    async handleElementLoading(img, onSuccess, onError) {
        try {
            const node = await loadImage(img.src, img.width, img.height);
            this.processNextElement(node, onSuccess, onError);
        } catch (error) {
            // CORS and load failures are expected — don't spam console
            onError("error");
        } finally {
            this.activeLoading--;
            if (this.loadingQueue.length) {
                this.handleElementLoading(...this.loadingQueue.shift());
            }
        }
    }

    async handleElementProcessing(node, onSuccess, onError) {
        try {
            const result = await this.runDetection(node);
            onSuccess(result);
        } catch (error) {
            // Send simple error signal instead of object
            onError("error");
        } finally {
            this.activeProcessing--;
            // Best-effort cleanup: drop the src so the Image element can be GC'd
            if (node && node.src) {
                node.src = "";
            }
            if (this.detectionQueue.length) {
                this.handleElementProcessing(...this.detectionQueue.shift());
            }
        }
    }

    async processNextElement(node, onSuccess, onError) {
        try {
            if (this.activeProcessing < this.maxProcessing) {
                this.activeProcessing++;
                this.handleElementProcessing(node, onSuccess, onError);
            } else {
                this.detectionQueue.push([node, onSuccess, onError]);
            }
        } catch (error) {
            onError("error");
        }
    }

    async add(img, onSuccess, onError) {
        try {
            if (this.activeLoading < this.maxLoading) {
                this.activeLoading++;
                this.handleElementLoading(img, onSuccess, onError);
            } else {
                this.loadingQueue.push([img, onSuccess, onError]);
            }
        } catch (error) {
            onError("error");
        }
    }
}

export default Queue;
