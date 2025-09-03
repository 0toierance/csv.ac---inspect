const fs = require('fs');
const winston = global.winston || require('winston');
const EventEmitter = require('events').EventEmitter;

class ProxyGroup {
    constructor(proxyUrl, id) {
        this.id = id;
        this.proxyUrl = proxyUrl;
        this.bots = [];
        this.activeRequests = 0;
        this.totalRequests = 0;
        this.lastRequestTime = 0;
        this.failures = 0;
        this.loginFailures = 0;
        this.successfulLogins = 0;
    }

    addBot(bot) {
        bot.proxyGroupId = this.id;
        this.bots.push(bot);
    }

    removeBot(bot) {
        const index = this.bots.indexOf(bot);
        if (index > -1) {
            this.bots.splice(index, 1);
            return true;
        }
        return false;
    }

    recordLoginSuccess() {
        this.successfulLogins++;
    }

    recordLoginFailure() {
        this.loginFailures++;
    }

    getSuccessRate() {
        const total = this.successfulLogins + this.loginFailures;
        return total > 0 ? this.successfulLogins / total : 0;
    }

    canAcceptRequest(maxRequestsPerProxy, cooldownMs) {
        if (this.activeRequests >= maxRequestsPerProxy) {
            return false;
        }
        
        const now = Date.now();
        if (cooldownMs && (now - this.lastRequestTime) < cooldownMs) {
            return false;
        }
        
        return true;
    }

    getAvailableBot() {
        for (const bot of this.bots) {
            if (!bot.busy && bot.ready) {
                return bot;
            }
        }
        return null;
    }

    startRequest() {
        this.activeRequests++;
        this.totalRequests++;
        this.lastRequestTime = Date.now();
    }

    endRequest(success = true) {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        if (!success) {
            this.failures++;
        }
    }

    getStats() {
        return {
            id: this.id,
            proxy: this.proxyUrl.split('@')[1] || this.proxyUrl,
            bots: this.bots.length,
            activeRequests: this.activeRequests,
            totalRequests: this.totalRequests,
            failures: this.failures,
            available: this.bots.filter(b => !b.busy && b.ready).length
        };
    }
}

class ProxyPoolManager extends EventEmitter {
    constructor(proxiesFile, maxRequestsPerProxy = 3, requestCooldown = 100, retryConfig = {}) {
        super();
        this.proxiesFile = proxiesFile;
        this.maxRequestsPerProxy = maxRequestsPerProxy;
        this.requestCooldown = requestCooldown;
        this.proxyGroups = [];
        this.botToGroupMap = new Map();
        this.currentRoundRobinIndex = 0;
        
        // Retry configuration
        this.retryConfig = {
            enabled: retryConfig.retry_on_login_failure !== false,
            maxRetries: retryConfig.max_login_retries || 3,
            excludeFailed: retryConfig.exclude_failed_proxies !== false,
            retryDelay: retryConfig.login_retry_delay || 5000
        };
        
        this.botRetryCount = new Map();
        this.failedProxies = new Set();
        
        this.loadProxies();
    }

    loadProxies() {
        try {
            const proxiesContent = fs.readFileSync(this.proxiesFile, 'utf8');
            const proxies = proxiesContent.split('\n').filter(line => line.trim());
            
            winston.info(`Loaded ${proxies.length} proxies from ${this.proxiesFile}`);
            
            this.proxyGroups = proxies.map((proxy, index) => {
                return new ProxyGroup(proxy.trim(), index);
            });
            
        } catch (error) {
            winston.error(`Failed to load proxies from ${this.proxiesFile}: ${error.message}`);
            // Create a single "no proxy" group as fallback
            this.proxyGroups = [new ProxyGroup(null, 0)];
        }
    }

    distributeBots(bots) {
        if (this.proxyGroups.length === 0) {
            winston.error('No proxy groups available');
            return;
        }

        // Clear existing assignments
        this.proxyGroups.forEach(group => group.bots = []);
        this.botToGroupMap.clear();

        // Distribute bots across proxy groups
        const botsPerProxy = Math.ceil(bots.length / this.proxyGroups.length);
        
        let proxyIndex = 0;
        bots.forEach((bot, botIndex) => {
            const group = this.proxyGroups[proxyIndex];
            group.addBot(bot);
            this.botToGroupMap.set(bot, group);
            
            // Apply proxy to bot if available
            if (group.proxyUrl) {
                if (!bot.settings) {
                    bot.settings = {};
                }
                if (!bot.settings.steam_user) {
                    bot.settings.steam_user = {};
                }
                
                if (group.proxyUrl.startsWith('http://')) {
                    bot.settings.steam_user.httpProxy = group.proxyUrl;
                } else if (group.proxyUrl.startsWith('socks5://')) {
                    bot.settings.steam_user.socksProxy = group.proxyUrl;
                }
            }
            
            // Move to next proxy group if current one has enough bots
            if ((botIndex + 1) % botsPerProxy === 0 && proxyIndex < this.proxyGroups.length - 1) {
                proxyIndex++;
            }
        });

        // Log distribution
        winston.info(`Distributed ${bots.length} bots across ${this.proxyGroups.length} proxy groups`);
        this.proxyGroups.forEach(group => {
            winston.debug(`Proxy Group ${group.id}: ${group.bots.length} bots`);
        });
    }

