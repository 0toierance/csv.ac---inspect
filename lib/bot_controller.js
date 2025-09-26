const Bot = require('./bot'),
    utils = require('./utils'),
    EventEmitter = require('events').EventEmitter,
    errors = require('../errors');

// Use global winston if available, otherwise require it
const winston = global.winston || require('winston');

class BotController extends EventEmitter {
    constructor() {
        super();

        this.readyEvent = false;
        this.bots = [];
        this.proxyPoolManager = null;
        this.pendingAuthBots = new Map();  // Track bots waiting for Steam Guard
        this.spareAccounts = [];  // Accounts not yet tried
        this.failedAccounts = new Map();  // Accounts that permanently failed
        this.maxOnlineBots = 300;  // Default, will be overridden by config
        this.botRetryCount = new Map();  // Track retry attempts per account
        
        // Spare account queue management
        this.spareAccountQueue = [];  // Queue of spare accounts waiting to be added
        this.isProcessingSpareQueue = false;  // Flag to prevent multiple queue processors
        this.spareAccountDelay = 5000;  // 5 seconds between spare account logins
    }

    addBot(loginData, settings) {
        let bot = new Bot(settings);
        
        // IMPORTANT: Set up event handlers BEFORE calling logIn to ensure we catch immediate failures
        bot.on('ready', () => {
            if (!this.readyEvent && this.hasBotOnline()) {
                this.readyEvent = true;
                this.emit('ready');
            }
        });

        bot.on('unready', () => {
            if (this.readyEvent && this.hasBotOnline() === false) {
                this.readyEvent = false;
                this.emit('unready');
            }
            
            // Check if we need to add a spare to maintain target
            setTimeout(() => {
                this.checkAndMaintainBotCount();
            }, 5000); // Small delay to avoid rapid replacement
        });

        // Handle login failures for proxy reassignment
        bot.on('loginFailed', (error, reason) => {
            this.handleBotLoginFailure(bot, loginData, error, reason);
        });

        // Handle successful login
        bot.on('loginSuccess', () => {
            if (this.proxyPoolManager) {
                this.proxyPoolManager.handleLoginSuccess(bot);
            }
            // Remove from pending auth if it was there
            this.pendingAuthBots.delete(loginData.user);
        });

        // Remove Steam Guard handlers since we're treating them as retry-able errors
        // bot.on('authRequired', ...) - removed
        
        // Handle permanent auth failures (wrong password, etc)
        bot.on('authFailed', (error) => {
            winston.error(`Bot ${loginData.user} has permanent auth failure: ${error.message || error}`);
            // Mark as failed and try spare
            this.markAccountFailed(loginData.user, `Auth failure: ${error.message || error}`);
        });

        this.bots.push(bot);
        
        // NOW initiate login after all event handlers are attached
        bot.logIn(loginData.user, loginData.pass, loginData.auth);
        
        return bot;
    }

    getFreeBot() {
        // Use proxy pool manager if available
        if (this.proxyPoolManager) {
            const bot = this.proxyPoolManager.getAvailableBot('least_loaded');
            return bot || false;
        }
        
        // Fallback to original logic if no proxy pool manager
        for (let bot of utils.shuffleArray(this.bots)) {
            if (!bot.busy && bot.ready) return bot;
        }

        return false;
    }

    hasBotOnline() {
        for (let bot of this.bots) {
            if (bot.ready) return true;
        }

        return false;
    }

    getReadyAmount() {
        let amount = 0;
        for (const bot of this.bots) {
            if (bot.ready) {
                amount++;
            }
        }
        return amount;
    }

    setProxyPoolManager(manager) {
        this.proxyPoolManager = manager;
        if (manager && this.bots.length > 0) {
            manager.distributeBots(this.bots);
        }
    }

    releaseBot(bot, success = true) {
        if (this.proxyPoolManager) {
            this.proxyPoolManager.releaseBot(bot, success);
        }
    }

