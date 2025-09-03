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

    // Try to add a bot from spare accounts
    trySpareAccount() {
        if (this.spareAccounts.length === 0) {
            winston.warn('No spare accounts available');
            return false;
        }

        const readyCount = this.getReadyAmount();
        if (readyCount >= this.maxOnlineBots) {
            winston.debug(`Already have ${readyCount}/${this.maxOnlineBots} bots online, not adding spare`);
            return false;
        }

        const spareAccount = this.spareAccounts.shift();
        winston.info(`Trying spare account ${spareAccount.loginData.user} (${this.spareAccounts.length} spares remaining)`);
        
        const bot = this.addBot(spareAccount.loginData, spareAccount.settings);
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

    // Check if we should try spare accounts to maintain target online count
    checkAndMaintainBotCount() {
        const readyCount = this.getReadyAmount();
        const target = this.maxOnlineBots;
        
        if (readyCount < target && this.spareAccounts.length > 0) {
            const needed = Math.min(target - readyCount, this.spareAccounts.length);
            winston.info(`Currently ${readyCount}/${target} bots online, attempting to add ${needed} from spares`);
            
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
        
        return {
            online: readyBots,
            target: this.maxOnlineBots,
            total: totalBots,
            busy: busyBots,
            failed: failedAccounts,
            spares: sparesRemaining,
            pendingAuth: pendingAuth,
            status: readyBots >= this.maxOnlineBots ? 'optimal' : 
                    sparesRemaining > 0 ? 'recovering' : 'degraded'
        };
    }
}

module.exports = BotController;