    getAvailableBot(strategy = 'least_loaded') {
        let selectedGroup = null;
        let selectedBot = null;

        if (strategy === 'round_robin') {
            // Round-robin through proxy groups
            const startIndex = this.currentRoundRobinIndex;
            
            for (let i = 0; i < this.proxyGroups.length; i++) {
                const index = (startIndex + i) % this.proxyGroups.length;
                const group = this.proxyGroups[index];
                
                if (group.canAcceptRequest(this.maxRequestsPerProxy, this.requestCooldown)) {
                    const bot = group.getAvailableBot();
                    if (bot) {
                        selectedGroup = group;
                        selectedBot = bot;
                        this.currentRoundRobinIndex = (index + 1) % this.proxyGroups.length;
                        break;
                    }
                }
            }
        } else {
            // Least loaded strategy (default)
            let minLoad = Infinity;
            
            for (const group of this.proxyGroups) {
                if (group.canAcceptRequest(this.maxRequestsPerProxy, this.requestCooldown)) {
                    const load = group.activeRequests / Math.max(1, group.bots.length);
                    
                    if (load < minLoad) {
                        const bot = group.getAvailableBot();
                        if (bot) {
                            minLoad = load;
                            selectedGroup = group;
                            selectedBot = bot;
                        }
                    }
                }
            }
        }

        if (selectedGroup && selectedBot) {
            selectedGroup.startRequest();
            winston.debug(`Assigned bot from proxy group ${selectedGroup.id} (${selectedGroup.activeRequests}/${this.maxRequestsPerProxy} active)`);
            return selectedBot;
        }

        return null;
    }

    releaseBot(bot, success = true) {
        const group = this.botToGroupMap.get(bot);
        if (group) {
            group.endRequest(success);
            winston.debug(`Released bot from proxy group ${group.id} (${group.activeRequests}/${this.maxRequestsPerProxy} active)`);
        }
    }

    getMaxConcurrency() {
        return this.proxyGroups.length * this.maxRequestsPerProxy;
    }

    getReadyBotCount() {
        let count = 0;
        for (const group of this.proxyGroups) {
            count += group.bots.filter(b => b.ready).length;
        }
        return count;
    }

    getActiveConcurrency() {
        return this.proxyGroups.reduce((sum, group) => sum + group.activeRequests, 0);
    }

    getStats() {
        return {
            totalProxies: this.proxyGroups.length,
            maxRequestsPerProxy: this.maxRequestsPerProxy,
            maxConcurrency: this.getMaxConcurrency(),
            activeConcurrency: this.getActiveConcurrency(),
            readyBots: this.getReadyBotCount(),
            failedProxies: this.failedProxies.size,
            groups: this.proxyGroups.map(g => ({
                ...g.getStats(),
                loginFailures: g.loginFailures,
                successfulLogins: g.successfulLogins,
                successRate: (g.getSuccessRate() * 100).toFixed(1) + '%'
            }))
        };
    }

    // Check if we can accept more requests globally
    canAcceptMoreRequests() {
        return this.proxyGroups.some(group => 
            group.canAcceptRequest(this.maxRequestsPerProxy, this.requestCooldown) &&
            group.bots.some(b => !b.busy && b.ready)
        );
    }