    handleBotLoginFailure(bot, loginData, error, reason) {
        winston.warn(`Bot ${loginData.user} login failed: ${error.message || error} (reason: ${reason})`);
        winston.debug(`Bot ${loginData.user} - Starting retry logic for reason: ${reason}`);
        
        // For Steam Guard errors (false positives), retry with longer delay
        if (reason === 'steamguard') {
            winston.info(`Bot ${loginData.user} got false Steam Guard prompt, will retry with different proxy in 15 seconds`);
            
            // Try with a different proxy after delay
            if (this.proxyPoolManager) {
                const retryInfo = this.proxyPoolManager.handleLoginFailure(bot, error, reason);
                winston.debug(`Bot ${loginData.user} - Proxy pool manager returned: shouldRetry=${retryInfo.shouldRetry}, hasNewProxy=${!!retryInfo.newProxy}`);
                
                if (retryInfo.shouldRetry && retryInfo.newProxy) {
                    winston.info(`Bot ${loginData.user} - Scheduling retry #${retryInfo.retryCount} with proxy group ${retryInfo.newProxy.proxyGroupId} in 15 seconds`);
                    setTimeout(() => {
                        winston.info(`Retrying bot ${loginData.user} with proxy group ${retryInfo.newProxy.proxyGroupId} after Steam Guard error`);
                        bot.updateProxySettings(retryInfo.newProxy.proxyUrl);
                        bot.logIn(loginData.user, loginData.pass, loginData.auth);
                    }, 15000); // 15 second delay for Steam Guard errors
                    return;
                }
            }
            
            // Fallback: Don't retry if no proxy pool manager
            winston.error(`Bot ${loginData.user} - Cannot retry Steam Guard error without proxy pool manager`);
            return;
        }
        
        // Handle proxy errors and other retryable errors
        if (reason === 'proxy') {
            winston.info(`Bot ${loginData.user} got proxy error, attempting to retry with different proxy`);
        } else if (reason === 'ratelimit') {
            winston.info(`Bot ${loginData.user} hit rate limit, will retry after extended delay`);
        }
        
        if (!this.proxyPoolManager) {
            winston.error(`Bot ${loginData.user} - No proxy pool manager available for reassignment, cannot retry`);
            return;
        }
        
        // Check if we should retry with different proxy
        const retryInfo = this.proxyPoolManager.handleLoginFailure(bot, error, reason);
        winston.debug(`Bot ${loginData.user} - Proxy pool manager decision: shouldRetry=${retryInfo.shouldRetry}, retryCount=${retryInfo.retryCount || 0}`);
        
        if (!retryInfo.shouldRetry) {
            winston.error(`Bot ${loginData.user} will not be retried (exceeded max retries or no proxies available)`);
            // Mark account as failed and try a spare
            this.markAccountFailed(loginData.user, `Login failure after ${retryInfo.retryCount || 0} retries: ${reason}`);
            return;
        }
        
        // Calculate delay based on error type and retry count
        let delay = retryInfo.retryDelay;
        if (reason === 'ratelimit') {
            // Exponential backoff for rate limits: 30s, 60s, 120s
            delay = Math.min(30000 * Math.pow(2, retryInfo.retryCount - 1), 120000);
            winston.info(`Bot ${loginData.user} - Using extended delay of ${delay}ms for rate limit retry`);
        } else if (reason === 'proxy') {
            // Proxy errors: 10 seconds
            delay = 10000;
        }
        
        winston.info(`Bot ${loginData.user} - Scheduling retry #${retryInfo.retryCount} in ${delay}ms`);
        
        // Schedule retry
        setTimeout(() => {
            if (retryInfo.newProxy) {
                winston.info(`Retrying bot ${loginData.user} with proxy group ${retryInfo.newProxy.proxyGroupId} (success rate: ${(retryInfo.newProxy.successRate * 100).toFixed(1)}%)`);
                bot.updateProxySettings(retryInfo.newProxy.proxyUrl);
            } else {
                winston.info(`Retrying bot ${loginData.user} with same proxy (no alternative available)`);
            }
            
            // Retry login
            winston.debug(`Bot ${loginData.user} - Initiating login retry`);
            bot.logIn(loginData.user, loginData.pass, loginData.auth);
        }, delay);
    }

    lookupFloat(data) {
        let freeBot = this.getFreeBot();

        if (freeBot) {
            return freeBot.sendFloatRequest(data).finally(() => {
                // Release bot back to pool after request completes
                this.releaseBot(freeBot, true);
            });
        }
        else return Promise.reject(errors.NoBotsAvailable);
    }

    handleAuthRequired(bot, loginData, error, authType) {
        winston.warn(`Bot ${loginData.user} requires Steam Guard (${authType})`);
        
        // Store in pending auth queue
        this.pendingAuthBots.set(loginData.user, {
            bot: bot,
            loginData: loginData,
            authType: authType,
            timestamp: Date.now()
        });
        
        // Log summary of pending auth bots
        winston.info(`Currently ${this.pendingAuthBots.size} bots waiting for Steam Guard authentication`);
        
        // Emit event in case external system wants to handle this
        this.emit('botNeedsAuth', loginData.user, authType);
    }

    // Method to retry bot with provided Steam Guard code
    retryBotWithAuthCode(username, authCode) {
        const pendingBot = this.pendingAuthBots.get(username);
        
        if (!pendingBot) {
            winston.error(`No pending auth found for bot ${username}`);
            return false;
        }
        
        winston.info(`Retrying bot ${username} with provided Steam Guard code`);
        
        const { bot, loginData } = pendingBot;
        
        // Retry login with auth code
        bot.logIn(loginData.user, loginData.pass, loginData.auth, authCode);
        
        return true;
    }

    // Get list of bots waiting for Steam Guard
    getPendingAuthBots() {
        const result = [];
        for (const [username, data] of this.pendingAuthBots) {
            result.push({
                username: username,
                authType: data.authType,
                waitingTime: Date.now() - data.timestamp
            });
        }
        return result;
    }

