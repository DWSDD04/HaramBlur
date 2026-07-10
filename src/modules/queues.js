import { loadImage } from "./helpers.js";

class Queue {
    constructor(runDetectionFn) {
        this.loadingQueue = [];
        this.detectionQueue = [];
        this.queuingStarted = false;
        this.activeProcessing = 0;
        this.activeLoading = 0;
        this.maxLoading = 100;
        this.maxProcessing = 1;
        this.runDetection = runDetectionFn;
    }

    async handleElementLoading(img, onSuccess, onError) {
        try {
            const node = await loadImage(img.src, img.width, img.height);
            this.processNextElement(node, onSuccess, onError);
        } catch (error) {
            // FIX: CORS and load failures are expected — don't spam console
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
            // FIX: Send simple error signal instead of object
            onError("error");
        } finally {
            this.activeProcessing--;
            node.src = "";
            node = null;
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