    // Reassign bot to a different proxy group
    reassignBot(bot, excludeGroupIds = []) {
        const currentGroup = this.botToGroupMap.get(bot);
        
        // Remove from current group if exists
        if (currentGroup) {
            currentGroup.removeBot(bot);
            winston.debug(`Removed bot ${bot.user || bot.id} from proxy group ${currentGroup.id}`);
        }
        
        // Find new proxy group with capacity
        const availableGroups = this.proxyGroups.filter(group => {
            // Skip excluded groups
            if (excludeGroupIds.includes(group.id)) return false;
            // Skip failed proxies if configured
            if (this.retryConfig.excludeFailed && this.failedProxies.has(group.id)) return false;
            // Check capacity (prefer groups with < maxRequestsPerProxy bots)
            return group.bots.length < this.maxRequestsPerProxy;
        });
        
        if (availableGroups.length === 0) {
            winston.warn(`No available proxy groups for bot ${bot.user || bot.id} reassignment`);
            return null;
        }
        
        // Sort by success rate and current load
        availableGroups.sort((a, b) => {
            // Prefer higher success rate
            const successDiff = b.getSuccessRate() - a.getSuccessRate();
            if (Math.abs(successDiff) > 0.1) return successDiff > 0 ? 1 : -1;
            // Then prefer fewer bots
            return a.bots.length - b.bots.length;
        });
        
        const newGroup = availableGroups[0];
        newGroup.addBot(bot);
        this.botToGroupMap.set(bot, newGroup);
        
        // Apply proxy settings to bot
        if (newGroup.proxyUrl) {
            if (!bot.settings) bot.settings = {};
            if (!bot.settings.steam_user) bot.settings.steam_user = {};
            
            if (newGroup.proxyUrl.startsWith('http://')) {
                bot.settings.steam_user.httpProxy = newGroup.proxyUrl;
            } else if (newGroup.proxyUrl.startsWith('socks5://')) {
                bot.settings.steam_user.socksProxy = newGroup.proxyUrl;
            }
        }
        
        winston.info(`Reassigned bot ${bot.user || bot.id} to proxy group ${newGroup.id} (${newGroup.bots.length}/${this.maxRequestsPerProxy} bots)`);
        
        return {
            proxyGroupId: newGroup.id,
            proxyUrl: newGroup.proxyUrl,
            currentLoad: newGroup.bots.length,
            successRate: newGroup.getSuccessRate()
        };
    }

    // Handle bot login failure
    handleLoginFailure(bot, error, reason = 'unknown') {
        const group = this.botToGroupMap.get(bot);
        if (group) {
            group.recordLoginFailure();
            
            // Mark proxy as failed if too many failures
            if (group.loginFailures > 5 && group.getSuccessRate() < 0.3) {
                this.failedProxies.add(group.id);
                winston.warn(`Marked proxy group ${group.id} as failed (success rate: ${(group.getSuccessRate() * 100).toFixed(1)}%)`);
            }
        }
        
        // Check if we should retry
        if (!this.retryConfig.enabled) {
            return { shouldRetry: false };
        }
        
        // For Steam Guard errors (false positives), try different proxy
        if (reason === 'steamguard') {
            winston.info(`Bot ${bot.user || bot.id} got Steam Guard error, trying different proxy`);
            // Don't count this as a proxy failure since it's a Steam API issue
            // Just try a different proxy to get a fresh connection
            const retryCount = this.botRetryCount.get(bot) || 0;
            if (retryCount >= this.retryConfig.maxRetries) {
                winston.error(`Bot ${bot.user || bot.id} exceeded max retries even for Steam Guard`);
                return { shouldRetry: false };
            }
            
            this.botRetryCount.set(bot, retryCount + 1);
            
            // Get list of proxy groups to exclude (current one)
            const excludeGroups = group ? [group.id] : [];
            
            // Try reassigning to different proxy
            const reassignment = this.reassignBot(bot, excludeGroups);
            
            if (!reassignment) {
                winston.warn(`No alternative proxy for Steam Guard retry, will use same proxy`);
                return { shouldRetry: true, newProxy: null, retryDelay: 10000, retryCount: retryCount + 1 };
            }
            
            return {
                shouldRetry: true,
                newProxy: reassignment,
                retryDelay: 10000,  // 10 seconds for Steam Guard
                retryCount: retryCount + 1
            };
        }
        
        const retryCount = this.botRetryCount.get(bot) || 0;
        if (retryCount >= this.retryConfig.maxRetries) {
            winston.error(`Bot ${bot.user || bot.id} exceeded max login retries (${this.retryConfig.maxRetries})`);
            return { shouldRetry: false };
        }
        
        // Increment retry count
        this.botRetryCount.set(bot, retryCount + 1);
        
        // Get list of failed proxy groups to exclude
        const excludeGroups = group ? [group.id] : [];
        
        // Try reassigning to different proxy
        const reassignment = this.reassignBot(bot, excludeGroups);
        
        if (!reassignment) {
            winston.error(`No alternative proxy available for bot ${bot.user || bot.id}`);
            return { shouldRetry: false };
        }
        
        return {
            shouldRetry: true,
            newProxy: reassignment,
            retryDelay: this.retryConfig.retryDelay,
            retryCount: retryCount + 1
        };
    }

    // Record successful login
    handleLoginSuccess(bot) {
        const group = this.botToGroupMap.get(bot);
        if (group) {
            group.recordLoginSuccess();
        }
        
        // Clear retry count on success
        this.botRetryCount.delete(bot);
        
        winston.debug(`Bot ${bot.user || bot.id} successfully logged in via proxy group ${group ? group.id : 'unknown'}`);
    }
}

module.exports = ProxyPoolManager;