    // Set maximum number of online bots
    setMaxOnlineBots(max) {
        this.maxOnlineBots = max;
        winston.info(`Max online bots set to ${max}`);
    }

    // Add spare accounts that can be used if bots fail
    setSpareAccounts(accounts) {
        this.spareAccounts = accounts;
        winston.info(`${accounts.length} spare accounts available`);
    }

    // Try to add a bot from spare accounts (queues it for staggered login)
    trySpareAccount() {
        if (this.spareAccounts.length === 0) {
            winston.warn('No spare accounts available');
            return false;
        }

        const readyCount = this.getReadyAmount();
        const queuedCount = this.spareAccountQueue.length;
        const projectedTotal = readyCount + queuedCount;
        
        if (projectedTotal >= this.maxOnlineBots) {
            winston.debug(`Already have ${readyCount}/${this.maxOnlineBots} bots online (${queuedCount} queued), not adding spare`);
            return false;
        }

        const spareAccount = this.spareAccounts.shift();
        winston.info(`Queuing spare account ${spareAccount.loginData.user} for staggered login (${this.spareAccounts.length} spares remaining)`);
        
        // Add to queue instead of immediately logging in
        this.spareAccountQueue.push(spareAccount);
        
        // Start processing queue if not already running
        if (!this.isProcessingSpareQueue) {
            this.processSpareAccountQueue();
        }
        
        return true;
    }

    // Mark an account as permanently failed
    markAccountFailed(username, reason) {
        this.failedAccounts.set(username, {
            reason: reason,
            timestamp: Date.now()
        });
        
        winston.error(`Account ${username} permanently failed: ${reason}`);
        winston.info(`Total failed accounts: ${this.failedAccounts.size}`);
        
        // Try to replace with a spare account
        this.trySpareAccount();
    }

    // Process spare account queue with staggered delays
    async processSpareAccountQueue() {
        if (this.isProcessingSpareQueue) {
            winston.debug('Spare account queue processor already running');
            return;
        }
        
        this.isProcessingSpareQueue = true;
        winston.info(`Starting to process spare account queue (${this.spareAccountQueue.length} accounts queued)`);
        
        while (this.spareAccountQueue.length > 0) {
            const readyCount = this.getReadyAmount();
            
            // Check if we still need more bots
            if (readyCount >= this.maxOnlineBots) {
                winston.info(`Target bot count reached (${readyCount}/${this.maxOnlineBots}), stopping spare queue processing`);
                this.spareAccountQueue = [];  // Clear remaining queue
                break;
            }
            
            const spareAccount = this.spareAccountQueue.shift();
            winston.info(`Processing spare account ${spareAccount.loginData.user} from queue (${this.spareAccountQueue.length} remaining)`);
            
            // Add the bot
            this.addBot(spareAccount.loginData, spareAccount.settings);
            
            // If using proxy pool, redistribute bots
            if (this.proxyPoolManager) {
                this.proxyPoolManager.distributeBots(this.bots);
            }
            
            // Wait before processing next account
            if (this.spareAccountQueue.length > 0) {
                winston.debug(`Waiting ${this.spareAccountDelay / 1000} seconds before next spare account...`);
                await new Promise(resolve => setTimeout(resolve, this.spareAccountDelay));
            }
        }
        
        winston.info('Finished processing spare account queue');
        this.isProcessingSpareQueue = false;
    }

    // Check if we should try spare accounts to maintain target online count
    checkAndMaintainBotCount() {
        const readyCount = this.getReadyAmount();
        const queuedCount = this.spareAccountQueue.length;
        const target = this.maxOnlineBots;
        
        if (readyCount + queuedCount < target && this.spareAccounts.length > 0) {
            const needed = Math.min(target - readyCount - queuedCount, this.spareAccounts.length);
            winston.info(`Currently ${readyCount}/${target} bots online (${queuedCount} queued), queuing ${needed} from spares`);
            
            for (let i = 0; i < needed; i++) {
                this.trySpareAccount();
            }
        }
    }

    // Get status of bot system
    getBotStatus() {
        const totalBots = this.bots.length;
        const readyBots = this.getReadyAmount();
        const busyBots = this.bots.filter(bot => bot.busy).length;
        const failedAccounts = this.failedAccounts.size;
        const sparesRemaining = this.spareAccounts.length;
        const pendingAuth = this.pendingAuthBots.size;
        const queuedSpares = this.spareAccountQueue.length;
        
        return {
            online: readyBots,
            target: this.maxOnlineBots,
            total: totalBots,
            busy: busyBots,
            failed: failedAccounts,
            spares: sparesRemaining,
            queuedSpares: queuedSpares,
            pendingAuth: pendingAuth,
            status: readyBots >= this.maxOnlineBots ? 'optimal' : 
                    (sparesRemaining > 0 || queuedSpares > 0) ? 'recovering' : 'degraded'
        };
    }
}

module.exports = BotController;
