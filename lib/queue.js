const EventEmitter = require('events').EventEmitter;
const errors = require('../errors');

class Queue extends EventEmitter {
    constructor() {
        super();

        this.queue = [];
        this.users = {};
        this.running = false;
    }

    size() {
        return this.queue.length;
    }

    process(concurrency, controller, handler) {
        this.handler = handler;
        this.controller = controller;
        this.concurrency = concurrency;
        this.processing = 0;

        this.start();

        // Monkey patch to ensure queue processing size is roughly equal to amount of bots ready
        setInterval(() => {
            // Update concurrency level based on proxy pool manager if available
            const oldConcurrency = this.concurrency;
            
            if (controller.proxyPoolManager) {
                // Use proxy pool manager's max concurrency
                const maxProxyConcurrency = controller.proxyPoolManager.getMaxConcurrency();
                const readyBots = controller.getReadyAmount();
                // Use the smaller of the two limits
                this.concurrency = Math.min(maxProxyConcurrency, readyBots);
            } else {
                // Fallback to original logic
                this.concurrency = controller.getReadyAmount();
            }

            if (this.concurrency > oldConcurrency) {
                for (let i = 0; i < this.concurrency - oldConcurrency; i++) {
                    this.checkQueue();
                }
            }

        }, 50);
    }

    addJob(job, max_attempts) {
        if (!(job.ip in this.users)) {
            this.users[job.ip] = 0;
        }

        for (const link of job.getRemainingLinks()) {
            this.queue.push({
                data: link,
                max_attempts: max_attempts,
                attempts: 0,
                ip: job.ip,
            });

            this.users[job.ip]++;
            this.checkQueue();
        }
    }

    checkQueue() {
        if (!this.running) return;

        // Check if proxy pool manager can accept more requests
        if (this.controller && this.controller.proxyPoolManager) {
            if (!this.controller.proxyPoolManager.canAcceptMoreRequests()) {
                // No available proxy groups, wait
                return;
            }
        }

        if (this.queue.length > 0 && this.processing < this.concurrency) {
            // there is a free bot, process the job
            let job = this.queue.shift();

            this.processing += 1;

            this.handler(job).then((delay) => {
                if (!delay) delay = 0;

                // Allow users to request again before the promise resolve delay
                this.users[job.ip]--;

                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        resolve();
                    }, delay);
                });
            }).catch((err) => {
                if (err !== errors.NoBotsAvailable) {
                    job.attempts++;
                }

                if (job.attempts === job.max_attempts) {
                    // job failed
                    this.emit('job failed', job, err);
                    this.users[job.ip]--;
                }
                else {
                    // try again
                    this.queue.unshift(job);
                }
            }).then(() => {
                this.processing -= 1;
                this.checkQueue();
            });
        }
    }

    start() {
        if (!this.running) {
            this.running = true;
            this.checkQueue();
        }
    }

    pause() {
        if (this.running) this.running = false;
    }

    /**
     * Returns number of requests the ip currently has queued
     */
    getUserQueuedAmt(ip) {
        return this.users[ip] || 0;
    }
}

module.exports = Queue;
